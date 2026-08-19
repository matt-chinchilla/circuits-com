"""Guard: `SEED_DEMO_CATALOG` keeps the fictional demo companies out of prod.

The api entrypoint runs `python -m app.db.seed` on EVERY container start, so
before this flag existed an owner who deleted "Kennedy Electronics" or "Mike's
Electric" in /admin got them back on the next deploy — permanently. The flag is
a data-hygiene switch, and its two failure modes are both severe:

  * A missed reference — `suppliers["Kennedy Electronics"]` — raises KeyError
    inside the entrypoint, so the api container never reaches uvicorn and prod
    502-loops. The "seed completes" assertions here are the point, not ceremony.
  * The flag DELETING rows rather than merely not creating them. Seeding is
    get-or-create; flipping it off on prod (which holds demo rows TODAY) must
    leave every existing row exactly where it is until a human removes it.

Each test pays for a full seed (~40s: 3,555 catalog parts), so the assertions
are grouped into the two scenarios that matter — a fresh prod-shaped DB, and
the flip-the-flag-on-an-existing-DB upgrade path — rather than one seed each.
"""

import pytest

from app.config import settings
from app.db.seed import _DEMO_SUPPLIER_NAMES, seed
from app.models import (
    Category,
    CategorySupplier,
    Part,
    PartListing,
    PriceBreak,
    Revenue,
    Sponsor,
    Supplier,
    User,
)

# A distributor from the REAL list — seeds under either setting.
_REAL_SUPPLIER = "Mouser Electronics"


@pytest.fixture
def demo_catalog(monkeypatch):
    """Set the flag the way an environment's compose file would."""

    def _set(enabled: bool) -> None:
        monkeypatch.setattr(settings, "SEED_DEMO_CATALOG", enabled)

    return _set


def _supplier_names(db) -> set[str]:
    return {str(row[0]) for row in db.query(Supplier.name).all()}


def _demo_sponsor_count(db) -> int:
    return (
        db.query(Sponsor)
        .join(Supplier, Sponsor.supplier_id == Supplier.id)
        .filter(Supplier.name.in_(list(_DEMO_SUPPLIER_NAMES)))
        .count()
    )


def _delete_supplier(db, supplier) -> None:
    """What /admin's delete does — the 8-surface cascade from CLAUDE.md.

    A demo supplier is not inert: the seed hands it part listings and 12 months
    of revenue, so a bare `db.delete()` trips the FK.
    """
    listing_ids = [
        row[0] for row in db.query(PartListing.id).filter(PartListing.supplier_id == supplier.id)
    ]
    if listing_ids:
        db.query(PriceBreak).filter(PriceBreak.listing_id.in_(listing_ids)).delete(
            synchronize_session=False
        )
        db.query(PartListing).filter(PartListing.supplier_id == supplier.id).delete(
            synchronize_session=False
        )
    for model in (Sponsor, CategorySupplier, Revenue):
        db.query(model).filter(model.supplier_id == supplier.id).delete(synchronize_session=False)
    db.query(User).filter(User.supplier_id == supplier.id).update(
        {User.supplier_id: None}, synchronize_session=False
    )
    # Bulk delete + lazy="selectin" → "Dependency rule tried to blank-out
    # primary key" on the parent delete without this expire (CLAUDE.md).
    db.expire(supplier)
    db.delete(supplier)
    db.commit()


def test_a_prod_shaped_seed_completes_with_the_real_catalog_only(db, demo_catalog):
    demo_catalog(False)

    seed(db)  # must not raise — a KeyError here is a prod 502 loop

    names = _supplier_names(db)
    assert not (names & _DEMO_SUPPLIER_NAMES), (
        f"fictional companies seeded with the flag off: {sorted(names & _DEMO_SUPPLIER_NAMES)}"
    )
    assert _demo_sponsor_count(db) == 0, "no showcase sponsorship may reference a demo company"

    # The real catalog is untouched by the flag.
    assert _REAL_SUPPLIER in names
    assert db.query(Part).count() > 0
    assert db.query(Sponsor).count() > 0, (
        "the real distributors' Silver + keyword sponsorships still seed"
    )

    # Shared association lists: PMICs is Kennedy + 4 real distributors, Sensor
    # ICs is 4 real + Honeywell Sensing. Dropping the demo entry from a list
    # must not drop its neighbours.
    for slug, expected in (("power-management-ics-pmics", 4), ("sensor-ics", 4)):
        cat = db.query(Category).filter(Category.slug == slug).first()
        assert cat is not None
        rows = db.query(CategorySupplier).filter(CategorySupplier.category_id == cat.id).count()
        assert rows == expected, f"{slug}: expected {expected} associations, got {rows}"

    # Kennedy headlined both Platinum flagships; unsold is the DESIGNED state
    # (the Open-Placement pitch board), not a crash.
    pmics = db.query(Category).filter(Category.slug == "power-management-ics-pmics").first()
    assert db.query(Sponsor).filter(Sponsor.category_id == pmics.id).count() == 0


def test_flipping_the_flag_off_preserves_rows_but_stops_resurrecting_them(db, demo_catalog):
    """The prod upgrade path. Prod's DB already holds the demo companies, and
    the owner's complaint is that deleting one doesn't stick."""
    demo_catalog(True)
    seed(db)

    assert "Kennedy Electronics" in _supplier_names(db), "default-True still seeds the demo set"
    sponsors_before = _demo_sponsor_count(db)
    assert sponsors_before > 0, "default-True still seeds the showcase sponsorships"

    mikes = db.query(Supplier).filter(Supplier.name == "Mike's Electric").first()
    assert mikes is not None
    _delete_supplier(db, mikes)  # the owner's /admin deletion
    suppliers_after_delete = db.query(Supplier).count()

    demo_catalog(False)
    seed(db)  # the next container start

    assert db.query(Supplier).filter(Supplier.name == "Mike's Electric").first() is None, (
        "the seed resurrected a company the owner deleted — the whole point of the flag"
    )
    # ...and it deleted nothing of its own: the untouched demo rows are still here.
    assert db.query(Supplier).filter(Supplier.name == "Kennedy Electronics").first() is not None
    assert _demo_sponsor_count(db) == sponsors_before
    assert db.query(Supplier).count() == suppliers_after_delete
