"""What a feed refresh is allowed to ask of the database, reads and writes.

`PartListing.price_breaks` is `lazy="selectin"`, so merely loading a listing
issues a second SELECT that materialises every price break on it as a full ORM
object. Measured against the local catalog: loading one part with ten
distributor listings cost 3 statements and hydrated 50 objects, 40 of them
price breaks. At the scale this is heading for — the whole multi-distributor
premise is that `part_listings` grows by about a catalog per distributor —
that is a connection held longer and a pool of 15 the public site shares.

`_upsert_listing` does need the ladder, but it needs three columns for ONE
listing, which it reads itself. The `noload` is what keeps that targeted read
from being additive to a fan-out nothing here uses.

The write half is the larger problem and is covered by
`TestUnchangedLaddersAreNotChurned` below.

Statement-count assertions are a blunt instrument and deliberately so: they
fail the moment someone reintroduces an eager load or a wholesale rewrite on
this path, which is the exact regression that is invisible in every other kind
of test.
"""

import uuid
from decimal import Decimal

import pytest

from app.models import Part, PartListing, PriceBreak, Supplier
from app.services.part_feed.importer import _upsert_listing

from .feed_helpers import StatementCounter, feed_part


@pytest.fixture
def part_with_offers(db):
    """One part carrying three distributor listings, four price breaks each."""
    supplier = Supplier(id=uuid.uuid4(), name="Mouser Electronics", website="mouser.com")
    others = [Supplier(id=uuid.uuid4(), name=f"Rival {n}", website=f"r{n}.test") for n in range(2)]
    db.add_all([supplier, *others])

    part = Part(id=uuid.uuid4(), sku="BUDGET-1", manufacturer_name="TI")
    db.add(part)
    db.flush()

    for owner in (supplier, *others):
        listing = PartListing(
            id=uuid.uuid4(),
            part_id=part.id,
            supplier_id=owner.id,
            unit_price=Decimal("1.00"),
        )
        db.add(listing)
        db.flush()
        for qty in (1, 10, 100, 1000):
            db.add(
                PriceBreak(
                    id=uuid.uuid4(),
                    listing_id=listing.id,
                    min_quantity=qty,
                    unit_price=Decimal("1.00"),
                )
            )
    db.commit()
    part_id, supplier_id = part.id, supplier.id
    db.expunge_all()
    return part_id, supplier_id


def test_refreshing_a_listing_reads_the_ladder_exactly_once(db, part_with_offers):
    """One targeted read, not a read plus the relationship's own fan-out.

    This test used to assert ZERO reads of `price_breaks`, on the premise that
    the importer deleted the ladder unread. That premise is gone: the importer
    now diffs against the ladder rather than replacing it, so reading it is the
    point. The regression the assertion still catches is the one it always
    cared about — dropping the `noload` makes `lazy="selectin"` fire its own
    SELECT on top of this one, hydrating ORM objects nothing uses.
    """
    part_id, supplier_id = part_with_offers
    part = db.get(Part, part_id)
    supplier = db.get(Supplier, supplier_id)

    with StatementCounter(db) as counted:
        _upsert_listing(db, part, supplier, feed_part(mpn="BUDGET-1"))

    selects = counted.matching("select price_breaks")
    assert len(selects) == 1, (
        f"expected one targeted read of the ladder, got {len(selects)}; a second "
        "one means the selectin relationship loaded too — restore the noload on "
        "PartListing.price_breaks"
    )
    assert "listing_id = " in selects[0], (
        f"the ladder was read across more than the one listing being refreshed: {selects[0]}"
    )


def test_refreshing_a_listing_leaves_the_ladder_matching_the_feed(db, part_with_offers):
    """Whatever the write strategy, the OUTCOME is the feed's ladder.

    Deliberately says nothing about how. This test was called
    "still_replaces_the_breaks" when replacement was the strategy, and a
    row-count assertion is equally true of replacement and of reconciliation —
    so leaving the old name would have told the next reader that a revert to
    wholesale replacement was the expected state.
    `TestUnchangedLaddersAreNotChurned` owns the how.
    """
    part_id, supplier_id = part_with_offers
    part = db.get(Part, part_id)
    supplier = db.get(Supplier, supplier_id)

    _upsert_listing(db, part, supplier, feed_part(mpn="BUDGET-1"))
    db.commit()

    listing = (
        db.query(PartListing)
        .filter(PartListing.part_id == part_id, PartListing.supplier_id == supplier_id)
        .first()
    )
    breaks = db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).all()
    assert breaks, "the refresh wrote no price breaks at all"
    assert len(breaks) == len(feed_part(mpn="BUDGET-1").price_breaks)


class TestUnchangedLaddersAreNotChurned:
    """A price ladder the feed confirms must not be rewritten.

    `_upsert_listing` used to replace every break unconditionally: one
    `DELETE ... WHERE listing_id = ?` followed by an `INSERT` per rung, on
    every pass, whether or not a single price had moved. Measured on the local
    catalog before the fix, `pg_stat_user_tables` told the whole story for
    `price_breaks`:

        live_rows 846,167 | inserts 2,760,938 | deletes 2,080,759 | updates 0

    4.84M row-ops to hold 846k rows, and `n_tup_upd = 0` — not one row had
    ever been updated in the table's life, because nothing ever tried. Mouser
    alone owns 697,945 of those breaks across 130,728 listings, so a single
    sweep of the one supplier with a real feed is ~1.4M row-ops plus the index
    writes for all three of the table's indexes (67 MB of them), essentially
    all of it re-creating rows identical to the ones it just destroyed.

    The natural key inside a listing is `min_quantity`, so the fix is a diff
    against it: delete the rungs that left, insert the rungs that arrived,
    update the ones whose price moved, and touch nothing else.

    These tests assert on row IDENTITY rather than on SQL text wherever they
    can. A surviving row keeps its `id`; a destroyed-and-recreated one cannot,
    because the id is a fresh `uuid4`. That reads the outcome the database
    actually holds instead of the statements someone happened to emit.
    """

    @staticmethod
    def _ladder(db, listing_id) -> dict[int, tuple[uuid.UUID, Decimal]]:
        rows = (
            db.query(PriceBreak.min_quantity, PriceBreak.id, PriceBreak.unit_price)
            .filter(PriceBreak.listing_id == listing_id)
            .all()
        )
        return {qty: (pk, price) for qty, pk, price in rows}

    @staticmethod
    def _settle(db, part, supplier, **kw):
        """Run one pass and commit, so the next pass sees persisted rows."""
        _upsert_listing(db, part, supplier, feed_part(mpn="BUDGET-1", **kw))
        db.commit()

    @pytest.fixture
    def settled(self, db, part_with_offers):
        """A listing already holding exactly what the feed is about to send."""
        part_id, supplier_id = part_with_offers
        part = db.get(Part, part_id)
        supplier = db.get(Supplier, supplier_id)
        self._settle(db, part, supplier, ladder=[(1, 0.10), (100, 0.08)])
        listing = (
            db.query(PartListing)
            .filter(PartListing.part_id == part_id, PartListing.supplier_id == supplier_id)
            .first()
        )
        return part, supplier, listing.id

    def test_an_identical_second_pass_leaves_every_row_alone(self, db, settled):
        part, supplier, listing_id = settled
        before = self._ladder(db, listing_id)

        self._settle(db, part, supplier, ladder=[(1, 0.10), (100, 0.08)])

        assert self._ladder(db, listing_id) == before, (
            "a pass that confirmed the existing ladder destroyed and recreated "
            "it — this is the 4.84M-row-ops-for-846k-rows bug"
        )

    def test_an_identical_second_pass_issues_no_writes_at_all(self, db, settled):
        """Identity can be preserved by rewriting in place; that is still waste."""
        part, supplier, _ = settled

        with StatementCounter(db) as counted:
            self._settle(db, part, supplier, ladder=[(1, 0.10), (100, 0.08)])

        writes = counted.writes_to("price_breaks")
        assert writes == [], f"an unchanged ladder still wrote to price_breaks: {writes}"

    def test_a_moved_price_is_updated_in_place(self, db, settled):
        """The rung that moved keeps its row; the rung that did not is untouched."""
        part, supplier, listing_id = settled
        before = self._ladder(db, listing_id)

        self._settle(db, part, supplier, ladder=[(1, 0.10), (100, 0.07)])
        after = self._ladder(db, listing_id)

        assert after[100][0] == before[100][0], "the repriced rung was recreated, not updated"
        assert after[100][1] == Decimal("0.0700"), "the new price was not stored"
        assert after[1] == before[1], "an unrelated rung was rewritten"

    def test_a_quantity_that_left_the_ladder_is_deleted(self, db, settled):
        part, supplier, listing_id = settled
        before = self._ladder(db, listing_id)

        self._settle(db, part, supplier, ladder=[(1, 0.10)])
        after = self._ladder(db, listing_id)

        assert set(after) == {1}, "a rung the feed dropped is still on the listing"
        assert after[1] == before[1], "the surviving rung was rewritten"

    def test_a_quantity_that_joined_the_ladder_is_inserted(self, db, settled):
        part, supplier, listing_id = settled
        before = self._ladder(db, listing_id)

        self._settle(db, part, supplier, ladder=[(1, 0.10), (100, 0.08), (1000, 0.05)])
        after = self._ladder(db, listing_id)

        assert set(after) == {1, 100, 1000}
        assert after[1000][1] == Decimal("0.0500")
        assert {q: after[q] for q in (1, 100)} == before, "the existing rungs were rewritten"

    def test_duplicate_rows_for_one_quantity_collapse_to_one(self, db, settled):
        """Nothing in the schema forbids two rows at the same quantity.

        There are none in the live catalog today, but `price_breaks` has no
        unique constraint on `(listing_id, min_quantity)` — only separate
        indexes — so a diff keyed on quantity must reconcile a duplicate rather
        than update one copy and leave the other stranded forever.
        """
        part, supplier, listing_id = settled
        db.add(
            PriceBreak(
                id=uuid.uuid4(),
                listing_id=listing_id,
                min_quantity=100,
                unit_price=Decimal("9.99"),
            )
        )
        db.commit()

        self._settle(db, part, supplier, ladder=[(1, 0.10), (100, 0.08)])

        rows = db.query(PriceBreak).filter(PriceBreak.listing_id == listing_id).all()
        at_100 = [r for r in rows if r.min_quantity == 100]
        assert len(at_100) == 1, f"the duplicate rung survived the diff: {len(at_100)} rows"
        assert at_100[0].unit_price == Decimal("0.0800")

    def test_a_feed_price_finer_than_the_column_still_settles(self, db, part_with_offers):
        """The diff must compare like with like, or it never converges.

        `price_breaks.unit_price` is `Numeric(10, 4)`, and real distributor
        feeds quote finer than that: the captured DigiKey payload prices a reel
        at 0.03909, 0.03766, 0.03695. Postgres stores 0.0391. A diff that
        compared the feed's 0.03909 against the stored 0.0391 would see a
        difference on EVERY pass and UPDATE the row forever, writing the same
        rounded value each time — the original churn bug wearing a new hat, and
        invisible unless someone re-read pg_stat_user_tables afterwards.

        136,698 rows in the live catalog already use that fourth decimal place,
        so this is the common case for high-volume passives, not an edge one.
        """
        part_id, supplier_id = part_with_offers
        part = db.get(Part, part_id)
        supplier = db.get(Supplier, supplier_id)
        fine = [(3000, 0.03909), (6000, 0.03766)]

        self._settle(db, part, supplier, ladder=fine)
        listing_id = (
            db.query(PartListing.id)
            .filter(PartListing.part_id == part_id, PartListing.supplier_id == supplier_id)
            .scalar()
        )
        before = self._ladder(db, listing_id)

        with StatementCounter(db) as counted:
            self._settle(db, part, supplier, ladder=fine)

        writes = counted.writes_to("price_breaks")
        assert writes == [], (
            "a feed quoting more precision than the column can hold rewrites "
            f"the same rounded value on every pass: {writes}"
        )
        assert self._ladder(db, listing_id) == before


class TestUnchangedListingRowsAreNotRewritten:
    """The rounding trap applies to the listing row too, and costs more there.

    `_upsert_listing` assigns `listing.unit_price` straight from the feed.
    `part_listings.unit_price` is the same `Numeric(10, 4)` as the price
    breaks', so a DigiKey reel quoted at 0.03909 is stored as 0.0391 and
    compared against 0.03909 on the next pass. SQLAlchemy sees a changed
    attribute, emits an UPDATE, and does it again forever — on a wider row than
    a price break, carrying FOUR indexes rather than three.

    The unit of work already suppresses an UPDATE when every assigned value
    matches what was loaded, so this is the only thing standing between a
    confirming pass and touching nothing at all.
    """

    def test_a_confirming_pass_does_not_rewrite_the_listing(self, db, part_with_offers):
        part_id, supplier_id = part_with_offers
        part = db.get(Part, part_id)
        supplier = db.get(Supplier, supplier_id)
        # Real DigiKey precision, from tests/fixtures/digikey_keyword_product.json.
        fine = [(3000, 0.03909), (6000, 0.03766)]

        _upsert_listing(db, part, supplier, feed_part(mpn="BUDGET-1", ladder=fine))
        db.commit()

        with StatementCounter(db) as counted:
            _upsert_listing(db, part, supplier, feed_part(mpn="BUDGET-1", ladder=fine))
            db.commit()

        updates = counted.writes_to("part_listings")
        assert updates == [], (
            "a pass that changed nothing rewrote the listing row; the feed price "
            f"is being compared at a precision the column cannot hold: {updates}"
        )


class TestTheCreatePathWritesOnce:
    """Creating a listing should cost one row version, not two.

    `_upsert_listing` constructed a `PartListing` carrying only the three
    identity columns, flushed it so the next existence query could see it, then
    assigned sku/stock/lead_time/unit_price/currency — an INSERT immediately
    followed by an UPDATE of the row just inserted. That pre-dates the
    reconciler, but rounding the price made it worse rather than better:
    the constructor stored the raw feed value and the assignment stored the
    rounded one, so `unit_price` joined the UPDATE's SET list on every create.
    `grow_catalog` creates thousands of listings per sweep, and this is write
    waste inside the function whose whole purpose is removing write waste.
    """

    def test_a_new_listing_is_inserted_and_not_immediately_updated(self, db):
        supplier = Supplier(id=uuid.uuid4(), name="Fresh Dist", website="fresh.test")
        part = Part(id=uuid.uuid4(), sku="CREATE-1", manufacturer_name="TI")
        db.add_all([supplier, part])
        db.commit()

        with StatementCounter(db) as counted:
            _upsert_listing(
                db,
                part,
                supplier,
                feed_part(mpn="CREATE-1", ladder=[(3000, 0.03909), (6000, 0.03766)]),
            )
            db.commit()

        writes = counted.writes_to("part_listings")
        inserts = [w for w in writes if w.strip().lower().startswith("insert")]
        updates = [w for w in writes if w.strip().lower().startswith("update")]
        assert len(inserts) == 1, f"expected one INSERT, got {len(inserts)}"
        assert updates == [], (
            "the row was updated immediately after being inserted — every field "
            f"belongs on the constructor: {updates}"
        )


class TestTheTwoPriceColumnsAgree:
    def test_both_unit_price_columns_share_one_scale(self):
        """`_storable_price` rounds for BOTH tables off a single constant.

        It reads its scale from `PriceBreak.unit_price` but is also applied to
        `PartListing.unit_price`. If those ever diverge, listing prices get
        rounded to the wrong number of places, every confirming pass sees a
        difference, and the permanent-UPDATE churn this module exists to
        prevent comes back silently — both tables round-trip cleanly at 4dp
        today, so no other test here would notice.
        """
        breaks = PriceBreak.__table__.c.unit_price.type.scale
        listings = PartListing.__table__.c.unit_price.type.scale
        assert breaks is not None, "price_breaks.unit_price lost its explicit scale"
        assert listings == breaks, (
            f"part_listings.unit_price has scale {listings} but price_breaks has "
            f"{breaks}; _storable_price rounds both to {breaks}"
        )


class TestRepeatedPassesBeforeACommit:
    def test_two_passes_without_a_commit_do_not_duplicate_the_ladder(self, db, part_with_offers):
        """The reconciler's SELECT must see rows an earlier pass staged.

        Sessions run `autoflush=False`, so price breaks added by one pass are
        invisible to the next pass's SELECT until something flushes — and the
        second pass would then insert the whole ladder again. Not reachable
        through today's callers (grow_catalog dedupes on (canon(manufacturer),
        MPN), the other two commit per part) and the wholesale-delete code it
        replaced duplicated identically, so this is a pre-existing hole rather
        than a regression. It is closed anyway, because the function documents
        itself as reconciling duplicate quantities and that promise should hold
        for its own siblings.
        """
        part_id, supplier_id = part_with_offers
        part = db.get(Part, part_id)
        supplier = db.get(Supplier, supplier_id)
        # Quantities the fixture does NOT already store, so the first pass ends
        # with PENDING inserts. A ladder that only repriced existing rungs would
        # go through Core UPDATEs, which apply immediately and are visible to the
        # next SELECT — the hazard would be invisible and the test would pass
        # against the bug.
        fp = feed_part(mpn="BUDGET-1", ladder=[(7, 0.10), (77, 0.08)])

        _upsert_listing(db, part, supplier, fp)
        _upsert_listing(db, part, supplier, fp)
        db.commit()

        listing_id = (
            db.query(PartListing.id)
            .filter(PartListing.part_id == part_id, PartListing.supplier_id == supplier_id)
            .scalar()
        )
        rows = db.query(PriceBreak).filter(PriceBreak.listing_id == listing_id).all()
        assert sorted(r.min_quantity for r in rows) == [7, 77], (
            f"a second pass before the commit duplicated the ladder: "
            f"{sorted(r.min_quantity for r in rows)}"
        )
