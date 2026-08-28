"""The customer console's KPI registry — one home for every chart the tile offers.

The console's second tile is a chart the CUSTOMER picks. That makes three
things true at once, and the registry exists so they cannot drift apart:

**A KPI is only offered to an account that can answer it.** "Top manufacturers
on my shelf" is a distributor's question and is meaningless to a maker; "who
distributes my parts" is the reverse. Capability is therefore part of the KPI's
definition, not a check the route remembers to write — and it is part of
VALIDITY too, so a maker naming ``stock_by_category`` is rejected exactly like a
misspelling.

**A stored key is a preference, not a promise.** ``users.dashboard_kpi`` is a
plain VARCHAR with no FK to anything. A key can outlive the registry entry it
named, and a customer who loses a link stops being able to answer a KPI they
already chose. Both cases fall back to the default rather than 500 or render a
blank panel, which is why :func:`resolve_kpi` takes the stored value rather
than trusting it.

**The default must be answerable by EVERYONE.** ``parts_by_category`` reads
through ``parts_visible_to``, which already handles both links, either link and
neither — so an unlinked account gets an empty series and a 200, never an
empty picker with a selection nothing offers.

Every builder scopes through ``app.services.account_scope``. None of them reads
``scope.supplier_id`` to decide WHETHER to filter; they read it to decide WHICH
join to walk, after their capability has already said the link is there.
"""

from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import distinct, func
from sqlalchemy.orm import Session

from app.models import Category, Manufacturer, Part, PartListing, Supplier
from app.services.account_scope import AccountScope, parts_visible_to

# How many bars the tile shows. A KPI is a headline, not a table — the console
# has a full catalog page for the long tail.
TOP_N = 8

# The one KPI every account can answer (see the module docstring).
DEFAULT_KPI = "parts_by_category"

# Capability tokens. ``ANY`` is not "no check" — it is the explicit statement
# that the builder's own scoping already covers every link combination.
ANY = "any"
SUPPLIER = "supplier"
MANUFACTURER = "manufacturer"


def _points(rows) -> list[dict]:
    """``(label, value)`` pairs -> the wire shape, biggest first, capped.

    Sorted in Python rather than SQL because two of the builders sum a NUMERIC
    (whose ORDER BY is fine) and two count (also fine) — but the tie-break on
    label is what makes the series STABLE across requests, and that is worth
    having identical in all five.
    """
    ordered = sorted(rows, key=lambda row: (-row[1], row[0] or ""))
    return [{"label": label or "Uncategorized", "value": value} for label, value in ordered[:TOP_N]]


def _int(value) -> int:
    return int(value or 0)


def _amount(value) -> float:
    """A NUMERIC sum reaches the wire as a float, at the scale it is stored.

    ``round`` rather than a bare ``float``: an inventory valuation is money on
    a customer's screen and 0.1 + 0.2 must not show up in it.
    """
    return round(float(value or 0), 2)


def _parts_by_category(db: Session, scope: AccountScope) -> list[dict]:
    """Where this caller's catalog sits in the taxonomy.

    ``parts_visible_to`` is the whole capability story here: a distributor's
    shelf, a maker's products, the union for an account holding both (counted
    ONCE — the predicate is a row filter on ``parts``, not a join), and nothing
    at all for a free account.
    """
    rows = (
        db.query(Category.name, func.count(distinct(Part.id)))
        .join(Part, Part.category_id == Category.id)
        .filter(parts_visible_to(scope))
        .group_by(Category.id, Category.name)
        .all()
    )
    return _points([(name, _int(count)) for name, count in rows])


def _manufacturers_by_parts(db: Session, scope: AccountScope) -> list[dict]:
    """The makers whose products this DISTRIBUTOR carries most of.

    The same join ``/api/account/manufacturers`` walks, mirrored rather than
    imported: a route function carries a response shape and a set of
    dependencies, and calling one from here would drag both into a chart.
    """
    rows = (
        db.query(Manufacturer.name, func.count(distinct(Part.id)))
        .join(Part, Part.manufacturer_id == Manufacturer.id)
        .join(PartListing, PartListing.part_id == Part.id)
        .filter(PartListing.supplier_id == scope.supplier_id)
        .group_by(Manufacturer.id, Manufacturer.name)
        .all()
    )
    return _points([(name, _int(count)) for name, count in rows])


def _distributors_by_parts(db: Session, scope: AccountScope) -> list[dict]:
    """The distributors stocking most of this MANUFACTURER's parts."""
    rows = (
        db.query(Supplier.name, func.count(distinct(Part.id)))
        .join(PartListing, PartListing.supplier_id == Supplier.id)
        .join(Part, Part.id == PartListing.part_id)
        .filter(Part.manufacturer_id == scope.manufacturer_id)
        .group_by(Supplier.id, Supplier.name)
        .all()
    )
    return _points([(name, _int(count)) for name, count in rows])


def _stock_by_category(db: Session, scope: AccountScope) -> list[dict]:
    """Units on this distributor's OWN shelf, by category.

    Filtered on ``part_listings.supplier_id`` rather than through
    ``parts_visible_to``: the quantity being summed belongs to one offer, and a
    both-links account summing every offer on its own parts would report
    competitors' inventory as its own.
    """
    rows = (
        db.query(Category.name, func.sum(PartListing.stock_quantity))
        .join(Part, Part.category_id == Category.id)
        .join(PartListing, PartListing.part_id == Part.id)
        .filter(PartListing.supplier_id == scope.supplier_id)
        .group_by(Category.id, Category.name)
        .all()
    )
    return _points([(name, _int(total)) for name, total in rows])


def _inventory_value_by_category(db: Session, scope: AccountScope) -> list[dict]:
    """Shelf value — unit price times units held — by category.

    ``unit_price`` is NOT NULL and ``stock_quantity`` defaults to 0, so the
    product is only NULL for a legacy row with an explicit NULL quantity; SUM
    skips those rather than poisoning the whole category.
    """
    rows = (
        db.query(Category.name, func.sum(PartListing.unit_price * PartListing.stock_quantity))
        .join(Part, Part.category_id == Category.id)
        .join(PartListing, PartListing.part_id == Part.id)
        .filter(PartListing.supplier_id == scope.supplier_id)
        .group_by(Category.id, Category.name)
        .all()
    )
    return _points([(name, _amount(total)) for name, total in rows])


@dataclass(frozen=True, slots=True)
class Kpi:
    """One selectable chart: its key, its label, who may ask it, how it is built."""

    key: str
    label: str
    capability: str
    builder: Callable[[Session, AccountScope], list[dict]]

    def available_to(self, scope: AccountScope) -> bool:
        if self.capability == SUPPLIER:
            return scope.is_supplier
        if self.capability == MANUFACTURER:
            return scope.is_manufacturer
        return True


# Registry order IS picker order. `parts_by_category` leads because it is the
# default and the only entry every account can answer.
KPIS: tuple[Kpi, ...] = (
    Kpi(DEFAULT_KPI, "Parts by category", ANY, _parts_by_category),
    Kpi("manufacturers_by_parts", "Manufacturers on my shelf", SUPPLIER, _manufacturers_by_parts),
    Kpi("distributors_by_parts", "Distributors stocking me", MANUFACTURER, _distributors_by_parts),
    Kpi("stock_by_category", "Stock by category", SUPPLIER, _stock_by_category),
    Kpi(
        "inventory_value_by_category",
        "Inventory value by category",
        SUPPLIER,
        _inventory_value_by_category,
    ),
)

KPIS_BY_KEY: dict[str, Kpi] = {kpi.key: kpi for kpi in KPIS}


def available_kpis(scope: AccountScope) -> list[Kpi]:
    """The KPIs this caller may choose from, in registry order."""
    return [kpi for kpi in KPIS if kpi.available_to(scope)]


def resolve_kpi(scope: AccountScope, stored: str | None) -> Kpi:
    """The KPI to RENDER for a stored preference — never a failure.

    Falls back to the default for a key that is NULL (never chosen), unknown
    (the registry moved on) or no longer capable (the account lost a link, or
    was linked differently when it chose). Selection is validated at the WRITE
    site; a read that 422s because of a row written months ago is a page the
    customer cannot open.
    """
    kpi = KPIS_BY_KEY.get((stored or "").strip())
    if kpi is None or not kpi.available_to(scope):
        return KPIS_BY_KEY[DEFAULT_KPI]
    return kpi


def selectable_kpi(scope: AccountScope, key: str | None) -> Kpi | None:
    """The KPI a caller may SELECT, or ``None`` when they may not.

    Capability is validity here, deliberately: silently storing a key the
    account cannot answer would leave the tile rendering the default while the
    picker claimed something else was chosen.
    """
    kpi = KPIS_BY_KEY.get((key or "").strip())
    if kpi is None or not kpi.available_to(scope):
        return None
    return kpi


def build_points(db: Session, scope: AccountScope, kpi: Kpi) -> list[dict]:
    """The series for one KPI. Empty is a legitimate answer, not an error."""
    if not kpi.available_to(scope):
        return []
    return kpi.builder(db, scope)
