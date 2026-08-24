"""Part-feed provider parsing + importer upsert behavior (no network)."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import event as sa_event

from app.models import Category, Part, PartListing, PriceBreak, Supplier, SupplierFeed
from app.services.part_feed.base import FeedPriceBreak
from app.services.part_feed.importer import (
    CONTINUOUS_CALL_CEILING,
    IMPORT_CURSOR_EXHAUSTED,
    _fill_part_media,
    backfill_images,
    category_cursor_key,
    fill_all_empty,
    fill_category,
    grow_catalog,
    resolve_single,
    sync_supplier_listings,
)
from app.services.part_feed.mouser import (
    _parse_availability,
    _parse_lead_time,
    _parse_price,
    part_from_mouser,
)
from tests.feed_helpers import FakeProvider as _FakeProvider
from tests.feed_helpers import feed_part as _feed_part

MOUSER_RAW = {
    "MouserPartNumber": "621-AOZ1282CI",
    "ManufacturerPartNumber": "AOZ1282CI",
    "Manufacturer": "Alpha & Omega Semiconductor",
    "Description": "3A 18V Synchronous EZBuck DFN-10",
    "ImagePath": "https://www.mouser.com/images/alphaomega/images/AOZ1282CI.jpg",
    "DataSheetUrl": "https://www.mouser.com/datasheet/2/aoz1282.pdf",
    "Availability": "12,345 In Stock",
    "LeadTime": "14 Days",
    "PriceBreaks": [
        {"Quantity": 1, "Price": "$0.52", "Currency": "USD"},
        {"Quantity": 100, "Price": "$0.44", "Currency": "USD"},
    ],
}


class TestMouserParsing:
    def test_full_part_maps(self):
        fp = part_from_mouser(MOUSER_RAW)
        assert fp is not None
        assert fp.mpn == "AOZ1282CI"
        assert fp.supplier_sku == "621-AOZ1282CI"
        assert fp.stock_quantity == 12345
        assert fp.lead_time_days == 14
        assert [(b.min_quantity, b.unit_price) for b in fp.price_breaks] == [
            (1, 0.52),
            (100, 0.44),
        ]

    def test_missing_mpn_or_manufacturer_is_dropped(self):
        assert part_from_mouser({**MOUSER_RAW, "ManufacturerPartNumber": ""}) is None
        assert part_from_mouser({**MOUSER_RAW, "Manufacturer": None}) is None

    def test_scalar_parsers(self):
        assert _parse_availability("12,345 In Stock") == 12345
        assert _parse_availability("None") == 0
        assert _parse_availability(None) == 0
        assert _parse_lead_time("14 Days") == 14
        assert _parse_lead_time(None) is None
        assert _parse_price("$0.52") == 0.52
        assert _parse_price("0,52 €") == 0.52
        assert _parse_price("1,234.56") == 1234.56
        assert _parse_price("") is None

    def test_price_thousands_separators(self):
        # a lone comma with 3 trailing digits is GROUPING, not a decimal —
        # the old parser read '1,234' as 1.234 (1000x low, review-caught)
        assert _parse_price("1,234") == 1234
        assert _parse_price("12,345") == 12345
        assert _parse_price("1.234,56 €") == 1234.56
        assert _parse_price("$1,234.56") == 1234.56
        assert _parse_price("0,5") == 0.5

    def test_http_error_never_contains_key(self):
        import httpx

        from app.services.part_feed.mouser import FeedFatalError, MouserProvider

        transport = httpx.MockTransport(lambda req: httpx.Response(401, json={}))
        provider = MouserProvider(
            api_key="SUPER-SECRET-KEY-1234", client=httpx.Client(transport=transport)
        )
        provider._throttle = lambda: None
        try:
            provider.search("resistor", 5)
            raise AssertionError("expected FeedFatalError")
        except FeedFatalError as e:
            assert "SUPER-SECRET-KEY-1234" not in str(e)
            assert "401" in str(e)


def _attach_listing(db, part, supplier, sku="EXIST-1"):
    """Give `part` a listing on `supplier` — the sync candidate condition."""
    listing = PartListing(
        id=uuid.uuid4(),
        part_id=part.id,
        supplier_id=supplier.id,
        sku=sku,
        stock_quantity=1,
        unit_price=Decimal("1.0000"),
    )
    db.add(listing)
    db.commit()
    return listing


class TestBackfillImages:
    def test_fills_only_valid_images_and_missing_datasheets(self, db, seeded_db):
        part = seeded_db["part1"]
        part.datasheet_url = None
        provider = _FakeProvider(by_mpn={part.sku: _feed_part(mpn=part.sku)})
        result = backfill_images(db, provider, limit=10)
        assert result["filled"] == 1
        assert part.image_url == "https://img.example/p.jpg"
        assert part.datasheet_url == "https://docs.example/d.pdf"

    def test_hostile_image_is_skipped_not_stored(self, db, seeded_db):
        part = seeded_db["part1"]
        provider = _FakeProvider(
            by_mpn={part.sku: _feed_part(mpn=part.sku, image="javascript:alert(1)")}
        )
        result = backfill_images(db, provider, limit=10)
        assert part.image_url is None
        assert result["filled"] == 0

    def test_datasheet_fills_even_without_an_image(self, db, seeded_db):
        """An imageless part with a real datasheet used to be refetched
        forever — datasheet now fills on its own merits."""
        part = seeded_db["part1"]
        part.datasheet_url = None
        provider = _FakeProvider(by_mpn={part.sku: _feed_part(mpn=part.sku, image=None)})
        backfill_images(db, provider, limit=10)
        assert part.image_url is None
        assert part.datasheet_url == "https://docs.example/d.pdf"

    def test_offset_skips_the_unfillable_head(self, db, seeded_db):
        part2 = seeded_db["part2"]
        provider = _FakeProvider(
            by_mpn={part2.sku: _feed_part(mpn=part2.sku, manufacturer=part2.manufacturer_name)}
        )
        # offset=1 skips part1 (sku-ordered first, unresolvable) entirely
        result = backfill_images(db, provider, limit=10, offset=1)
        assert result["scanned"] == 1


class TestFillCategory:
    def test_creates_part_listing_and_breaks_idempotently(self, db, seeded_db):
        child = seeded_db["child"]
        provider = _FakeProvider(search_results=[_feed_part()])

        r1 = fill_category(db, provider, child.slug)
        assert r1 == {"category": child.slug, "created": 1, "updated": 0, "skipped": 0}
        part = db.query(Part).filter(Part.sku == "FEED-001").one()
        assert part.category_id == child.id
        assert part.sub_slug == child.slug
        listing = db.query(PartListing).filter(PartListing.part_id == part.id).one()
        assert listing.stock_quantity == 500
        assert db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).count() == 2

        # second run updates in place — no duplicate rows
        r2 = fill_category(db, provider, child.slug)
        assert r2["created"] == 0 and r2["updated"] == 1
        assert db.query(Part).filter(Part.sku == "FEED-001").count() == 1
        assert db.query(PartListing).filter(PartListing.part_id == part.id).count() == 1
        assert db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).count() == 2
        assert db.query(Supplier).filter(Supplier.name == "Mouser Electronics").count() == 1

    def test_top_level_slug_is_rejected(self, db, seeded_db):
        provider = _FakeProvider()
        try:
            fill_category(db, provider, seeded_db["parent"].slug)
            raise AssertionError("expected ValueError for top-level slug")
        except ValueError as e:
            assert "subcategor" in str(e)

    def test_duplicate_mpn_in_one_page_yields_one_listing(self, db, seeded_db):
        """The reproduced critical: autoflush=False hid the pending listing,
        so a repeated MPN in one search page minted two (part, supplier)
        rows and split price breaks across them."""
        child = seeded_db["child"]
        first = _feed_part(mpn="DUP-1")
        second = _feed_part(mpn="DUP-1")
        second.price_breaks = [FeedPriceBreak(1, 0.11), FeedPriceBreak(10, 0.09)]
        provider = _FakeProvider(search_results=[first, second])

        fill_category(db, provider, child.slug)
        part = db.query(Part).filter(Part.sku == "DUP-1").one()
        listings = db.query(PartListing).filter(PartListing.part_id == part.id).all()
        assert len(listings) == 1
        breaks = db.query(PriceBreak).filter(PriceBreak.listing_id == listings[0].id).all()
        # first row wins; the repeat is skipped entirely
        assert sorted((b.min_quantity, float(b.unit_price)) for b in breaks) == [
            (1, 0.10),
            (100, 0.08),
        ]

    def test_part_in_another_category_is_not_hijacked(self, db, seeded_db):
        child = seeded_db["child"]
        part1 = seeded_db["part1"]  # lives in `child` already
        from app.models import Category

        other = Category(
            id=uuid.uuid4(),
            name="Other Sub",
            slug="other-sub",
            icon="⚙",
            parent_id=seeded_db["parent"].id,
            sort_order=8,
        )
        db.add(other)
        db.commit()
        provider = _FakeProvider(
            search_results=[_feed_part(mpn=part1.sku, manufacturer=part1.manufacturer_name)]
        )
        result = fill_category(db, provider, other.slug)
        assert result["skipped"] == 1 and result["created"] == 0
        db.refresh(part1)
        assert part1.category_id == child.id  # untouched

    def test_priceless_feed_part_creates_no_listing(self, db, seeded_db):
        child = seeded_db["child"]
        provider = _FakeProvider(search_results=[_feed_part(mpn="FEED-NP", breaks=False)])
        fill_category(db, provider, child.slug)
        part = db.query(Part).filter(Part.sku == "FEED-NP").one()
        assert db.query(PartListing).filter(PartListing.part_id == part.id).count() == 0
        assert part.id is not None  # part itself still lands

    def test_unknown_slug_raises(self, db, seeded_db):
        provider = _FakeProvider()
        try:
            fill_category(db, provider, "no-such-slug")
            raise AssertionError("expected ValueError")
        except ValueError as e:
            assert "no-such-slug" in str(e)


class TestFillAllEmpty:
    def test_fills_only_empty_children_and_survives_errors(self, db, seeded_db):
        from app.models import Category

        parent = seeded_db["parent"]
        # child (has part1/part2) must be SKIPPED; empty_cat must be filled
        empty_cat = Category(
            id=uuid.uuid4(),
            name="Empty Sub",
            slug="empty-sub",
            icon="⚙",
            parent_id=parent.id,
            sort_order=9,
        )
        db.add(empty_cat)
        db.commit()

        class _ExplodingOnSecond(_FakeProvider):
            calls = 0

            def search(self, keyword, limit=50):
                type(self).calls += 1
                if type(self).calls > 1:
                    raise RuntimeError("quota")
                return [_feed_part(mpn="FLEET-001")]

        provider = _ExplodingOnSecond()
        results = fill_all_empty(db, provider, per_category=5)
        by_cat = {r["category"]: r for r in results}
        assert "empty-sub" in by_cat
        assert seeded_db["child"].slug not in by_cat  # non-empty skipped
        assert db.query(Part).filter(Part.sku == "FLEET-001").count() == 1

    def test_aborts_on_fatal_provider_error(self, db, seeded_db):
        """Quota/auth failure hits every category identically — the run must
        stop at the FIRST one instead of burning a request per category."""
        from app.models import Category
        from app.services.part_feed.mouser import FeedFatalError

        parent = seeded_db["parent"]
        for n in ("Fatal A", "Fatal B", "Fatal C"):
            db.add(
                Category(
                    id=uuid.uuid4(),
                    name=n,
                    slug=n.lower().replace(" ", "-"),
                    icon="⚙",
                    parent_id=parent.id,
                    sort_order=20,
                )
            )
        db.commit()

        class _FatalProvider(_FakeProvider):
            calls = 0

            def search(self, keyword, limit=50):
                type(self).calls += 1
                raise FeedFatalError("Mouser API HTTP 429 on /search/keyword")

        provider = _FatalProvider()
        results = fill_all_empty(db, provider, per_category=5)
        assert _FatalProvider.calls == 1
        assert len(results) == 1
        assert results[0]["aborted"] is True


class TestFillPartMedia:
    """The extracted fill helper — image only-if-missing, datasheet on its own
    merits, both bounded by the String(500) columns they land in."""

    def _bare_part(self):
        return Part(id=uuid.uuid4(), sku="MEDIA-1", manufacturer_name="Feed Mfr")

    def test_fills_missing_media_and_reports_the_change(self):
        part = self._bare_part()
        assert _fill_part_media(part, _feed_part(mpn=part.sku)) is True
        assert part.image_url == "https://img.example/p.jpg"
        assert part.datasheet_url == "https://docs.example/d.pdf"
        # nothing left to fill — a second pass changes nothing
        assert _fill_part_media(part, _feed_part(mpn=part.sku)) is False

    def test_existing_values_are_never_overwritten(self):
        part = self._bare_part()
        part.image_url = "https://cdn.example/original.jpg"
        part.datasheet_url = "https://cdn.example/original.pdf"
        assert _fill_part_media(part, _feed_part(mpn=part.sku)) is False
        assert part.image_url == "https://cdn.example/original.jpg"
        assert part.datasheet_url == "https://cdn.example/original.pdf"

    def test_oversized_urls_are_rejected(self):
        # parts.image_url / datasheet_url are String(500) — a longer value
        # would be silently truncated by Postgres-side varchar limits.
        part = self._bare_part()
        fp = _feed_part(mpn=part.sku, image="https://img.example/" + "a" * 500 + ".jpg")
        fp.datasheet_url = "https://docs.example/" + "b" * 500 + ".pdf"
        assert _fill_part_media(part, fp) is False
        assert part.image_url is None
        assert part.datasheet_url is None

    def test_hostile_image_is_not_stored(self):
        part = self._bare_part()
        fp = _feed_part(mpn=part.sku, image="javascript:alert(1)")
        fp.datasheet_url = None
        assert _fill_part_media(part, fp) is False
        assert part.image_url is None


class TestSyncSupplierListings:
    def test_happy_stream_sequence_counts_and_per_part_commits(self, db, seeded_db):
        supplier = seeded_db["supplier1"]  # already carries listing1 -> part1
        part1, part2 = seeded_db["part1"], seeded_db["part2"]
        _attach_listing(db, part2, supplier)
        provider = _FakeProvider(
            by_mpn={
                part1.sku: _feed_part(mpn=part1.sku, manufacturer=part1.manufacturer_name),
                part2.sku: _feed_part(mpn=part2.sku, manufacturer=part2.manufacturer_name),
            }
        )
        commits: list[int] = []
        sa_event.listen(db, "after_commit", lambda s: commits.append(1))

        gen = sync_supplier_listings(db, provider, supplier, limit=10)
        started = next(gen)
        assert started == {
            "kind": "sync_started",
            "supplier_id": str(supplier.id),
            "title": "Avnet",
            "detail": "2 parts queued",
            "image_url": None,
            "action": None,
        }
        assert commits == []  # nothing written before the first part

        first = next(gen)
        # the per-part commit lands BEFORE the event reaches the client, so an
        # aborted stream never claims work it did not persist
        assert len(commits) == 1
        assert first["kind"] == "part_synced"
        assert first["supplier_id"] == str(supplier.id)
        assert first["action"] == "media_filled"
        assert first["title"] == f"{part1.sku} — {part1.manufacturer_name}"
        assert first["detail"] == "Clock and Timing"
        assert first["image_url"] == "https://img.example/p.jpg"
        assert "counts" not in first

        second = next(gen)
        assert len(commits) == 2
        assert second["title"] == f"{part2.sku} — {part2.manufacturer_name}"

        finished = next(gen)
        assert finished["kind"] == "sync_finished"
        assert finished["counts"] == {
            "synced": 2,
            "media_filled": 2,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }
        assert finished["title"] == "Avnet"
        with pytest.raises(StopIteration):
            next(gen)

    def test_listings_attach_to_the_clicked_supplier_row(self, db, seeded_db):
        """Identity rule: the sync writes to the row the admin clicked, even
        when its name differs from the provider's own supplier_name — matching
        by name would mint a twin supplier and split the catalog."""
        supplier = seeded_db["supplier1"]
        supplier.name = "Mouser"  # != provider.supplier_name
        db.commit()
        part1 = seeded_db["part1"]
        provider = _FakeProvider(
            by_mpn={part1.sku: _feed_part(mpn=part1.sku, manufacturer=part1.manufacturer_name)}
        )

        events = list(sync_supplier_listings(db, provider, supplier, limit=10))

        assert events[0]["title"] == "Mouser"
        assert db.query(Supplier).filter(Supplier.name == "Mouser Electronics").count() == 0
        assert db.query(Supplier).count() == 2  # no twin row
        listing = (
            db.query(PartListing)
            .filter(PartListing.part_id == part1.id, PartListing.supplier_id == supplier.id)
            .one()
        )
        assert listing.stock_quantity == 500
        assert listing.sku == f"621-{part1.sku}"

    def test_existing_media_kept_and_price_breaks_replaced(self, db, seeded_db):
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        part1.image_url = "https://cdn.example/original.jpg"
        part1.datasheet_url = "https://cdn.example/original.pdf"
        db.commit()
        listing = seeded_db["listing1"]
        assert db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).count() == 3
        provider = _FakeProvider(
            by_mpn={part1.sku: _feed_part(mpn=part1.sku, manufacturer=part1.manufacturer_name)}
        )

        events = list(sync_supplier_listings(db, provider, supplier, limit=10))

        synced = [e for e in events if e["kind"] == "part_synced"]
        assert [e["action"] for e in synced] == ["updated"]
        assert synced[0]["image_url"] == "https://cdn.example/original.jpg"
        db.refresh(part1)
        assert part1.image_url == "https://cdn.example/original.jpg"
        assert part1.datasheet_url == "https://cdn.example/original.pdf"
        breaks = db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).all()
        assert sorted((b.min_quantity, float(b.unit_price)) for b in breaks) == [
            (1, 0.10),
            (100, 0.08),
        ]
        assert events[-1]["counts"] == {
            "synced": 1,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }

    def test_unresolvable_part_reports_not_found(self, db, seeded_db):
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        provider = _FakeProvider()  # resolves nothing

        events = list(sync_supplier_listings(db, provider, supplier, limit=10))

        miss = events[1]
        assert miss["kind"] == "part_synced"
        assert miss["action"] == "not_found"
        assert miss["title"] == part1.sku
        assert miss["detail"] == "Clock and Timing"
        assert miss["image_url"] is None
        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 1,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }

    def test_priceless_feed_part_reports_no_data(self, db, seeded_db):
        """A hit with no price breaks writes NOTHING (`_upsert_listing` bails —
        a listing without a price is not a comparison row) and the part's media
        is already there, so the honest action is `no_data`, not `updated`."""
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        part1.image_url = "https://cdn.example/original.jpg"
        part1.datasheet_url = "https://cdn.example/original.pdf"
        # The fake feed row carries lead_time_days=7 — a stampable part-level
        # fact since migration 039. Pre-store it so this run truly has nothing
        # new to write (that is what no_data means).
        part1.lead_time_days = 7
        db.commit()
        listing = seeded_db["listing1"]
        before = (
            listing.sku,
            listing.stock_quantity,
            listing.lead_time_days,
            listing.unit_price,
        )
        provider = _FakeProvider(by_mpn={part1.sku: _feed_part(mpn=part1.sku, breaks=False)})

        events = list(sync_supplier_listings(db, provider, supplier, limit=10))

        synced = [e for e in events if e["kind"] == "part_synced"]
        assert [e["action"] for e in synced] == ["no_data"]
        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 1,
            "created": 0,
            "listing_added": 0,
        }
        assert events[-1]["detail"].endswith("· 1 no data")
        db.refresh(listing)
        assert (
            listing.sku,
            listing.stock_quantity,
            listing.lead_time_days,
            listing.unit_price,
        ) == before

    def test_priceless_hit_that_fills_media_still_counts_as_synced(self, db, seeded_db):
        """Media IS a real write — only a hit that changed nothing is no_data."""
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        provider = _FakeProvider(by_mpn={part1.sku: _feed_part(mpn=part1.sku, breaks=False)})

        events = list(sync_supplier_listings(db, provider, supplier, limit=10))

        assert [e["action"] for e in events if e["kind"] == "part_synced"] == ["media_filled"]
        assert events[-1]["counts"] == {
            "synced": 1,
            "media_filled": 1,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }
        assert "no data" not in events[-1]["detail"]

    def test_supplier_with_no_listings_streams_an_empty_run(self, db, seeded_db):
        empty = Supplier(id=uuid.uuid4(), name="No Listings Co", website="nolistings.example")
        db.add(empty)
        db.commit()

        events = list(sync_supplier_listings(db, _FakeProvider(), empty, limit=10))

        assert [e["kind"] for e in events] == ["sync_started", "sync_finished"]
        assert events[0]["detail"] == "0 parts queued"
        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }
        assert events[-1]["detail"] == "0 synced · 0 images filled · 0 not found"

    def test_only_this_suppliers_parts_are_candidates(self, db, seeded_db):
        """part2 has no listing on supplier1 — it must not be swept in."""
        supplier = seeded_db["supplier1"]
        provider = _FakeProvider(
            by_mpn={
                seeded_db["part1"].sku: _feed_part(
                    mpn=seeded_db["part1"].sku,
                    manufacturer=seeded_db["part1"].manufacturer_name,
                ),
                seeded_db["part2"].sku: _feed_part(
                    mpn=seeded_db["part2"].sku,
                    manufacturer=seeded_db["part2"].manufacturer_name,
                ),
            }
        )
        events = list(sync_supplier_listings(db, provider, supplier, limit=10))
        assert events[0]["detail"] == "1 parts queued"
        titles = [e["title"] for e in events if e["kind"] == "part_synced"]
        assert titles == [f"{seeded_db['part1'].sku} — {seeded_db['part1'].manufacturer_name}"]

    def test_limit_prefers_parts_missing_an_image(self, db, seeded_db):
        supplier = seeded_db["supplier1"]
        part1, part2 = seeded_db["part1"], seeded_db["part2"]
        part1.image_url = "https://cdn.example/have-one.jpg"  # sku-first, but filled
        _attach_listing(db, part2, supplier)
        db.commit()
        provider = _FakeProvider(
            by_mpn={
                part1.sku: _feed_part(mpn=part1.sku, manufacturer=part1.manufacturer_name),
                part2.sku: _feed_part(mpn=part2.sku, manufacturer=part2.manufacturer_name),
            }
        )
        events = list(sync_supplier_listings(db, provider, supplier, limit=1))
        assert events[0]["detail"] == "1 parts queued"
        assert [e["title"] for e in events if e["kind"] == "part_synced"] == [
            f"{part2.sku} — {part2.manufacturer_name}"
        ]

    def test_fatal_error_ends_the_stream_without_raising(self, db, seeded_db):
        from app.services.part_feed.mouser import FeedFatalError

        supplier = seeded_db["supplier1"]
        part1, part2 = seeded_db["part1"], seeded_db["part2"]
        _attach_listing(db, part2, supplier)
        feed = {part1.sku: _feed_part(mpn=part1.sku, manufacturer=part1.manufacturer_name)}

        class _FatalOnSecond(_FakeProvider):
            def __init__(self):
                super().__init__(by_mpn=feed)
                self.calls = 0

            def lookup_mpn(self, mpn):
                self.calls += 1
                if self.calls > 1:
                    raise FeedFatalError("Mouser API HTTP 429 on /search/partnumber")
                return super().lookup_mpn(mpn)

        events = list(sync_supplier_listings(db, _FatalOnSecond(), supplier, limit=10))

        assert [e["kind"] for e in events] == [
            "sync_started",
            "part_synced",
            "sync_error",
            "sync_finished",
        ]
        err = events[2]
        assert err["title"] == "Feed unavailable"
        assert "429" in err["detail"]
        assert err["image_url"] is None
        assert events[-1]["counts"] == {
            "synced": 1,
            "media_filled": 1,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }
        # the first part's work survived the abort's rollback
        listing = (
            db.query(PartListing)
            .filter(PartListing.part_id == part1.id, PartListing.supplier_id == supplier.id)
            .one()
        )
        assert listing.stock_quantity == 500
        assert db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).count() == 2


class TestProviderCallAccounting:
    """`calls_made` is the currency the import budget spends — it has to
    count what the API actually charged for, pages included."""

    def _provider(self, handler):
        import httpx

        from app.services.part_feed.mouser import MouserProvider

        provider = MouserProvider(
            api_key="SUPER-SECRET-KEY-1234",
            client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        provider._throttle = lambda: None
        return provider

    def test_search_costs_one_call_per_page(self):
        import json

        import httpx

        def handler(request):
            body = json.loads(request.content)["SearchByKeywordRequest"]
            parts = [
                {
                    "ManufacturerPartNumber": f"MPN-{body['startingRecord'] + i}",
                    "Manufacturer": "Feed Mfr",
                    "PriceBreaks": [],
                }
                for i in range(body["records"])
            ]
            return httpx.Response(200, json={"SearchResults": {"Parts": parts}})

        provider = self._provider(handler)
        assert provider.calls_made == 0

        out = provider.search("resistor", 120)

        assert len(out) == 120
        assert provider.calls_made == 3  # ceil(120 / 50 records per call)

    def test_unparseable_rows_never_buy_an_extra_page(self):
        """The page loop measures PARSED parts, so a page whose rows partly
        fail to decode (no manufacturer) left `len(out) < limit` and fired
        another page — a caller who budgeted ONE call silently spending two.
        The cap is on pages, not on parts kept."""
        import httpx

        pages: list[int] = []

        def handler(request):
            pages.append(1)
            parts = [
                {
                    "ManufacturerPartNumber": f"MPN-{i}",
                    # every third row is undecodable and gets dropped
                    "Manufacturer": "" if i % 3 == 0 else "Feed Mfr",
                    "PriceBreaks": [],
                }
                for i in range(50)
            ]
            return httpx.Response(200, json={"SearchResults": {"Parts": parts}})

        provider = self._provider(handler)

        out = provider.search("resistor", 50)

        assert len(pages) == 1
        assert provider.calls_made == 1
        assert 0 < len(out) < 50  # an honest short page, not a second call

    def test_a_rejected_call_still_counts_against_the_budget(self):
        """The quota is spent when the request leaves, not when it succeeds —
        counting only successes would let a failing key loop forever."""
        import httpx

        from app.services.part_feed.mouser import FeedFatalError

        provider = self._provider(lambda req: httpx.Response(429, json={}))
        with pytest.raises(FeedFatalError):
            provider.search("resistor", 5)
        assert provider.calls_made == 1

    def test_lookup_counts_one_call(self):
        import httpx

        provider = self._provider(
            lambda req: httpx.Response(200, json={"SearchResults": {"Parts": []}})
        )
        assert provider.lookup_mpn("LM7805CT") is None
        assert provider.calls_made == 1

    def test_start_at_becomes_the_starting_record(self):
        """Depth is the whole point of the import cursor: without a
        `startingRecord` every run re-reads page one and finds nothing new."""
        import json

        import httpx

        seen: list[int] = []

        def handler(request):
            body = json.loads(request.content)["SearchByKeywordRequest"]
            seen.append(body["startingRecord"])
            parts = [
                {
                    "ManufacturerPartNumber": f"MPN-{body['startingRecord'] + i}",
                    "Manufacturer": "Feed Mfr",
                    "PriceBreaks": [],
                }
                for i in range(body["records"])
            ]
            return httpx.Response(200, json={"SearchResults": {"Parts": parts}})

        provider = self._provider(handler)

        out = provider.search("resistor", 120, start_at=200)

        # paging RESUMES at the offset, and the cap is still ceil(limit/page)
        assert seen == [200, 250, 300]
        assert provider.calls_made == 3
        assert out[0].mpn == "MPN-200"
        assert provider.last_raw_count == 120

    def test_last_raw_count_reports_rows_RETURNED_not_rows_kept(self):
        """The cursor advances by RAW rows. Advancing by the PARSED ones would
        park the next run back on top of the undecodable rows, forever."""
        import httpx

        def handler(request):
            parts = [
                {
                    "ManufacturerPartNumber": f"MPN-{i}",
                    # every third row is undecodable and gets dropped
                    "Manufacturer": "" if i % 3 == 0 else "Feed Mfr",
                    "PriceBreaks": [],
                }
                for i in range(50)
            ]
            return httpx.Response(200, json={"SearchResults": {"Parts": parts}})

        provider = self._provider(handler)

        out = provider.search("resistor", 50)

        assert provider.last_raw_count == 50
        assert len(out) < 50

    def test_last_raw_count_belongs_to_the_LAST_search(self):
        """It is per-search state, not a running total — a stale value would
        make an empty category look like a full page and never exhaust."""
        import httpx

        responses = [
            httpx.Response(
                200,
                json={
                    "SearchResults": {
                        "Parts": [
                            {
                                "ManufacturerPartNumber": "MPN-1",
                                "Manufacturer": "Feed Mfr",
                                "PriceBreaks": [],
                            }
                        ]
                    }
                },
            ),
            httpx.Response(200, json={"SearchResults": {"Parts": []}}),
        ]
        provider = self._provider(lambda request: responses.pop(0))

        provider.search("resistor", 50)
        assert provider.last_raw_count == 1

        provider.search("capacitor", 50)
        assert provider.last_raw_count == 0


def _subcategory(db, name, slug, parent, parts=0):
    """A child category holding `parts` throwaway parts — the sweep order is
    by part count, so the fixture has to be able to make one fatter."""
    cat = Category(
        id=uuid.uuid4(),
        name=name,
        slug=slug,
        icon="cpu",
        parent_id=parent.id,
        sort_order=0,
    )
    db.add(cat)
    db.flush()
    for i in range(parts):
        db.add(
            Part(
                id=uuid.uuid4(),
                sku=f"{slug.upper()}-FILLER-{i}",
                description="filler",
                manufacturer_name="Filler Co",
                category_id=cat.id,
            )
        )
    db.commit()
    return cat


class TestAnUnidentifiableRowIsSkippedNotFatal:
    """A feed row with no usable manufacturer is one bad row, not a bad run.

    `get_or_create_part` raises ValueError when the maker string canonicalises
    to nothing, because a part with no manufacturer cannot be keyed. Nothing
    caught it: in a sweep the ValueError escaped the generator and the nightly
    job's blanket handler abandoned every remaining category for that supplier,
    and in `/api/bom/resolve` — which only catches FeedFatalError — it broke an
    anonymous visitor's NDJSON stream mid-flight. Before the identity work such
    a row simply became a part with an empty manufacturer_name.
    """

    def test_a_blank_manufacturer_does_not_abort_the_sweep(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={
                "Voltage References": [
                    _feed_part("GOOD-1"),
                    _feed_part("BAD-1", manufacturer="   "),
                    _feed_part("GOOD-2"),
                ]
            }
        )

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        kinds = [e["kind"] for e in events]
        assert kinds[-1] == "sync_finished", "the sweep ended early on one bad row"
        assert "sync_error" not in kinds
        skus = {e.get("title") for e in events}
        assert any("GOOD-2" in (s or "") for s in skus), (
            "the row AFTER the unidentifiable one never ran — the sweep aborted"
        )

    def test_a_blank_manufacturer_resolves_to_nothing_rather_than_raising(self, db, seeded_db):
        """The public BOM path: no part, no exception, stream intact."""
        supplier = seeded_db["supplier1"]
        provider = _FakeProvider(by_mpn={"BAD-2": _feed_part("BAD-2", manufacturer="")})

        assert resolve_single(db, provider, supplier, "BAD-2", "BAD-2") is None


class TestImportDoesNotDoSyncsJob:
    """ "Import New Parts" must not refresh listings this supplier already has.

    Owner-reported: "pressing Import New Parts will often times sync old items
    instead of creating new ones. If I wanted to have parts get synced also, I
    would have clicked Sync Inventory."

    They were right. A keyword page returns whatever the distributor ranks
    highest for the shelf, which is increasingly parts we already hold as a
    category fills up — and for every one of those `grow_catalog` ran
    `_upsert_listing`, `_fill_part_media` and `_stamp_feed_facts`, which IS
    what sync does. So an import spent its rate-limited calls redoing sync's
    work and reported it as `updated`.

    The two buttons partition cleanly on ONE question: does this supplier
    already list this part? `sync_supplier_listings` selects exactly the parts
    where it does (an EXISTS on part_listings), so import takes exactly the
    complement. Nothing falls between them, and nothing is done twice.
    """

    def _held_part(self, db, seeded_db, supplier, sku="HELD-1", price="4.00"):
        """A part this supplier already lists — sync's territory."""
        part = Part(
            id=uuid.uuid4(),
            sku=sku,
            slug=sku.lower(),
            manufacturer_name="Feed Mfr",
        )
        db.add(part)
        db.flush()
        db.add(
            PartListing(
                id=uuid.uuid4(),
                part_id=part.id,
                supplier_id=supplier.id,
                unit_price=Decimal(price),
                stock_quantity=7,
            )
        )
        db.commit()
        return part

    def _shelf(self, db, parent):
        return _subcategory(db, "Voltage References", "voltage-references", parent)

    def test_a_part_this_supplier_already_lists_is_left_untouched(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        shelf = self._shelf(db, parent)
        part = self._held_part(db, seeded_db, supplier)
        part.category_id = shelf.id
        db.commit()
        listing = db.query(PartListing).filter_by(part_id=part.id).one()
        before_price, before_stock = listing.unit_price, listing.stock_quantity

        provider = _FakeProvider(results_by_keyword={"Voltage References": [_feed_part("HELD-1")]})
        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        db.expire_all()
        refreshed = db.query(PartListing).filter_by(part_id=part.id).one()
        assert refreshed.unit_price == before_price, (
            "import rewrote the price of a listing this supplier already had — "
            "that is Sync Inventory's job, not Import New Parts'"
        )
        assert refreshed.stock_quantity == before_stock
        assert [e["action"] for e in events if e["kind"] == "part_synced"] == []

    def test_the_skip_is_reported_so_the_operator_can_see_why(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        shelf = self._shelf(db, parent)
        part = self._held_part(db, seeded_db, supplier)
        part.category_id = shelf.id
        db.commit()

        provider = _FakeProvider(results_by_keyword={"Voltage References": [_feed_part("HELD-1")]})
        finished = list(grow_catalog(db, provider, supplier, call_budget=1))[-1]

        assert "already listed" in finished["detail"], (
            f"a silently-skipped page looks like a dead import: {finished['detail']!r}"
        )

    def test_a_genuinely_new_part_is_still_created(self, db, seeded_db):
        """The fix must not turn Import into a no-op."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        self._shelf(db, parent)
        provider = _FakeProvider(
            results_by_keyword={"Voltage References": [_feed_part("BRAND-NEW-1")]}
        )

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        assert [e["action"] for e in events if e["kind"] == "part_synced"] == ["created"]
        assert db.query(Part).filter(Part.sku == "BRAND-NEW-1").count() == 1

    def test_a_part_we_hold_that_this_supplier_does_not_list_gains_a_listing(self, db, seeded_db):
        """The case that must NOT be skipped — and that sync can never reach.

        `sync_supplier_listings` filters on an EXISTS over this supplier's
        listings, so a part we hold from a DIFFERENT distributor is invisible
        to it. Adding this supplier's offer is new inventory, and it is the
        entire point of a second distributor: one part, two prices.
        """
        supplier, other, parent = (
            seeded_db["supplier1"],
            seeded_db["supplier2"],
            seeded_db["parent"],
        )
        shelf = self._shelf(db, parent)
        part = self._held_part(db, seeded_db, other, sku="RIVAL-1")
        part.category_id = shelf.id
        db.commit()

        provider = _FakeProvider(results_by_keyword={"Voltage References": [_feed_part("RIVAL-1")]})
        list(grow_catalog(db, provider, supplier, call_budget=1))

        db.expire_all()
        listings = db.query(PartListing).filter_by(part_id=part.id).all()
        assert {row.supplier_id for row in listings} == {other.id, supplier.id}, (
            "import refused to add a second distributor's offer to a part we "
            "already hold — that is the one thing this whole project is for"
        )

    def test_a_first_listing_reads_as_added_not_updated(self, db, seeded_db):
        """A distributor's FIRST offer on a part is new inventory, not a refresh.

        45,000 parts have no Mouser listing, so this is the common case, not an
        edge one. It used to report `updated` and tick `synced` — which reads
        as "Import is syncing again" even though nothing was refreshed. Since
        import no longer touches an existing listing at all, every listing it
        writes is by definition a new one, and can say so.
        """
        supplier, other, parent = (
            seeded_db["supplier1"],
            seeded_db["supplier2"],
            seeded_db["parent"],
        )
        shelf = self._shelf(db, parent)
        part = self._held_part(db, seeded_db, other, sku="FIRST-1")
        part.category_id = shelf.id
        db.commit()

        provider = _FakeProvider(results_by_keyword={"Voltage References": [_feed_part("FIRST-1")]})
        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        assert [e["action"] for e in events if e["kind"] == "part_synced"] == ["listing_added"]
        assert events[-1]["counts"]["listing_added"] == 1

    def test_an_import_never_increments_synced(self, db, seeded_db):
        """The signal the owner actually asked for.

        "If I wanted to have parts get synced also, I would have clicked Sync
        Inventory." So `synced` moving during an import now means something is
        wrong, and that is worth being able to assert in one line.
        """
        supplier, other, parent = (
            seeded_db["supplier1"],
            seeded_db["supplier2"],
            seeded_db["parent"],
        )
        shelf = self._shelf(db, parent)
        held = self._held_part(db, seeded_db, supplier, sku="MINE-1")
        rival = self._held_part(db, seeded_db, other, sku="THEIRS-1")
        held.category_id = rival.category_id = shelf.id
        db.commit()

        provider = _FakeProvider(
            results_by_keyword={
                "Voltage References": [
                    _feed_part("MINE-1"),
                    _feed_part("THEIRS-1"),
                    _feed_part("FRESH-1"),
                ]
            }
        )
        # Budget for several categories: seeding two parts into this shelf makes
        # it less thin, and `_thinnest_subcategories` would otherwise spend the
        # single call somewhere emptier.
        events = list(grow_catalog(db, provider, supplier, call_budget=10))

        counts = events[-1]["counts"]
        assert counts["synced"] == 0, (
            f"an import reported {counts['synced']} synced — import must never do sync's work"
        )
        assert counts["created"] == 1
        assert counts["listing_added"] == 1


class TestGrowCatalog:
    def test_new_mpns_become_parts_listings_and_breaks(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        thin = _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={"Voltage References": [_feed_part("NEW-1"), _feed_part("NEW-2")]}
        )

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        assert [e["kind"] for e in events] == [
            "sync_started",
            "part_synced",
            "part_synced",
            "sync_finished",
        ]
        assert events[0] == {
            "kind": "sync_started",
            "supplier_id": str(supplier.id),
            "title": "Avnet",
            "detail": "growing catalog · budget 1 calls · 2 categories to sweep",
            "image_url": None,
            "action": None,
        }
        assert [e["action"] for e in events[1:3]] == ["created", "created"]
        assert events[1]["title"] == "NEW-1 — Feed Mfr"
        assert events[1]["detail"] == "Voltage References"
        assert events[1]["image_url"] == "https://img.example/p.jpg"

        part = db.query(Part).filter(Part.sku == "NEW-1").one()
        assert (part.slug, part.sub_slug, part.category_id) == (
            "new-1",
            "voltage-references",
            thin.id,
        )
        assert part.image_url == "https://img.example/p.jpg"
        assert part.datasheet_url == "https://docs.example/d.pdf"
        listing = (
            db.query(PartListing)
            .filter(PartListing.part_id == part.id, PartListing.supplier_id == supplier.id)
            .one()
        )
        assert listing.stock_quantity == 500
        assert db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).count() == 2
        # identity rule: the clicked row, never a twin named after the provider
        assert db.query(Supplier).count() == 2

        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 2,
            "listing_added": 0,
        }
        assert events[-1]["detail"] == (
            "2 created · 0 listings added · 0 already listed · 0 already elsewhere · 1 calls used"
        )

    def test_each_part_commits_before_its_event(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={"Voltage References": [_feed_part("NEW-1"), _feed_part("NEW-2")]}
        )
        commits: list[int] = []
        sa_event.listen(db, "after_commit", lambda s: commits.append(1))

        gen = grow_catalog(db, provider, supplier, call_budget=1)
        next(gen)
        assert commits == []  # nothing written before the first part
        next(gen)
        assert len(commits) == 1
        next(gen)
        assert len(commits) == 2

    def test_an_already_listed_part_is_left_alone_not_duplicated(self, db, seeded_db):
        """Two guarantees, and only one of them used to hold.

        NOT DUPLICATED is the original point of this test and still matters —
        the sweep must recognise a part it already has rather than forking the
        catalog. NOT REFRESHED is new: this used to report `media_filled` and
        write the listing, which is Sync Inventory's job. `part1` carries a
        `supplier1` listing in the fixture, so it is squarely sync's territory.
        """
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        before = db.query(Part).count()
        provider = _FakeProvider(
            results_by_keyword={
                "Clock and Timing": [_feed_part(part1.sku, manufacturer=part1.manufacturer_name)]
            }
        )

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        assert [e["action"] for e in events if e["kind"] == "part_synced"] == []
        assert db.query(Part).count() == before
        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }
        assert events[-1]["detail"].startswith("0 created · 0 listings added · 1 already listed")

    def test_a_hit_that_writes_nothing_reports_no_data(self, db, seeded_db):
        """Same honesty rail as the sync: found, but nothing changed — calling
        that `updated` would overstate what the run did."""
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        # NOT part1 itself: `supplier1` already lists it, so import now declines
        # it as sync's territory and never reaches the no_data rail. `no_data`
        # is still reachable — and still worth pinning — for a part this
        # supplier does not list, where the feed row carries no price.
        unlisted = Part(
            id=uuid.uuid4(),
            sku="NODATA-1",
            slug="nodata-1",
            manufacturer_name=part1.manufacturer_name,
            category_id=part1.category_id,
            sub_slug=part1.sub_slug,
            image_url="https://cdn.example/original.jpg",
            datasheet_url="https://cdn.example/original.pdf",
            # The fake feed row carries lead_time_days=7 — a stampable
            # part-level fact since migration 039. Pre-store it so this run
            # truly has nothing new to write (that is what no_data means).
            lead_time_days=7,
        )
        db.add(unlisted)
        db.commit()
        provider = _FakeProvider(
            results_by_keyword={
                "Clock and Timing": [
                    _feed_part("NODATA-1", manufacturer=part1.manufacturer_name, breaks=False)
                ]
            }
        )

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        assert [e["action"] for e in events if e["kind"] == "part_synced"] == ["no_data"]
        assert events[-1]["counts"]["no_data"] == 1
        assert events[-1]["counts"]["synced"] == 0

    def test_an_mpn_living_elsewhere_is_skipped_with_no_event(self, db, seeded_db):
        """No-hijack: the part stays in its category, and a skip a human
        cannot act on never reaches the console — only the finish line."""
        supplier, parent, part1 = (
            seeded_db["supplier1"],
            seeded_db["parent"],
            seeded_db["part1"],
        )
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={
                "Voltage References": [_feed_part(part1.sku, manufacturer=part1.manufacturer_name)]
            }
        )
        before = db.query(Part).count()

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        assert [e["kind"] for e in events] == ["sync_started", "sync_finished"]
        assert db.query(Part).count() == before
        db.refresh(part1)
        assert part1.category_id == seeded_db["child"].id
        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }
        assert events[-1]["detail"] == (
            "0 created · 0 listings added · 0 already listed · 1 already elsewhere · 1 calls used"
        )

    def test_thinnest_subcategories_are_swept_first(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Zener Diodes", "zener-diodes", parent)
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        _subcategory(db, "Sensor ICs", "sensor-ics", parent, parts=1)

        provider = _FakeProvider()
        list(grow_catalog(db, provider, supplier, call_budget=4))

        # 0 parts (name-tiebroken), then 1, then the seeded child's 2
        assert [kw for kw, _, _ in provider.search_calls] == [
            "Amplifiers",
            "Zener Diodes",
            "Sensor ICs",
            "Clock and Timing",
        ]

    def test_the_budget_stops_the_sweep_mid_order(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Zener Diodes", "zener-diodes", parent)
        _subcategory(db, "Amplifiers", "amplifiers", parent)

        provider = _FakeProvider()
        events = list(grow_catalog(db, provider, supplier, call_budget=2))

        assert [kw for kw, _, _ in provider.search_calls] == ["Amplifiers", "Zener Diodes"]
        assert provider.calls_made == 2
        assert events[-1]["detail"].endswith("· 2 calls used")

    def test_zero_budget_spends_nothing(self, db, seeded_db):
        provider = _FakeProvider()

        events = list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=0))

        assert [e["kind"] for e in events] == ["sync_started", "sync_finished"]
        assert provider.search_calls == []
        assert events[-1]["detail"].endswith("· 0 calls used")

    def test_the_page_it_asks_for_never_outruns_the_budget(self, db, seeded_db):
        """A search of N records costs ceil(N/page) calls and paginates INSIDE
        the provider — so the size asked for is the only place the budget can
        bound pages."""
        provider = _FakeProvider()

        list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=1, per_category=200))

        assert provider.search_calls == [("Clock and Timing", 50, 0)]

    def test_a_category_wider_than_one_page_costs_more_than_one_call(self, db, seeded_db):
        """`per_category` above a page is a REAL multi-call ask — the budget
        has to be charged for the pages, not for the categories, or a nightly
        run would overspend its quota by the page factor."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        provider = _FakeProvider()

        events = list(grow_catalog(db, provider, supplier, call_budget=2, per_category=100))

        # one category, two pages — and the sweep stops there
        assert provider.search_calls == [("Amplifiers", 100, 0)]
        assert provider.calls_made == 2
        assert events[-1]["detail"].endswith("· 2 calls used")

    def test_a_repeated_mpn_in_one_page_creates_one_part(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={"Voltage References": [_feed_part("NEW-1"), _feed_part("new-1")]}
        )

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        assert [e["action"] for e in events if e["kind"] == "part_synced"] == ["created"]
        assert db.query(Part).filter(Part.sku.in_(["NEW-1", "new-1"])).count() == 1
        assert events[-1]["counts"]["created"] == 1

    def test_fatal_error_ends_the_stream_and_keeps_committed_parts(self, db, seeded_db):
        from app.services.part_feed.mouser import FeedFatalError

        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        _subcategory(db, "Zener Diodes", "zener-diodes", parent)

        class _FatalOnSecondSearch(_FakeProvider):
            def search(self, keyword, limit=50, start_at=0):
                if self.calls_made >= 1:
                    self.calls_made += 1
                    raise FeedFatalError("Mouser API HTTP 429 on /search/keyword")
                return super().search(keyword, limit, start_at)

        provider = _FatalOnSecondSearch(results_by_keyword={"Amplifiers": [_feed_part("NEW-1")]})

        events = list(grow_catalog(db, provider, supplier, call_budget=10))

        assert [e["kind"] for e in events] == [
            "sync_started",
            "part_synced",
            "sync_error",
            "sync_finished",
        ]
        assert events[2]["title"] == "Feed unavailable"
        assert "429" in events[2]["detail"]
        assert events[-1]["counts"]["created"] == 1
        # the first category's work survived the abort's rollback
        part = db.query(Part).filter(Part.sku == "NEW-1").one()
        assert (
            db.query(PartListing)
            .filter(PartListing.part_id == part.id, PartListing.supplier_id == supplier.id)
            .count()
            == 1
        )


def _cursor(db, supplier) -> dict:
    row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier.id).first()
    return dict(row.import_cursor or {}) if row else {}


class TestImportCursor:
    """Per-(supplier, category) sweep depth — the fix for the discovery
    plateau, where every Import click re-read page one and found nothing.

    The cursor lives on `supplier_feeds.import_cursor` as
    `{category_slug: next_start_at}`, with -1 for EXHAUSTED.
    """

    def test_a_swept_category_records_its_depth(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={"Voltage References": [_feed_part(f"NEW-{i}") for i in range(3)]}
        )

        list(grow_catalog(db, provider, supplier, call_budget=1, per_category=3))

        row = db.query(SupplierFeed).filter_by(supplier_id=supplier.id).one()
        assert row.import_cursor == {category_cursor_key("voltage-references"): 3}
        # the row this run had to create must never switch the nightly job on
        assert row.auto_import_enabled is False

    def test_a_short_page_marks_the_category_exhausted(self, db, seeded_db):
        """Fewer rows than asked for means the shelf ran out — spending the
        next run's budget on it again is exactly the plateau."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(results_by_keyword={"Voltage References": [_feed_part("NEW-1")]})

        list(grow_catalog(db, provider, supplier, call_budget=1))

        assert _cursor(db, supplier) == {category_cursor_key("voltage-references"): -1}

    def test_the_next_run_starts_where_the_last_one_stopped(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        results = [_feed_part(f"NEW-{i}") for i in range(5)]

        first = _FakeProvider(results_by_keyword={"Voltage References": results})
        list(grow_catalog(db, first, supplier, call_budget=1, per_category=2))
        # budget 2 on the second run: the two parts run 1 imported moved this
        # category out of the thinnest slot, so the sweep reaches it second
        second = _FakeProvider(results_by_keyword={"Voltage References": results})
        list(grow_catalog(db, second, supplier, call_budget=2, per_category=2))

        assert first.search_calls == [("Voltage References", 2, 0)]
        assert ("Voltage References", 2, 2) in second.search_calls
        assert {p.sku for p in db.query(Part).filter(Part.sku.like("NEW-%")).all()} == {
            "NEW-0",
            "NEW-1",
            "NEW-2",
            "NEW-3",
        }
        assert _cursor(db, supplier)[category_cursor_key("voltage-references")] == 4

    def test_the_cursor_advances_by_RAW_rows_not_by_parts_kept(self, db, seeded_db):
        """A page whose rows partly fail to decode still consumed those rows.
        Advancing by what survived would re-fetch the junk every single run."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)

        class _HalfUndecodable(_FakeProvider):
            def search(self, keyword, limit=50, start_at=0):
                page = super().search(keyword, limit, start_at)
                # the distributor answered a FULL page; only these parsed
                self.last_raw_count = limit
                return page

        first = _HalfUndecodable(results_by_keyword={"Voltage References": [_feed_part("NEW-1")]})
        list(grow_catalog(db, first, supplier, call_budget=1, per_category=2))

        assert _cursor(db, supplier) == {category_cursor_key("voltage-references"): 2}
        second = _HalfUndecodable(results_by_keyword={"Voltage References": []})
        list(grow_catalog(db, second, supplier, call_budget=1, per_category=2))
        assert second.search_calls == [("Voltage References", 2, 2)]

    def test_an_exhausted_category_is_skipped_and_its_budget_moves_on(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        _subcategory(db, "Zener Diodes", "zener-diodes", parent)
        db.add(SupplierFeed(supplier_id=supplier.id, import_cursor={"amplifiers": -1}))
        db.commit()
        provider = _FakeProvider()

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        # Amplifiers is thinnest and would have gone first — the call went to
        # the next unexhausted shelf instead
        assert [kw for kw, _, _ in provider.search_calls] == ["Zener Diodes"]
        assert events[0]["detail"] == "growing catalog · budget 1 calls · 2 categories to sweep"
        # The seeded `amplifiers` was written before namespacing and is READ
        # through the shim, so it is honoured where it sits; the key this run
        # wrote is namespaced. A legacy key is only retired when the sweep
        # writes THAT unit (see `_cursor_set`), never wholesale.
        assert _cursor(db, supplier) == {
            "amplifiers": -1,
            category_cursor_key("zener-diodes"): -1,
        }

    def test_all_exhausted_wraps_around_and_sweeps_fresh(self, db, seeded_db):
        """Otherwise a fully-swept catalog turns the nightly run into a no-op
        forever, and parts the distributor added later are never seen."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        db.add(
            SupplierFeed(
                supplier_id=supplier.id,
                import_cursor={"amplifiers": -1, "clock-and-timing": -1},
            )
        )
        db.commit()
        provider = _FakeProvider()

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        assert events[0]["detail"] == (
            "growing catalog · budget 1 calls · 2 categories to sweep · "
            "catalog fully swept — restarting from the top"
        )
        assert provider.search_calls == [("Amplifiers", 50, 0)]
        # the clear PERSISTED: the old -1s are gone, not carried forward —
        # including the LEGACY spellings, which the wrap takes with it (a
        # surviving bare key would resume the shelf the wrap just reset)
        assert _cursor(db, supplier) == {category_cursor_key("amplifiers"): -1}

    def test_an_existing_feed_row_keeps_its_switch(self, db, seeded_db):
        """Same natural key as the PATCH upsert (supplier_id IS the pk) — the
        cursor write must never rebuild the row or flip the nightly toggle."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        db.add(SupplierFeed(supplier_id=supplier.id, auto_import_enabled=True))
        db.commit()

        list(grow_catalog(db, _FakeProvider(), supplier, call_budget=1))

        row = db.query(SupplierFeed).filter_by(supplier_id=supplier.id).one()
        assert row.auto_import_enabled is True
        assert row.import_cursor == {category_cursor_key("amplifiers"): -1}
        assert db.query(SupplierFeed).count() == 1

    def test_a_run_that_sweeps_nothing_writes_no_row(self, db, seeded_db):
        supplier = seeded_db["supplier1"]

        list(grow_catalog(db, _FakeProvider(), supplier, call_budget=0))

        assert db.query(SupplierFeed).filter_by(supplier_id=supplier.id).first() is None

    def test_a_quota_wall_keeps_the_depth_of_finished_categories(self, db, seeded_db):
        """Per-category persistence is what makes the wall survivable: the
        calls already spent are not re-spent tomorrow."""
        from app.services.part_feed.mouser import FeedFatalError

        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        _subcategory(db, "Zener Diodes", "zener-diodes", parent)

        class _FatalOnSecondSearch(_FakeProvider):
            def search(self, keyword, limit=50, start_at=0):
                if self.calls_made >= 1:
                    self.calls_made += 1
                    raise FeedFatalError("Mouser API HTTP 429 on /search/keyword")
                return super().search(keyword, limit, start_at)

        provider = _FatalOnSecondSearch(results_by_keyword={"Amplifiers": [_feed_part("NEW-1")]})

        events = list(grow_catalog(db, provider, supplier, call_budget=10))

        assert [e["kind"] for e in events][-2:] == ["sync_error", "sync_finished"]
        assert _cursor(db, supplier) == {category_cursor_key("amplifiers"): -1}


class TestContinuousImport:
    """`continuous=True` — one click sweeps until the well is dry.

    A single pass reads at most ONE page per subcategory and returns even with
    budget to spare, because the bound is the CATEGORY LIST: depth advanced one
    page per category per click, so filling a shelf took as many clicks as it
    had pages. Continuous re-derives the pending list and sweeps again.

    Three endings, and nothing else: the catalog runs out (every category
    answers short), the provider walls the run (FeedFatalError — the quota),
    or the runaway ceiling stops it. It must NEVER wrap and restart mid-run.
    """

    def test_it_sweeps_the_same_category_deeper_pass_after_pass(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={"Voltage References": [_feed_part(f"NEW-{i}") for i in range(6)]}
        )

        events = list(
            grow_catalog(db, provider, supplier, call_budget=100, per_category=2, continuous=True)
        )

        # 0 → 2 → 4 → 6, where the sixth page comes back short and ends it.
        # A single-pass run would have asked once, at 0, and stopped.
        assert [c for c in provider.search_calls if c[0] == "Voltage References"] == [
            ("Voltage References", 2, 0),
            ("Voltage References", 2, 2),
            ("Voltage References", 2, 4),
            ("Voltage References", 2, 6),
        ]
        assert {p.sku for p in db.query(Part).filter(Part.sku.like("NEW-%")).all()} == {
            f"NEW-{i}" for i in range(6)
        }
        assert (
            _cursor(db, supplier)[category_cursor_key("voltage-references")]
            == IMPORT_CURSOR_EXHAUSTED
        )
        assert events[-1]["counts"]["created"] == 6

    def test_one_started_and_one_finished_however_many_passes(self, db, seeded_db):
        """The wire shape does not change with the mode — a console parses one
        run, not one run per sweep. Only the detail strings say `continuous`."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={"Voltage References": [_feed_part(f"NEW-{i}") for i in range(4)]}
        )

        events = list(
            grow_catalog(db, provider, supplier, call_budget=100, per_category=2, continuous=True)
        )

        assert [e["kind"] for e in events].count("sync_started") == 1
        assert [e["kind"] for e in events].count("sync_finished") == 1
        assert events[0]["detail"] == (
            "growing catalog · continuous — sweeping until the feed is "
            "exhausted or its quota is reached"
        )
        # 3 sweeps: pages at 0 and 2, then the short page at 4 that ends it
        assert events[-1]["detail"].endswith("· 3 sweeps")
        # SIX keys now, and always all six on both routes — a sync reports
        # `created: 0` and `listing_added: 0`, an import reports
        # `not_found: 0`, so the console never has to tell a missing counter
        # from a zero one. `listing_added` joined the set when import stopped
        # refreshing already-listed parts: every listing an import writes is a
        # distributor's FIRST offer, which is new inventory rather than a
        # refresh, and reporting it as `updated` is what made the button look
        # like it was running a sync.
        assert set(events[-1]["counts"]) == {
            "synced",
            "media_filled",
            "not_found",
            "no_data",
            "created",
            "listing_added",
        }

    def test_it_does_not_wrap_and_restart_mid_run(self, db, seeded_db):
        """A healthy provider plus a mid-run wrap is an infinite re-read: every
        category would be cleared the moment it exhausted and read from page
        one again, forever. The wrap belongs to the NEXT click."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={"Voltage References": [_feed_part(f"NEW-{i}") for i in range(2)]}
        )

        events = list(
            grow_catalog(db, provider, supplier, call_budget=100, per_category=2, continuous=True)
        )

        # page 0 (full), page 2 (short → exhausted), stop. Never page 0 again.
        assert [c[2] for c in provider.search_calls if c[0] == "Voltage References"] == [0, 2]
        assert "restarting from the top" not in events[0]["detail"]
        assert all(v == IMPORT_CURSOR_EXHAUSTED for v in _cursor(db, supplier).values())

    def test_a_fully_swept_catalog_still_wraps_at_the_START_of_a_run(self, db, seeded_db):
        """The wrap is not removed by continuous, only pinned to run start —
        otherwise the click after an exhausting run would do nothing."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        db.add(
            SupplierFeed(
                supplier_id=supplier.id,
                import_cursor={"amplifiers": -1, "clock-and-timing": -1},
            )
        )
        db.commit()
        provider = _FakeProvider()

        events = list(grow_catalog(db, provider, supplier, call_budget=10, continuous=True))

        assert events[0]["detail"].endswith("· catalog fully swept — restarting from the top")
        assert [c[2] for c in provider.search_calls] == [0, 0]

    def test_the_quota_wall_ends_a_continuous_run_and_keeps_pass_one(self, db, seeded_db):
        """The wall is the EXPECTED ending of a continuous run, not a crash:
        the counts and the cursors pass one paid for all survive it."""
        from app.services.part_feed.mouser import FeedFatalError

        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)

        class _FatalOnTheSecondPass(_FakeProvider):
            def search(self, keyword, limit=50, start_at=0):
                if start_at > 0:
                    self.calls_made += 1
                    raise FeedFatalError("Mouser API HTTP 429 on /search/keyword")
                return super().search(keyword, limit, start_at)

        provider = _FatalOnTheSecondPass(
            results_by_keyword={"Voltage References": [_feed_part(f"NEW-{i}") for i in range(4)]}
        )

        events = list(
            grow_catalog(db, provider, supplier, call_budget=100, per_category=2, continuous=True)
        )

        assert [e["kind"] for e in events][-2:] == ["sync_error", "sync_finished"]
        assert "429" in events[-2]["detail"]
        # pass one's two parts were each committed before they were reported
        assert events[-1]["counts"]["created"] == 2
        assert {p.sku for p in db.query(Part).filter(Part.sku.like("NEW-%")).all()} == {
            "NEW-0",
            "NEW-1",
        }
        # and the depth they bought is still on the row, so the next run
        # resumes at page 2 rather than re-buying page 0
        assert _cursor(db, supplier)[category_cursor_key("voltage-references")] == 2

    def test_the_runaway_ceiling_stops_a_feed_that_never_runs_short(self, db, seeded_db):
        """A provider that answers a full page forever exhausts nothing and
        refuses nothing. The ceiling is the only thing left to stop it."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)

        class _Bottomless(_FakeProvider):
            def search(self, keyword, limit=50, start_at=0):
                self.calls_made += 1
                self.search_calls.append((keyword, limit, start_at))
                self.last_raw_count = limit
                return [_feed_part(f"{keyword[:2]}-{start_at + i}") for i in range(limit)]

        provider = _Bottomless()

        events = list(
            grow_catalog(db, provider, supplier, call_budget=5, per_category=2, continuous=True)
        )

        assert provider.calls_made == 5
        assert events[-1]["kind"] == "sync_finished"
        assert events[-1]["detail"].endswith("· 5 calls used · 3 sweeps")

    def test_the_ceiling_constant_is_the_documented_runaway_guard(self):
        """Named so the route can hand it to a continuous run without inventing
        a second number, and large enough that the provider's own quota is what
        normally ends the run."""
        assert CONTINUOUS_CALL_CEILING >= 1000

    def test_continuous_false_is_still_exactly_one_pass(self, db, seeded_db):
        """The default is unchanged, and the nightly job depends on it: one
        pass down the pending list, then return, budget left over or not."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Voltage References", "voltage-references", parent)
        provider = _FakeProvider(
            results_by_keyword={"Voltage References": [_feed_part(f"NEW-{i}") for i in range(6)]}
        )

        events = list(grow_catalog(db, provider, supplier, call_budget=100, per_category=2))

        assert [c for c in provider.search_calls if c[0] == "Voltage References"] == [
            ("Voltage References", 2, 0)
        ]
        assert provider.calls_made < 100  # budget left on the table, as designed
        assert "continuous" not in events[0]["detail"]
        assert "sweeps" not in events[-1]["detail"]
