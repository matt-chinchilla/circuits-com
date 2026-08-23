"""What a feed refresh is allowed to ask the database for.

`PartListing.price_breaks` is `lazy="selectin"`, so merely loading a listing
issues a second SELECT that materialises every price break on it. The importer
never reads that collection — `_upsert_listing` replaces the breaks with a Core
`DELETE` and fresh `INSERT`s — so the rows are hydrated into ORM objects and
thrown away untouched, once per part, on every pass.

Measured against the local catalog before the fix: loading one part with ten
distributor listings cost 3 statements and hydrated 50 objects, 40 of them
price breaks that nothing looked at. At the scale this is heading for — the
whole multi-distributor premise is that `part_listings` grows by about a
catalog per distributor — that is a connection held longer and a pool of 15
that the public site shares.

A statement-count assertion is a blunt instrument and deliberately so: it fails
the moment someone reintroduces an eager load on this path, which is the exact
regression that is invisible in every other kind of test.
"""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import event

from app.models import Part, PartListing, PriceBreak, Supplier
from app.services.part_feed.importer import _upsert_listing

from .feed_helpers import feed_part


class StatementCounter:
    """Counts SQL issued on a session's bind while the block is open."""

    def __init__(self, session):
        self.bind = session.get_bind()
        self.statements: list[str] = []

    def __enter__(self):
        event.listen(self.bind, "before_cursor_execute", self._record)
        return self

    def __exit__(self, *exc):
        event.remove(self.bind, "before_cursor_execute", self._record)

    def _record(self, conn, cursor, statement, params, context, executemany):
        self.statements.append(statement)

    def matching(self, fragment: str) -> list[str]:
        return [s for s in self.statements if fragment in s.lower()]


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


def test_refreshing_a_listing_does_not_hydrate_the_breaks_it_is_about_to_delete(
    db, part_with_offers
):
    part_id, supplier_id = part_with_offers
    part = db.get(Part, part_id)
    supplier = db.get(Supplier, supplier_id)

    with StatementCounter(db) as counted:
        _upsert_listing(db, part, supplier, feed_part(mpn="BUDGET-1"))

    selects = counted.matching("select price_breaks")
    assert selects == [], (
        "the listing's existing price breaks were loaded into ORM objects and "
        f"then deleted unread ({len(selects)} SELECT(s)); the lookup needs "
        "noload on PartListing.price_breaks"
    )


def test_refreshing_a_listing_still_replaces_the_breaks(db, part_with_offers):
    """The optimisation must not turn into "stopped writing price breaks"."""
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
