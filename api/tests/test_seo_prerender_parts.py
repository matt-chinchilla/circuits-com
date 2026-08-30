"""GET /api/seo/prerender-parts — the capped, ranked slice the build prerenders.

The build-time SEO prerender writes one HTML file per route. At 270k+ parts an
uncapped manifest produces a dist/ no deploy can carry, so this endpoint decides
which parts earn a static document. Two things must hold, and each test below
pins exactly one of them:

* the cap is enforced by the SERVER, not by the caller's good manners, and
* the ranking puts the pages worth having first — a photo AND a price, then
  stock, then recency.

Every ranking test is built so that breaking its own ORDER BY term flips the
expected order (verified by mutation): drop the featured term and the
huge-stock unfeatured part leads; reverse stock and the sparse part leads;
reverse recency and the older part leads.
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.models import Category, Part, PartListing, Supplier
from app.routes.sitemap import PRERENDER_PART_LIMIT

_BASE = datetime(2026, 1, 1, tzinfo=UTC)


def _part(db, sku, *, stock=None, image=True, price="1.0000", age_days=0):
    """One part plus the listing carrying its stock.

    `best_price` is set directly because it is a denormalized column on parts
    (maintained by part_pricing.refresh_best_prices), not something the
    endpoint recomputes.
    """
    part = Part(
        id=uuid.uuid4(),
        sku=sku,
        slug=sku.lower(),
        manufacturer_name="Acme Semiconductor",
        description=f"{sku} description",
        image_url=f"https://cdn.example.test/{sku}.jpg" if image else None,
        best_price=Decimal(price) if price is not None else None,
        created_at=_BASE - timedelta(days=age_days),
        lifecycle_status="active",
    )
    db.add(part)
    db.flush()
    if stock is not None:
        supplier = db.query(Supplier).first()
        if supplier is None:
            supplier = Supplier(id=uuid.uuid4(), name="Acme Distribution")
            db.add(supplier)
            db.flush()
        db.add(
            PartListing(
                id=uuid.uuid4(),
                part_id=part.id,
                supplier_id=supplier.id,
                stock_quantity=stock,
                unit_price=Decimal("1.0000"),
            )
        )
        db.flush()
    return part


def _slugs(client, **params):
    resp = client.get("/api/seo/prerender-parts", params=params)
    assert resp.status_code == 200, resp.text
    return [p["slug"] for p in resp.json()["parts"]]


def test_a_photo_and_a_price_outrank_far_deeper_stock(db, client):
    """The featured tier is the FIRST sort term, so it beats any stock figure.

    A part with a photo and a price renders a real Product page; one without
    renders a thin stub however much of it is on the shelf.
    """
    _part(db, "SPARSE", stock=1, image=True, price="2.5000")
    _part(db, "DEEP", stock=9_000_000, image=False, price=None)
    db.commit()

    assert _slugs(client) == ["sparse", "deep"]


def test_a_photo_without_a_price_is_not_featured(db, client):
    """The tier needs BOTH facts — an unpriced photo is still a thin page.

    Pins the AND: with an OR, the priceless-but-photographed part would join
    the featured tier and lead on its stock.
    """
    _part(db, "PRICED", stock=1, image=True, price="2.5000")
    _part(db, "PHOTOONLY", stock=9_000_000, image=True, price=None)
    db.commit()

    assert _slugs(client) == ["priced", "photoonly"]


def test_stock_orders_the_featured_tier_deepest_first(db, client):
    """Within one tier, stock descending is the proxy for "actually buyable"."""
    _part(db, "SHALLOW", stock=5, image=True, price="1.0000")
    _part(db, "DEEPEST", stock=5000, image=True, price="1.0000")
    _part(db, "MIDDLE", stock=500, image=True, price="1.0000")
    db.commit()

    assert _slugs(client) == ["deepest", "middle", "shallow"]


def test_the_newest_part_wins_a_stock_tie(db, client):
    """Recency breaks ties so a fresh import is not locked out behind old rows."""
    _part(db, "ELDER", stock=100, age_days=30)
    _part(db, "NEWEST", stock=100, age_days=0)
    _part(db, "MIDAGE", stock=100, age_days=10)
    db.commit()

    assert _slugs(client) == ["newest", "midage", "elder"]


def test_a_part_with_no_listings_ranks_as_zero_stock_not_missing(db, client):
    """No listing row is zero stock, not an excluded part.

    The aggregate is an outer join; an inner one would silently drop every
    part no distributor lists yet.
    """
    _part(db, "UNLISTED", stock=None)
    _part(db, "LISTED", stock=1)
    db.commit()

    assert _slugs(client) == ["listed", "unlisted"]


def test_the_server_refuses_a_limit_above_the_cap(db, client):
    """The cap is a server-side ceiling — a caller cannot ask past it."""
    resp = client.get("/api/seo/prerender-parts", params={"limit": PRERENDER_PART_LIMIT + 1})
    assert resp.status_code == 422


def test_the_limit_bounds_the_rows_returned(db, client):
    """A smaller limit is honoured, and the rows kept are the top-ranked ones."""
    for i in range(5):
        _part(db, f"PART{i}", stock=i * 10)
    db.commit()

    assert _slugs(client, limit=2) == ["part4", "part3"]


def test_a_part_without_a_slug_is_never_offered(db, client):
    """The prerender keys its output path on the slug — a null one has no file."""
    part = _part(db, "SLUGLESS", stock=10_000)
    part.slug = None
    db.commit()

    assert _slugs(client) == []


def test_every_field_the_manifest_reads_is_present(db, client):
    """The manifest's part entries are built from exactly these keys."""
    _part(db, "LM7805CT", stock=10)
    db.commit()

    row = client.get("/api/seo/prerender-parts").json()["parts"][0]
    assert set(row) == {
        "slug",
        "sku",
        "manufacturer_name",
        "description",
        "best_price",
        "category_name",
        "category_slug",
        "parent_category_slug",
    }
    # Numeric(10, 4) arrives as Decimal, which the JSON encoder cannot take —
    # the route casts it, so a client reads a number rather than a 500.
    assert row["best_price"] == pytest.approx(1.0)


def test_the_category_columns_come_from_the_nested_taxonomy(db, client):
    """Part pages link back through parent/child, so both slugs must resolve."""
    parent = Category(id=uuid.uuid4(), name="Integrated Circuits", slug="ics")
    db.add(parent)
    db.flush()
    child = Category(id=uuid.uuid4(), name="Voltage Regulators", slug="regs", parent_id=parent.id)
    db.add(child)
    db.flush()
    part = _part(db, "LM7805CT", stock=10)
    part.category_id = child.id
    db.commit()

    row = client.get("/api/seo/prerender-parts").json()["parts"][0]
    assert row["category_name"] == "Voltage Regulators"
    assert row["category_slug"] == "regs"
    assert row["parent_category_slug"] == "ics"
