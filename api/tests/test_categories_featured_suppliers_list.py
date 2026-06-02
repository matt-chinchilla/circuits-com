"""Tests for the multi-featured-supplier list on category list responses.

Background (2026-06-02): the admin /admin/categories tree previously surfaced
only a single `featured_supplier_name` per category. With Featured tier now
allowed to attach multiple suppliers to one category (PreferredPartnersBanner
renders them all), the API needs to expose the full ordered list — rank ASC,
lowest rank = highest priority. Back-compat: the legacy single-name field
stays in place alongside the new list.
"""
import uuid

from app.models import Category, CategorySupplier, Supplier


def test_list_categories_includes_featured_suppliers_list(client, seeded_db):
    """Single Featured CategorySupplier → list contains exactly that supplier."""
    response = client.get("/api/categories/")
    assert response.status_code == 200
    data = response.json()
    parent = data[0]

    # Parent has no Featured CategorySupplier — must be an empty list, NOT
    # missing (frontend keys off the property).
    assert "featured_suppliers" in parent
    assert parent["featured_suppliers"] == []

    # Child (clock-and-timing) has Kennedy Electronics is_featured=True.
    # Each entry is an {id, name} object so the admin Unfeature button can
    # target the exact supplier row (names alone collide).
    child = parent["children"][0]
    assert "featured_suppliers" in child
    assert [s["name"] for s in child["featured_suppliers"]] == ["Kennedy Electronics"]
    assert all(s.get("id") for s in child["featured_suppliers"])

    # Back-compat: legacy single-name field continues to surface the top pick.
    assert child["featured_supplier_name"] == "Kennedy Electronics"


def test_featured_suppliers_list_is_rank_sorted(client, db):
    """Multiple Featured CategorySuppliers on one category → list ordered by
    rank ASC (lowest rank = highest priority = first in list).
    """
    # Build a minimal parent + child manually so we control rank values.
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

    # Three suppliers, all Featured on the child, with shuffled ranks.
    # Expected sort order (rank ASC): Bravo(0) → Alpha(2) → Charlie(5).
    alpha = Supplier(id=uuid.uuid4(), name="Alpha Components")
    bravo = Supplier(id=uuid.uuid4(), name="Bravo Semi")
    charlie = Supplier(id=uuid.uuid4(), name="Charlie Devices")
    db.add_all([alpha, bravo, charlie])
    db.flush()

    db.add_all([
        CategorySupplier(category_id=child.id, supplier_id=alpha.id, is_featured=True, rank=2),
        CategorySupplier(category_id=child.id, supplier_id=bravo.id, is_featured=True, rank=0),
        CategorySupplier(category_id=child.id, supplier_id=charlie.id, is_featured=True, rank=5),
        # Non-featured row should be EXCLUDED from the list.
        CategorySupplier(
            category_id=child.id,
            supplier_id=alpha.id,  # same supplier, separate row would violate PK;
            is_featured=False,
            rank=99,
        ) if False else CategorySupplier(
            category_id=parent.id,  # attach an unrelated non-featured row instead
            supplier_id=alpha.id,
            is_featured=False,
            rank=99,
        ),
    ])
    db.commit()

    response = client.get("/api/categories/")
    assert response.status_code == 200
    data = response.json()
    # Find our parent — order isn't guaranteed against the seeded fixture's
    # parent, but here `db` is the bare fixture so this is the only one.
    parent_row = next(c for c in data if c["slug"] == "power-management-ics-pmics")
    child_row = next(c for c in parent_row["children"] if c["slug"] == "ldo-regulators")

    assert [s["name"] for s in child_row["featured_suppliers"]] == [
        "Bravo Semi",
        "Alpha Components",
        "Charlie Devices",
    ]
    # IDs are carried alongside names (string-serialized UUIDs).
    assert [s["id"] for s in child_row["featured_suppliers"]] == [
        str(bravo.id),
        str(alpha.id),
        str(charlie.id),
    ]
    # Parent has only a non-featured row → empty list.
    assert parent_row["featured_suppliers"] == []
