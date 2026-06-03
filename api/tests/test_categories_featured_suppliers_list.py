"""Tests for the multi-featured-supplier list on category list responses.

Background (2026-06-03): `featured_suppliers` is now sourced from the `sponsors`
table (single source of truth), not the dropped `CategorySupplier.is_featured`
flag. A category's list = its active sponsorships, ordered by tier priority
(Featured > Platinum > Gold > Silver) then recency. Each entry is an {id, name}
object; the legacy single-name `featured_supplier_name` field stays alongside.
"""

import uuid
from datetime import UTC, datetime

from app.models import Category, Sponsor, Supplier


def test_list_categories_includes_featured_suppliers_list(client, seeded_db):
    """Single sponsorship → list contains exactly that supplier."""
    response = client.get("/api/categories/")
    assert response.status_code == 200
    data = response.json()
    parent = data[0]

    # Parent (integrated-circuits) has no sponsor — must be an empty list, NOT
    # missing (frontend keys off the property).
    assert "featured_suppliers" in parent
    assert parent["featured_suppliers"] == []

    # Child (clock-and-timing) has a Kennedy Gold sponsor. Each entry is an
    # {id, name} object so the admin can target the exact supplier row.
    child = parent["children"][0]
    assert "featured_suppliers" in child
    assert [s["name"] for s in child["featured_suppliers"]] == ["Kennedy Electronics"]
    assert all(s.get("id") for s in child["featured_suppliers"])

    # Back-compat: legacy single-name field continues to surface the top pick.
    assert child["featured_supplier_name"] == "Kennedy Electronics"


def test_featured_suppliers_list_is_tier_then_recency_sorted(client, db):
    """Multiple sponsorships on one category → ordered by tier priority then
    created_at (Platinum before Gold; within a tier, older first).
    """
    parent = Category(
        id=uuid.uuid4(),
        name="Power Management ICs",
        slug="power-management-ics-pmics",
        icon="lightning",
        sort_order=0,
    )
    db.add(parent)
    db.flush()

    child = Category(
        id=uuid.uuid4(),
        name="LDO Regulators",
        slug="ldo-regulators",
        icon="battery-charging",
        parent_id=parent.id,
        sort_order=0,
    )
    db.add(child)
    db.flush()

    alpha = Supplier(id=uuid.uuid4(), name="Alpha Components")
    bravo = Supplier(id=uuid.uuid4(), name="Bravo Semi")
    charlie = Supplier(id=uuid.uuid4(), name="Charlie Devices")
    db.add_all([alpha, bravo, charlie])
    db.flush()

    # On a child (subcategory) only Platinum/Gold are valid. Expected order:
    # Bravo (Platinum) → Alpha (Gold, older) → Charlie (Gold, newer).
    db.add_all([
        Sponsor(
            id=uuid.uuid4(), supplier_id=alpha.id, category_id=child.id,
            tier="Gold", status="Active", created_at=datetime(2026, 1, 1, tzinfo=UTC),
        ),
        Sponsor(
            id=uuid.uuid4(), supplier_id=bravo.id, category_id=child.id,
            tier="Platinum", status="Active", created_at=datetime(2026, 1, 2, tzinfo=UTC),
        ),
        Sponsor(
            id=uuid.uuid4(), supplier_id=charlie.id, category_id=child.id,
            tier="Gold", status="Active", created_at=datetime(2026, 1, 3, tzinfo=UTC),
        ),
    ])
    db.commit()

    data = client.get("/api/categories/").json()
    parent_row = next(c for c in data if c["slug"] == "power-management-ics-pmics")
    child_row = next(c for c in parent_row["children"] if c["slug"] == "ldo-regulators")

    assert [s["name"] for s in child_row["featured_suppliers"]] == [
        "Bravo Semi",       # Platinum (tier 1)
        "Alpha Components",  # Gold, created 2026-01-01
        "Charlie Devices",   # Gold, created 2026-01-03
    ]
    assert [s["id"] for s in child_row["featured_suppliers"]] == [
        str(bravo.id),
        str(alpha.id),
        str(charlie.id),
    ]
    # Parent has no sponsor → empty list.
    assert parent_row["featured_suppliers"] == []
