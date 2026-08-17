"""Part-feed provider parsing + importer upsert behavior (no network)."""

import uuid

from app.models import Part, PartListing, PriceBreak, Supplier
from app.services.part_feed.base import FeedPart, FeedPriceBreak
from app.services.part_feed.importer import (
    backfill_images,
    fill_all_empty,
    fill_category,
)
from app.services.part_feed.mouser import (
    _parse_availability,
    _parse_lead_time,
    _parse_price,
    part_from_mouser,
)

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


class _FakeProvider:
    supplier_name = "Mouser Electronics"
    supplier_website = "mouser.com"

    def __init__(self, by_mpn=None, search_results=None):
        self.by_mpn = by_mpn or {}
        self.search_results = search_results or []

    def search(self, keyword, limit=50):
        return self.search_results[:limit]

    def lookup_mpn(self, mpn):
        return self.by_mpn.get(mpn)


def _feed_part(mpn="FEED-001", image="https://img.example/p.jpg", breaks=True):
    return FeedPart(
        mpn=mpn,
        manufacturer="Feed Mfr",
        description="10uF 25V ceramic capacitor 0805",
        image_url=image,
        datasheet_url="https://docs.example/d.pdf",
        supplier_sku=f"621-{mpn}",
        stock_quantity=500,
        lead_time_days=7,
        price_breaks=[FeedPriceBreak(1, 0.10), FeedPriceBreak(100, 0.08)] if breaks else [],
    )


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
        assert (
            db.query(Supplier).filter(Supplier.name == "Mouser Electronics").count() == 1
        )

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
            db.add(Category(
                id=uuid.uuid4(), name=n, slug=n.lower().replace(" ", "-"),
                icon="⚙", parent_id=parent.id, sort_order=20,
            ))
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
