"""Tests for parent-category supplier rollup (CSB v14).

On a parent category page, the suppliers list aggregates featured
suppliers from ALL immediate children (mirroring the parts rollup
implemented in `_build_popular_parts`). The supplier_service must:

- Aggregate CategorySupplier rows from `parent.id + [c.id for c in parent.children]`.
- Dedup by supplier.id (a supplier featured on multiple children appears once).
- When deduping, prefer is_featured=True; among featured rows, prefer lowest rank.
- Sort the final list by rank ascending.

Sub-category pages must retain existing single-category behavior
(no rollup), since their suppliers list IS the source of truth for
that subcategory.
"""

import uuid

import pytest

from app.models import Category, CategorySupplier, Supplier


@pytest.fixture
def rollup_db(db):
    """Parent category with 2 children; suppliers/links built per-test."""
    parent = Category(
        id=uuid.uuid4(),
        name="Power Management",
        slug="power-management",
        icon="lightning",
        sort_order=0,
    )
    db.add(parent)
    db.flush()

    child_a = Category(
        id=uuid.uuid4(),
        name="LDO Regulators",
        slug="ldo-regulators",
        icon="lightning",
        parent_id=parent.id,
        sort_order=0,
    )
    child_b = Category(
        id=uuid.uuid4(),
        name="DC-DC Converters",
        slug="dc-dc-converters",
        icon="lightning",
        parent_id=parent.id,
        sort_order=1,
    )
    db.add_all([child_a, child_b])
    db.flush()
    db.commit()

    return {"parent": parent, "child_a": child_a, "child_b": child_b}


def _make_supplier(db, name: str) -> Supplier:
    supplier = Supplier(
        id=uuid.uuid4(),
        name=name,
        phone="555-555-5555",
        website=f"{name.lower().replace(' ', '')}.example.com",
        email=f"info@{name.lower().replace(' ', '')}.example.com",
    )
    db.add(supplier)
    db.flush()
    return supplier


def test_parent_cat_aggregates_child_suppliers(client, db, rollup_db):
    """Parent page surfaces featured suppliers from both children."""
    parent = rollup_db["parent"]
    child_a = rollup_db["child_a"]
    child_b = rollup_db["child_b"]

    supplier_a = _make_supplier(db, "Acme Components")
    supplier_b = _make_supplier(db, "Beta Distributors")

    db.add_all(
        [
            CategorySupplier(
                category_id=child_a.id, supplier_id=supplier_a.id, is_featured=True, rank=0
            ),
            CategorySupplier(
                category_id=child_b.id, supplier_id=supplier_b.id, is_featured=True, rank=0
            ),
        ]
    )
    db.commit()

    response = client.get(f"/api/categories/{parent.slug}")
    assert response.status_code == 200
    data = response.json()

    supplier_names = {s["name"] for s in data["suppliers"]}
    assert "Acme Components" in supplier_names
    assert "Beta Distributors" in supplier_names


def test_dedup_supplier_featured_on_multiple_children(client, db, rollup_db):
    """A supplier featured on multiple children appears ONCE in the rollup."""
    parent = rollup_db["parent"]
    child_a = rollup_db["child_a"]
    child_b = rollup_db["child_b"]

    shared = _make_supplier(db, "Shared Supplier")

    db.add_all(
        [
            CategorySupplier(
                category_id=child_a.id, supplier_id=shared.id, is_featured=True, rank=2
            ),
            CategorySupplier(
                category_id=child_b.id, supplier_id=shared.id, is_featured=True, rank=0
            ),
        ]
    )
    db.commit()

    response = client.get(f"/api/categories/{parent.slug}")
    assert response.status_code == 200
    data = response.json()

    matches = [s for s in data["suppliers"] if s["name"] == "Shared Supplier"]
    assert len(matches) == 1, f"expected 1 entry, got {len(matches)}: {matches}"


def test_sub_cat_unchanged(client, db, rollup_db):
    """Sub-category page lists ONLY its own suppliers (no rollup applied)."""
    child_a = rollup_db["child_a"]
    child_b = rollup_db["child_b"]

    supplier_a = _make_supplier(db, "Only on A")
    supplier_b = _make_supplier(db, "Only on B")

    db.add_all(
        [
            CategorySupplier(
                category_id=child_a.id, supplier_id=supplier_a.id, is_featured=True, rank=0
            ),
            CategorySupplier(
                category_id=child_b.id, supplier_id=supplier_b.id, is_featured=True, rank=0
            ),
        ]
    )
    db.commit()

    response = client.get(f"/api/categories/{child_a.slug}")
    assert response.status_code == 200
    data = response.json()

    supplier_names = {s["name"] for s in data["suppliers"]}
    assert supplier_names == {"Only on A"}, (
        f"sub-category must not pull siblings' suppliers; got {supplier_names}"
    )


def test_parent_with_no_children_suppliers(client, db, rollup_db):
    """Parent with no suppliers anywhere in its subtree returns empty list."""
    parent = rollup_db["parent"]

    response = client.get(f"/api/categories/{parent.slug}")
    assert response.status_code == 200
    data = response.json()

    assert data["suppliers"] == []
