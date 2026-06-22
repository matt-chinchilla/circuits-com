"""Tier↔placement matrix (2026-06-11 board redesign) — Python-side enforcement.

The new matrix (LOCKED):
  - Top-level category (``parent_id IS NULL``) ⇒ **platinum** only, single-slot.
  - Subcategory (child) ⇒ **gold** (single-slot) or **silver** (multi).
  - Keyword (``category_id IS NULL``) ⇒ **silver** or **gold** (multi).

These tests hit the Python validator ``_validate_tier_placement`` and the
single-slot BLOCK (``_reject_if_slot_taken``) directly (both run on SQLite). The
Postgres trigger + migration-016 partial unique indexes that mirror this matrix
at the DB level are verified separately on PG — SQLite ignores both.
"""

import uuid

import pytest
from fastapi import HTTPException

from app.models import Category, Supplier
from app.routes.admin_sponsors import _validate_tier_placement

# --- fixtures (adapt conftest's db/client/seeded_db to this module's needs) ---


@pytest.fixture
def top_category(db):
    """A top-level category (``parent_id IS NULL``)."""
    cat = Category(id=uuid.uuid4(), name="Sensors", slug="sensors", icon="gauge", sort_order=0)
    db.add(cat)
    db.flush()
    return cat


@pytest.fixture
def child_category(db, top_category):
    """A subcategory (child of ``top_category``)."""
    cat = Category(
        id=uuid.uuid4(),
        name="Temperature Sensors",
        slug="temperature-sensors",
        icon="thermometer",
        parent_id=top_category.id,
        sort_order=0,
    )
    db.add(cat)
    db.flush()
    return cat


@pytest.fixture
def two_suppliers(db):
    """Two suppliers usable as sponsors."""
    a = Supplier(id=uuid.uuid4(), name="Alpha Components", website="alpha.com")
    b = Supplier(id=uuid.uuid4(), name="Beta Distribution", website="beta.com")
    db.add_all([a, b])
    db.flush()
    return a, b


@pytest.fixture
def three_suppliers(db):
    """Three suppliers usable as sponsors (tier-change single-slot scenarios)."""
    a = Supplier(id=uuid.uuid4(), name="Alpha Components", website="alpha.com")
    b = Supplier(id=uuid.uuid4(), name="Beta Distribution", website="beta.com")
    c = Supplier(id=uuid.uuid4(), name="Gamma Supply", website="gamma.com")
    db.add_all([a, b, c])
    db.flush()
    return a, b, c


@pytest.fixture
def admin_user(db):
    """Seed the admin login used by ``admin_client``."""
    import bcrypt

    from app.models import User

    hashed = bcrypt.hashpw(b"testpass123", bcrypt.gensalt()).decode()
    user = User(id=uuid.uuid4(), username="admin", password_hash=hashed, role="admin")
    db.add(user)
    db.flush()
    return user


@pytest.fixture
def admin_client(client, admin_user):
    """An authed TestClient: injects the admin Bearer token on every request."""
    token = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    ).json()["token"]
    client.headers.update({"Authorization": f"Bearer {token}"})
    return client


# --- Task 1.1: validator → new matrix ---------------------------------------


def test_top_level_requires_platinum(db, top_category):
    with pytest.raises(HTTPException) as ei:
        _validate_tier_placement(db, "featured", top_category.id)
    assert ei.value.status_code == 422
    _validate_tier_placement(db, "platinum", top_category.id)  # ok, no raise


def test_subcategory_requires_gold_or_silver(db, child_category):
    for ok in ("gold", "silver"):
        _validate_tier_placement(db, ok, child_category.id)  # ok
    with pytest.raises(HTTPException) as ei:
        _validate_tier_placement(db, "platinum", child_category.id)
    assert ei.value.status_code == 422


def test_keyword_rejects_platinum(db):
    for ok in ("silver", "gold"):
        _validate_tier_placement(db, ok, None)  # ok
    with pytest.raises(HTTPException) as ei:
        _validate_tier_placement(db, "platinum", None)
    assert ei.value.status_code == 422


# --- Task 1.2: single-slot BLOCK (incumbent wins) ---------------------------


def test_second_platinum_blocked_incumbent_kept(admin_client, top_category, two_suppliers):
    """Platinum top-level slot is single-occupant: a 2nd Platinum is BLOCKED (409)
    and the incumbent (a) keeps the slot. (2026-06-22 BLOCK policy — was supersede,
    where the newest won.)"""
    a, b = two_suppliers
    r1 = admin_client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(a.id), "category_id": str(top_category.id), "tier": "platinum"},
    )
    assert r1.status_code == 200, r1.text
    r2 = admin_client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(b.id), "category_id": str(top_category.id), "tier": "platinum"},
    )
    assert r2.status_code == 409, r2.text
    active = [
        s
        for s in admin_client.get("/api/admin/sponsors/").json()
        if s["category_id"] == str(top_category.id) and s["status"] != "Expired"
    ]
    assert len(active) == 1 and active[0]["supplier_id"] == str(a.id)


def test_silver_does_not_supersede_and_coexists(admin_client, child_category, two_suppliers):
    a, b = two_suppliers
    r1 = admin_client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(a.id), "category_id": str(child_category.id), "tier": "silver"},
    )
    r2 = admin_client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(b.id), "category_id": str(child_category.id), "tier": "silver"},
    )
    assert r1.status_code == 200 and r2.status_code == 200, (r1.text, r2.text)
    active = [
        s
        for s in admin_client.get("/api/admin/sponsors/").json()
        if s["category_id"] == str(child_category.id) and s["status"] != "Expired"
    ]
    assert len(active) == 2


def test_tier_only_patch_to_gold_blocked_by_existing_gold(
    admin_client, child_category, three_suppliers
):
    """Regression: a tier-only PATCH (Silver→Gold) on a child that already has an
    active Gold sponsor is BLOCKED (409) — single-slot occupancy is re-asserted on
    tier change, not just on category change, and the incumbent Gold keeps the slot.
    The block runs BEFORE the update is applied, so the patched row stays Silver."""
    a, _b, c = three_suppliers
    # Pre-existing Gold on the child (supplier c) — the incumbent.
    gold = admin_client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(c.id), "category_id": str(child_category.id), "tier": "gold"},
    )
    # A Silver on the same child (supplier a) — coexists initially.
    silver = admin_client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(a.id), "category_id": str(child_category.id), "tier": "silver"},
    )
    assert gold.status_code == 200 and silver.status_code == 200, (gold.text, silver.text)

    # Promote the Silver row to Gold on the SAME child (tier-only PATCH) → 409.
    patched = admin_client.patch(
        f"/api/admin/sponsors/{silver.json()['id']}", json={"tier": "gold"}
    )
    assert patched.status_code == 409, patched.text

    rows = admin_client.get("/api/admin/sponsors/").json()
    by_id = {r["id"]: r for r in rows}
    # The incumbent Gold (supplier c) is untouched (not superseded).
    assert by_id[gold.json()["id"]]["status"] != "Expired"
    # The PATCH was rejected before applying — the row stays Silver.
    assert (by_id[silver.json()["id"]]["tier"] or "").lower() == "silver"


def test_tier_only_patch_to_silver_does_not_supersede(
    admin_client, child_category, three_suppliers
):
    """Regression: downgrading a Gold child-sponsor to Silver (multi-occupant)
    must NOT Expire other sponsors — a second coexisting Silver stays Active."""
    a, b, _c = three_suppliers
    # Gold on the child (supplier a).
    gold = admin_client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(a.id), "category_id": str(child_category.id), "tier": "gold"},
    )
    # A coexisting Silver on the same child (supplier b).
    silver = admin_client.post(
        "/api/admin/sponsors/",
        json={"supplier_id": str(b.id), "category_id": str(child_category.id), "tier": "silver"},
    )
    assert gold.status_code == 200 and silver.status_code == 200, (gold.text, silver.text)

    # Downgrade the Gold row to Silver (tier-only PATCH) — Silver never supersedes.
    patched = admin_client.patch(
        f"/api/admin/sponsors/{gold.json()['id']}", json={"tier": "silver"}
    )
    assert patched.status_code == 200, patched.text

    active = [
        r
        for r in admin_client.get("/api/admin/sponsors/").json()
        if r["category_id"] == str(child_category.id) and r["status"] != "Expired"
    ]
    # Both the (now-Silver) downgraded row and the pre-existing Silver coexist.
    assert len(active) == 2
    assert {r["supplier_id"] for r in active} == {str(a.id), str(b.id)}
    assert all((r["tier"] or "").lower() == "silver" for r in active)
