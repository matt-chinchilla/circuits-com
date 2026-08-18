"""Part-feed provider parsing + importer upsert behavior (no network)."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import event as sa_event

from app.models import Category, Part, PartListing, PriceBreak, Supplier
from app.services.part_feed.base import FeedPriceBreak
from app.services.part_feed.importer import (
    _fill_part_media,
    backfill_images,
    fill_all_empty,
    fill_category,
    grow_catalog,
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
        provider = _FakeProvider(by_mpn={part2.sku: _feed_part(mpn=part2.sku)})
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
        provider = _FakeProvider(search_results=[_feed_part(mpn=part1.sku)])
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
                part1.sku: _feed_part(mpn=part1.sku),
                part2.sku: _feed_part(mpn=part2.sku),
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
        assert first["title"] == f"{part1.sku} — Feed Mfr"
        assert first["detail"] == "Clock and Timing"
        assert first["image_url"] == "https://img.example/p.jpg"
        assert "counts" not in first

        second = next(gen)
        assert len(commits) == 2
        assert second["title"] == f"{part2.sku} — Feed Mfr"

        finished = next(gen)
        assert finished["kind"] == "sync_finished"
        assert finished["counts"] == {
            "synced": 2,
            "media_filled": 2,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
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
        provider = _FakeProvider(by_mpn={part1.sku: _feed_part(mpn=part1.sku)})

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
        provider = _FakeProvider(by_mpn={part1.sku: _feed_part(mpn=part1.sku)})

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
        }

    def test_priceless_feed_part_reports_no_data(self, db, seeded_db):
        """A hit with no price breaks writes NOTHING (`_upsert_listing` bails —
        a listing without a price is not a comparison row) and the part's media
        is already there, so the honest action is `no_data`, not `updated`."""
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        part1.image_url = "https://cdn.example/original.jpg"
        part1.datasheet_url = "https://cdn.example/original.pdf"
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
        }
        assert events[-1]["detail"] == "0 synced · 0 images filled · 0 not found"

    def test_only_this_suppliers_parts_are_candidates(self, db, seeded_db):
        """part2 has no listing on supplier1 — it must not be swept in."""
        supplier = seeded_db["supplier1"]
        provider = _FakeProvider(
            by_mpn={
                seeded_db["part1"].sku: _feed_part(mpn=seeded_db["part1"].sku),
                seeded_db["part2"].sku: _feed_part(mpn=seeded_db["part2"].sku),
            }
        )
        events = list(sync_supplier_listings(db, provider, supplier, limit=10))
        assert events[0]["detail"] == "1 parts queued"
        titles = [e["title"] for e in events if e["kind"] == "part_synced"]
        assert titles == [f"{seeded_db['part1'].sku} — Feed Mfr"]

    def test_limit_prefers_parts_missing_an_image(self, db, seeded_db):
        supplier = seeded_db["supplier1"]
        part1, part2 = seeded_db["part1"], seeded_db["part2"]
        part1.image_url = "https://cdn.example/have-one.jpg"  # sku-first, but filled
        _attach_listing(db, part2, supplier)
        db.commit()
        provider = _FakeProvider(
            by_mpn={
                part1.sku: _feed_part(mpn=part1.sku),
                part2.sku: _feed_part(mpn=part2.sku),
            }
        )
        events = list(sync_supplier_listings(db, provider, supplier, limit=1))
        assert events[0]["detail"] == "1 parts queued"
        assert [e["title"] for e in events if e["kind"] == "part_synced"] == [
            f"{part2.sku} — Feed Mfr"
        ]

    def test_fatal_error_ends_the_stream_without_raising(self, db, seeded_db):
        from app.services.part_feed.mouser import FeedFatalError

        supplier = seeded_db["supplier1"]
        part1, part2 = seeded_db["part1"], seeded_db["part2"]
        _attach_listing(db, part2, supplier)
        feed = {part1.sku: _feed_part(mpn=part1.sku)}

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
            "detail": "growing catalog · budget 1 calls",
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
        }
        assert events[-1]["detail"] == (
            "2 created · 0 updated · 0 already elsewhere · 1 calls used"
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

    def test_existing_part_in_this_category_is_refreshed_not_duplicated(self, db, seeded_db):
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        before = db.query(Part).count()
        provider = _FakeProvider(results_by_keyword={"Clock and Timing": [_feed_part(part1.sku)]})

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        assert [e["action"] for e in events if e["kind"] == "part_synced"] == ["media_filled"]
        assert db.query(Part).count() == before
        assert events[-1]["counts"] == {
            "synced": 1,
            "media_filled": 1,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
        }
        assert events[-1]["detail"].startswith("0 created · 1 updated")

    def test_a_hit_that_writes_nothing_reports_no_data(self, db, seeded_db):
        """Same honesty rail as the sync: found, but nothing changed — calling
        that `updated` would overstate what the run did."""
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        part1.image_url = "https://cdn.example/original.jpg"
        part1.datasheet_url = "https://cdn.example/original.pdf"
        db.commit()
        provider = _FakeProvider(
            results_by_keyword={"Clock and Timing": [_feed_part(part1.sku, breaks=False)]}
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
        provider = _FakeProvider(results_by_keyword={"Voltage References": [_feed_part(part1.sku)]})
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
        }
        assert events[-1]["detail"] == (
            "0 created · 0 updated · 1 already elsewhere · 1 calls used"
        )

    def test_thinnest_subcategories_are_swept_first(self, db, seeded_db):
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Zener Diodes", "zener-diodes", parent)
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        _subcategory(db, "Sensor ICs", "sensor-ics", parent, parts=1)

        provider = _FakeProvider()
        list(grow_catalog(db, provider, supplier, call_budget=4))

        # 0 parts (name-tiebroken), then 1, then the seeded child's 2
        assert [kw for kw, _ in provider.search_calls] == [
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

        assert [kw for kw, _ in provider.search_calls] == ["Amplifiers", "Zener Diodes"]
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

        assert provider.search_calls == [("Clock and Timing", 50)]

    def test_a_category_wider_than_one_page_costs_more_than_one_call(self, db, seeded_db):
        """`per_category` above a page is a REAL multi-call ask — the budget
        has to be charged for the pages, not for the categories, or a nightly
        run would overspend its quota by the page factor."""
        supplier, parent = seeded_db["supplier1"], seeded_db["parent"]
        _subcategory(db, "Amplifiers", "amplifiers", parent)
        provider = _FakeProvider()

        events = list(grow_catalog(db, provider, supplier, call_budget=2, per_category=100))

        # one category, two pages — and the sweep stops there
        assert provider.search_calls == [("Amplifiers", 100)]
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
            def search(self, keyword, limit=50):
                if self.calls_made >= 1:
                    self.calls_made += 1
                    raise FeedFatalError("Mouser API HTTP 429 on /search/keyword")
                return super().search(keyword, limit)

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
