"""The four denormalized best-price columns on `parts`, and who keeps them true.

`parts.best_price`, `best_price_10/100/1000` (migration 046) exist so a
category page can ORDER BY price in the database. That only works while the
stored value equals what a live aggregate would say, so this file is about two
things and they pull in opposite directions:

  * CORRECTNESS — every path that can move a part's prices refreshes them, and
    the values match `MIN(part_listings.unit_price)` / the ladder minimum at
    each rung. A stale denormalization is worse than none: the page sorts on
    it and looks perfectly healthy while lying.

  * RESTRAINT — a pass that changes nothing must write nothing. `parts` is a
    wide row with eight indexes and the nightly Mouser sweep re-reads ~130,000
    of them; the price-break reconciler's `pg_stat_user_tables` reading
    (846,167 live rows against 4.84M row-ops, `n_tup_upd = 0`) is what a write
    path that ignores this looks like a year later.

Everything here runs on SQLite, including the migration's real backfill SQL,
which is executed from a constant the migration exposes rather than transcribed
here — a second copy of that SQL would be free to drift from the one that
actually ships.
"""

import importlib.util
import uuid
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import text

from app.models import Part, PartListing, PriceBreak, Supplier
from app.services.part_feed.importer import _upsert_listing
from app.services.part_pricing import (
    BEST_PRICE_COLUMNS,
    refresh_best_prices,
    storable_price,
)

from .feed_helpers import StatementCounter, feed_part

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "046_part_best_prices.py"
)


def _load_migration():
    if not MIGRATION_PATH.exists():
        pytest.fail(f"migration not written yet: {MIGRATION_PATH}")
    spec = importlib.util.spec_from_file_location("migration_046", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _prices(db, part_id) -> tuple:
    """The four stored values, read from the ROW rather than the ORM.

    `refresh_best_prices` writes through a Core bulk UPDATE, and an ORM
    attribute read can be served from the identity map — asserting on
    `part.best_price` would sometimes report what the object remembers instead
    of what the database holds, in a way that changes with fixture ordering.
    Raw SQL removes the question.

    The id is hyphen-stripped because conftest compiles `postgresql.UUID` to
    CHAR(32) on SQLite and SQLAlchemy's bind processor stores the bare hex.
    """
    db.expire_all()
    row = db.execute(
        text(
            "SELECT best_price, best_price_10, best_price_100, best_price_1000 "
            "FROM parts WHERE id = :pid"
        ),
        {"pid": str(part_id).replace("-", "")},
    ).first()
    assert row is not None, f"no parts row for {part_id} — the test is asserting on nothing"
    return tuple(None if v is None else Decimal(str(v)).quantize(Decimal("0.0001")) for v in row)


@pytest.fixture
def catalog(db):
    """Three parts with deliberately different shapes.

    priced   two distributors; the cheaper unit price and the cheaper rung
             come from DIFFERENT listings, so a query that takes the whole
             ladder off the winning listing gets it wrong
    partial  one distributor whose ladder stops at 100 — best_price_1000 has
             no source and must stay NULL, not fall back to a coarser rung
    bare     no listings at all
    """
    supplier_a = Supplier(id=uuid.uuid4(), name="Mouser Electronics", website="mouser.com")
    supplier_b = Supplier(id=uuid.uuid4(), name="Rival Components", website="rival.test")
    db.add_all([supplier_a, supplier_b])

    priced = Part(id=uuid.uuid4(), sku="PRICED-1", manufacturer_name="TI")
    partial = Part(id=uuid.uuid4(), sku="PARTIAL-1", manufacturer_name="TI")
    bare = Part(id=uuid.uuid4(), sku="BARE-1", manufacturer_name="TI")
    db.add_all([priced, partial, bare])
    db.flush()

    # A is dearer at qty 1 but cheapest at 10 and 1000; B wins the unit price
    # and qty 100. Any "take the best listing, then read its ladder" shortcut
    # produces a different answer than the one asserted below.
    ladders = {
        supplier_a.id: (Decimal("1.0000"), {10: "0.7000", 100: "0.6500", 1000: "0.4000"}),
        supplier_b.id: (Decimal("0.9000"), {10: "0.8000", 100: "0.5500", 1000: "0.4500"}),
    }
    for supplier_id, (unit, rungs) in ladders.items():
        listing = PartListing(
            id=uuid.uuid4(), part_id=priced.id, supplier_id=supplier_id, unit_price=unit
        )
        db.add(listing)
        db.flush()
        for qty, price in rungs.items():
            db.add(
                PriceBreak(
                    id=uuid.uuid4(),
                    listing_id=listing.id,
                    min_quantity=qty,
                    unit_price=Decimal(price),
                )
            )

    thin = PartListing(
        id=uuid.uuid4(),
        part_id=partial.id,
        supplier_id=supplier_a.id,
        unit_price=Decimal("2.2500"),
    )
    db.add(thin)
    db.flush()
    for qty, price in ((10, "2.0000"), (100, "1.7500")):
        db.add(
            PriceBreak(
                id=uuid.uuid4(), listing_id=thin.id, min_quantity=qty, unit_price=Decimal(price)
            )
        )
    db.commit()
    return {
        "priced": priced.id,
        "partial": partial.id,
        "bare": bare.id,
        "supplier_a": supplier_a.id,
        "supplier_b": supplier_b.id,
    }


# The fingerprint of a best-price recompute in the statement log. Statement-text
# matching is blunt, and deliberately so: whether the refresh RAN is invisible
# in every outcome assertion, because a refresh that runs and finds nothing to
# do is indistinguishable from one that never happened.
BEST_PRICE_AGGREGATE = "min(part_listings.unit_price)"

PRICED_EXPECTED = (Decimal("0.9000"), Decimal("0.7000"), Decimal("0.5500"), Decimal("0.4000"))
PARTIAL_EXPECTED = (Decimal("2.2500"), Decimal("2.0000"), Decimal("1.7500"), None)
NOTHING = (None, None, None, None)


# ── the migration's own backfill ────────────────────────────────────────────


class TestTheBackfill:
    """Migration 046's two set-based UPDATEs, executed as the migration ships
    them.

    The statements are imported from the migration module, not re-typed here:
    a transcription is free to drift from what actually runs on production, and
    the drift would be invisible — both copies would pass their own reading of
    the arithmetic.
    """

    @staticmethod
    def _run(db, module):
        return [db.execute(text(sql)).rowcount for sql in module.BACKFILL_STATEMENTS]

    def test_it_materializes_the_minimum_at_every_rung(self, db, catalog):
        module = _load_migration()
        self._run(db, module)

        assert _prices(db, catalog["priced"]) == PRICED_EXPECTED, (
            "the backfill did not take each rung's minimum across ALL of the "
            "part's listings — the cheapest unit price and the cheapest qty-10 "
            "price deliberately live on different distributors here"
        )

    def test_a_rung_with_no_source_stays_null(self, db, catalog):
        module = _load_migration()
        self._run(db, module)

        assert _prices(db, catalog["partial"]) == PARTIAL_EXPECTED, (
            "a ladder that stops at 100 must leave best_price_1000 NULL; "
            "falling back to a coarser rung would advertise a bulk price no "
            "distributor quoted"
        )

    def test_a_part_with_no_listings_is_left_at_null(self, db, catalog):
        module = _load_migration()
        self._run(db, module)

        assert _prices(db, catalog["bare"]) == NOTHING

    def test_running_it_twice_writes_nothing_the_second_time(self, db, catalog):
        """`IS DISTINCT FROM` is what makes the backfill safe to re-run.

        A migration that is re-applied, or the same SQL used to repair drift,
        must not rewrite 175,000 rows to arrive at the values already there.
        """
        module = _load_migration()
        first = self._run(db, module)
        second = self._run(db, module)

        assert first != [0, 0], "the first pass wrote nothing — the fixture is not exercising it"
        assert second == [0, 0], (
            f"a re-run rewrote rows that already held the right values: {second}"
        )


# ── refresh_best_prices ─────────────────────────────────────────────────────


class TestRefreshCorrectness:
    def test_it_agrees_with_the_migration_backfill(self, db, catalog):
        """The two implementations of the same arithmetic must not disagree.

        One is set-based SQL run once at deploy, the other is a per-batch
        recompute run thousands of times a night. If they can diverge, the
        catalog's prices depend on which one last touched a row.
        """
        refresh_best_prices(db, [catalog["priced"], catalog["partial"], catalog["bare"]])
        db.commit()

        assert _prices(db, catalog["priced"]) == PRICED_EXPECTED
        assert _prices(db, catalog["partial"]) == PARTIAL_EXPECTED
        assert _prices(db, catalog["bare"]) == NOTHING

    def test_it_reports_how_many_rows_moved(self, db, catalog):
        moved = refresh_best_prices(db, [catalog["priced"], catalog["partial"], catalog["bare"]])
        db.commit()

        assert moved == 2, (
            f"expected the two priced parts to move and the bare one to stay NULL, got {moved}"
        )

    def test_losing_the_last_listing_clears_the_columns(self, db, catalog):
        """Absence has to propagate. A part whose offers all disappear must go
        back to NULL rather than keep quoting a price nothing backs — the
        aggregate has no row to produce, so this only works because the refresh
        starts every part at NULL instead of only overwriting what it finds."""
        refresh_best_prices(db, [catalog["partial"]])
        db.commit()
        assert _prices(db, catalog["partial"]) == PARTIAL_EXPECTED

        listing_ids = [
            row[0]
            for row in db.query(PartListing.id)
            .filter(PartListing.part_id == catalog["partial"])
            .all()
        ]
        db.query(PriceBreak).filter(PriceBreak.listing_id.in_(listing_ids)).delete(
            synchronize_session=False
        )
        db.query(PartListing).filter(PartListing.part_id == catalog["partial"]).delete(
            synchronize_session=False
        )
        refresh_best_prices(db, [catalog["partial"]])
        db.commit()

        assert _prices(db, catalog["partial"]) == NOTHING

    def test_it_sees_rows_the_caller_has_only_staged(self, db, catalog):
        """Sessions run `autoflush=False`.

        The feed importer adds new price-break rows with `db.add` and does not
        flush them, so a refresh that did not flush first would read the ladder
        as it was BEFORE the pass that triggered it and store a stale minimum
        that nothing would ever correct.
        """
        listing = (
            db.query(PartListing)
            .filter(
                PartListing.part_id == catalog["priced"],
                PartListing.supplier_id == catalog["supplier_a"],
            )
            .first()
        )
        db.add(
            PriceBreak(
                id=uuid.uuid4(),
                listing_id=listing.id,
                min_quantity=100,
                unit_price=Decimal("0.0100"),
            )
        )
        refresh_best_prices(db, [catalog["priced"]])
        db.commit()

        assert _prices(db, catalog["priced"])[2] == Decimal("0.0100")

    def test_an_unknown_part_id_is_not_an_error(self, db, catalog):
        """The supplier-delete cascade hands over ids read before the delete;
        a part removed in the same transaction must not raise."""
        assert refresh_best_prices(db, [uuid.uuid4()]) == 0

    def test_it_batches_without_changing_the_answer(self, db, catalog):
        """Chunking is for the 130,728-part supplier delete, not for the
        arithmetic — a part must not get a different price for being in the
        second chunk."""
        moved = refresh_best_prices(
            db, [catalog["priced"], catalog["partial"], catalog["bare"]], chunk_size=1
        )
        db.commit()

        assert moved == 2
        assert _prices(db, catalog["priced"]) == PRICED_EXPECTED
        assert _prices(db, catalog["partial"]) == PARTIAL_EXPECTED


class TestARefreshThatChangesNothingWritesNothing:
    """The restraint half, and the one that is invisible in outcome assertions.

    A refresh that recomputed and re-stored the same four values would leave
    every test above green while rewriting `parts` on every confirming pass —
    a wide row with eight indexes, up to ~130,000 of them a night.
    """

    def test_a_second_identical_refresh_issues_no_writes(self, db, catalog):
        refresh_best_prices(db, [catalog["priced"], catalog["partial"], catalog["bare"]])
        db.commit()

        with StatementCounter(db) as counted:
            moved = refresh_best_prices(
                db, [catalog["priced"], catalog["partial"], catalog["bare"]]
            )
            db.commit()

        assert moved == 0
        writes = counted.writes_to("parts")
        assert writes == [], f"a refresh that changed nothing still wrote to parts: {writes}"

    def test_a_price_finer_than_the_column_still_settles(self, db, catalog):
        """The phantom-diff trap, on this table.

        Real DigiKey payloads quote five decimals into a `Numeric(10, 4)`, and
        comparing a raw value against the stored, already-rounded one differs
        on every pass — the row is rewritten forever while looking correct.

        STATED PLAINLY, because a test that overclaims is worse than none: this
        one passes with or without the explicit `storable_price` call in
        `_refresh_chunk`, and removing that call does NOT turn it red. It
        cannot, because both sides come back through SQLAlchemy's `Numeric`
        result processor, which quantizes to the declared scale on both engines
        (measured: SQLite physically stores 0.039091234 and still returns
        Decimal('0.0391')). What this asserts is the OUTCOME — that a
        five-decimal price settles — which is what stops being true the day
        someone widens the column, drops the declared scale, or computes the
        wanted value from feed precision instead of reading it back.
        """
        listing = (
            db.query(PartListing)
            .filter(PartListing.part_id == catalog["priced"])
            .order_by(PartListing.unit_price)
            .first()
        )
        listing.unit_price = Decimal("0.03909")
        db.commit()

        refresh_best_prices(db, [catalog["priced"]])
        db.commit()

        with StatementCounter(db) as counted:
            moved = refresh_best_prices(db, [catalog["priced"]])
            db.commit()

        assert moved == 0
        writes = counted.writes_to("parts")
        assert writes == [], (
            "a price the column cannot hold at full precision is being compared "
            f"un-rounded, so every pass sees a change: {writes}"
        )
        assert _prices(db, catalog["priced"])[0] == storable_price("0.03909")


# ── the write paths that have to call it ────────────────────────────────────


class TestTheFeedImporterKeepsThemTrue:
    """`_upsert_listing` is the single funnel every feed write goes through —
    sync, import, the BOM resolver and the category fill all reach the database
    through it, so wiring the refresh there covers all four at once."""

    @pytest.fixture
    def synced(self, db, catalog):
        """A listing already holding exactly what the feed is about to send."""
        part = db.get(Part, catalog["priced"])
        supplier = db.get(Supplier, catalog["supplier_a"])
        _upsert_listing(
            db, part, supplier, feed_part(mpn="PRICED-1", ladder=[(1, 0.50), (10, 0.45)])
        )
        db.commit()
        return part, supplier

    def test_a_moved_rung_moves_the_part(self, db, catalog, synced):
        part, supplier = synced
        assert _prices(db, part.id)[1] == Decimal("0.4500")

        _upsert_listing(
            db, part, supplier, feed_part(mpn="PRICED-1", ladder=[(1, 0.50), (10, 0.20)])
        )
        db.commit()

        assert _prices(db, part.id)[1] == Decimal("0.2000"), (
            "the feed repriced a rung and the denormalized column did not follow"
        )

    def test_a_new_distributors_first_offer_moves_the_part(self, db, catalog):
        """The import path — a supplier that did not carry this part before.
        `listing_added`, not `updated`, and it can only lower the minimum."""
        part = db.get(Part, catalog["partial"])
        supplier = db.get(Supplier, catalog["supplier_b"])
        refresh_best_prices(db, [part.id])
        db.commit()
        assert _prices(db, part.id)[0] == Decimal("2.2500")

        _upsert_listing(db, part, supplier, feed_part(mpn="PARTIAL-1", ladder=[(1, 0.11)]))
        db.commit()

        assert _prices(db, part.id)[0] == Decimal("0.1100")

    def test_a_confirming_sweep_writes_no_part_rows(self, db, catalog, synced):
        """The invariant the nightly sweep depends on.

        Mouser's feed re-reads ~130,000 listings a night and moves few of them.
        If a confirming pass touched `parts`, this would be the churn the
        price-break reconciler was written to remove, reintroduced one table
        over.
        """
        part, supplier = synced

        with StatementCounter(db) as counted:
            _upsert_listing(
                db, part, supplier, feed_part(mpn="PRICED-1", ladder=[(1, 0.50), (10, 0.45)])
            )
            db.commit()

        writes = counted.writes_to("parts")
        assert writes == [], f"a sweep that confirmed every price still wrote to parts: {writes}"
        assert counted.matching(BEST_PRICE_AGGREGATE) == [], (
            "the confirming pass recomputed best prices anyway — it writes "
            "nothing, so only this read assertion notices"
        )

    def test_a_stock_only_refresh_does_not_recompute_the_part(self, db, catalog, synced):
        """Narrower than "the listing was touched", and the assertion is on the
        READ.

        Stock and lead time move constantly and cannot change a minimum, so a
        listing UPDATE alone must not drag the part row along with it. Asserting
        only "no write to parts" would prove nothing here — `refresh_best_prices`
        is idempotent, so an ungated call still writes nothing and the test
        would stay green while three aggregate queries per part were added back
        onto the sweep. The cost of getting this wrong is reads, so reads are
        what is counted.
        """
        part, supplier = synced
        fp = feed_part(mpn="PRICED-1", ladder=[(1, 0.50), (10, 0.45)])
        fp.stock_quantity = 999_999

        with StatementCounter(db) as counted:
            _upsert_listing(db, part, supplier, fp)
            db.commit()

        assert counted.writes_to("part_listings"), (
            "the fixture did not actually change the listing — this test would "
            "pass without proving anything"
        )
        assert counted.matching(BEST_PRICE_AGGREGATE) == [], (
            "a stock-only refresh recomputed the part's best prices; the gate in "
            "_upsert_listing has widened from 'a minimum could have moved' to "
            "'the listing row was touched'"
        )
        assert counted.writes_to("parts") == []


class TestTheAdminRoutesKeepThemTrue:
    def test_attaching_a_listing_reprices_the_part(self, db, client, seeded_db, auth_header):
        part = seeded_db["part2"]  # no listings in the fixture
        resp = client.post(
            f"/api/parts/{part.id}/listings",
            json={
                "supplier_id": str(seeded_db["supplier1"].id),
                "unit_price": 3.25,
                "stock_quantity": 10,
            },
            headers=auth_header(),
        )

        assert resp.status_code == 200, resp.text
        assert _prices(db, part.id)[0] == Decimal("3.2500")

    def test_removing_the_cheapest_listing_raises_the_price(
        self, db, client, seeded_db, auth_header
    ):
        """Deleting an offer RAISES a best price — the direction a refresh
        placed before the delete would get wrong while still writing a row."""
        part = seeded_db["part1"]
        refresh_best_prices(db, [part.id])
        db.commit()
        assert _prices(db, part.id)[0] == Decimal("0.4800")

        resp = client.delete(
            f"/api/parts/{part.id}/listings/{seeded_db['listing2'].id}",
            headers=auth_header(),
        )

        assert resp.status_code == 200, resp.text
        assert _prices(db, part.id)[0] == Decimal("0.5200")

    def test_creating_a_part_with_its_first_listing_prices_it(
        self, db, client, seeded_db, auth_header
    ):
        resp = client.post(
            "/api/parts/",
            json={
                "sku": "NEW-WITH-OFFER",
                "manufacturer_name": "Texas Instruments",
                "category_id": str(seeded_db["child"].id),
                "initial_listing": {
                    "supplier_id": str(seeded_db["supplier1"].id),
                    "unit_price": 7.5,
                },
            },
            headers=auth_header(),
        )

        assert resp.status_code == 200, resp.text
        assert _prices(db, uuid.UUID(str(resp.json()["id"])))[0] == Decimal("7.5000")

    def test_a_batch_import_prices_what_it_creates(self, db, client, seeded_db, auth_header):
        resp = client.post(
            "/api/parts/batch",
            json={
                "supplier_id": str(seeded_db["supplier1"].id),
                "parts": [
                    {"sku": "BATCH-A", "manufacturer_name": "TI", "unit_price": 1.25},
                    {"sku": "BATCH-B", "manufacturer_name": "TI"},
                ],
            },
            headers=auth_header(),
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["created"] == 2
        priced = db.query(Part).filter(Part.sku == "BATCH-A").first()
        unpriced = db.query(Part).filter(Part.sku == "BATCH-B").first()
        assert _prices(db, priced.id)[0] == Decimal("1.2500")
        assert _prices(db, unpriced.id) == NOTHING, (
            "a CSV row carrying no price creates no listing, so the part has no "
            "best price — storing 0 there would undercut every real distributor"
        )


class TestDeletingASupplierReprices:
    def test_the_parts_it_carried_lose_its_offers(self, db, client, seeded_db, auth_header):
        """The eight-surface cascade takes a distributor's listings with it, so
        every part that distributor priced needs recomputing — and after the
        delete there is nothing left to say which parts those were."""
        part = seeded_db["part1"]
        refresh_best_prices(db, [part.id])
        db.commit()
        assert _prices(db, part.id)[0] == Decimal("0.4800")  # Kennedy is cheaper

        resp = client.delete(f"/api/suppliers/{seeded_db['supplier2'].id}", headers=auth_header())

        assert resp.status_code == 200, resp.text
        assert _prices(db, part.id)[0] == Decimal("0.5200"), (
            "the deleted distributor's price survived the cascade in the denormalized column"
        )

    def test_the_last_distributor_leaving_clears_the_price(
        self, db, client, seeded_db, auth_header
    ):
        part = seeded_db["part1"]
        db.query(PriceBreak).filter(PriceBreak.listing_id == seeded_db["listing1"].id).delete(
            synchronize_session=False
        )
        db.query(PartListing).filter(PartListing.id == seeded_db["listing1"].id).delete(
            synchronize_session=False
        )
        db.commit()
        refresh_best_prices(db, [part.id])
        db.commit()
        assert _prices(db, part.id)[0] == Decimal("0.4800")

        resp = client.delete(f"/api/suppliers/{seeded_db['supplier2'].id}", headers=auth_header())

        assert resp.status_code == 200, resp.text
        assert _prices(db, part.id) == NOTHING


# ── schema contract ─────────────────────────────────────────────────────────


class TestTheColumnsAreUnindexedOnPurpose:
    """The decision most likely to be "fixed" by a future reader.

    An index on a best-price column looks like an obvious win for an ORDER BY
    and is the opposite. Every UPDATE on this table that touches only unindexed
    columns is eligible for a HOT update — Postgres writes the new row version
    in the same page and skips all eight index entries. Index one of these and
    every reprice the nightly feed performs stops being HOT and rewrites that
    index too, forever, which is precisely the churn the price-break
    reconciler removed. Nothing is bought: these are sorted after the query has
    already been narrowed to one category (at most ~40k rows, in memory, in
    milliseconds).
    """

    def test_all_four_columns_exist(self, db):
        columns = {c.name for c in Part.__table__.columns}
        assert set(BEST_PRICE_COLUMNS) <= columns, (
            f"missing best-price columns: {set(BEST_PRICE_COLUMNS) - columns}"
        )

    def test_none_of_them_is_indexed(self, db):
        # Two halves, because neither is sufficient. `__table__.indexes` covers
        # what the model declares; a `Column(..., index=True)` never reaches it
        # as a named entry the same way, so the schema itself is read too — via
        # `sqlite_master` rather than `inspect()`, because SQLAlchemy cannot
        # reflect this table's two EXPRESSION indexes and warns on every call.
        declared = {column.name for index in Part.__table__.indexes for column in index.columns}
        declared |= {c.name for c in Part.__table__.columns if c.index}
        schema_sql = " ".join(
            row[0] or ""
            for row in db.execute(
                text("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'parts'")
            ).all()
        )
        for name in BEST_PRICE_COLUMNS:
            assert name not in declared, f"{name} gained a declared index — see this class"
            assert name not in schema_sql, (
                f"{name} appears in an index on `parts` in the live schema — see this class"
            )

    def test_storable_price_rounds_to_the_columns_own_scale(self):
        """The shared rounding contract, asserted directly.

        `storable_price` is the one home for "what the database will actually
        hold" — the feed importer imports it from here rather than keeping a
        second copy, because two implementations is how the phantom diff comes
        back on one path with the other path's tests still green.
        """
        assert storable_price("0.03909") == Decimal("0.0391")
        assert storable_price(0.03766) == Decimal("0.0377")
        assert storable_price(Decimal("1.5")) == Decimal("1.5000")

    def test_every_price_column_shares_one_scale(self):
        """`storable_price` rounds for SIX columns off a single constant.

        It reads its scale from `price_breaks.unit_price` and is applied to
        `part_listings.unit_price` and all four of these. A divergence would
        round one of them to a precision it cannot store, every refresh would
        see a difference, and the permanent-UPDATE churn would be back with no
        other test noticing.
        """
        scale = PriceBreak.__table__.c.unit_price.type.scale
        assert scale is not None, "price_breaks.unit_price lost its explicit scale"
        for name in BEST_PRICE_COLUMNS:
            assert Part.__table__.c[name].type.scale == scale, (
                f"parts.{name} has scale {Part.__table__.c[name].type.scale}, "
                f"but storable_price rounds everything to {scale}"
            )


class TestAFreshDatabaseComesUpPriced:
    """The failure migration 046 cannot prevent on its own.

    On a fresh database alembic runs BEFORE the seed, so 046's backfill runs
    against an empty `parts` table and every row the seed then creates would be
    left at NULL — a whole local or newly-provisioned environment where the
    category pages sort every part into "no price" and nothing errors.

    The seed's own call is scoped to the ids it CREATED, which is what keeps
    this off the hot path: the seed re-runs on every api container start and is
    get-or-create, so an established database creates nothing and the pass
    returns without touching a row.

    Expensive (a full catalog seed), so it is ONE test asserting both halves —
    the demo parts and the JSON catalog parts — rather than one each.
    """

    def test_the_seed_materializes_best_prices_on_what_it_creates(self, db):
        from app.db.seed import seed

        seed(db)

        priced, total = db.execute(
            text(
                "SELECT COUNT(best_price), COUNT(*) FROM parts "
                "WHERE EXISTS (SELECT 1 FROM part_listings l WHERE l.part_id = parts.id)"
            )
        ).first()
        assert total > 0, "the seed created no priced parts — this test proves nothing"
        assert priced == total, (
            f"{total - priced} of {total} seeded parts with listings have a NULL "
            "best_price; the seed is not calling refresh_best_prices on what it created"
        )

        # And the values are the real minimum, not merely non-NULL.
        mismatched = db.execute(
            text(
                "SELECT COUNT(*) FROM parts p WHERE p.best_price IS NOT NULL AND "
                "p.best_price <> (SELECT MIN(l.unit_price) FROM part_listings l "
                "WHERE l.part_id = p.id)"
            )
        ).scalar()
        assert mismatched == 0, f"{mismatched} seeded parts hold a best_price no listing quotes"
