"""Sponsor-over-supplier brand-color precedence + brand_takeover (Task 2, spec 2026-07-10).

Public sponsor payloads (`/partners` board + keyword lookup) resolve
`brand_primary`/`brand_secondary` as `sponsor value or supplier value`, and
carry a `brand_takeover: bool` flag so the frontend can tell an explicit
sponsor override apart from the supplier-color fallback.
"""

import uuid

from app.models import Sponsor, Supplier


def _auth(client):
    token = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_partners_supplier_fallback_no_takeover(client, tier_boards, seeded_db):
    # tier_boards' Platinum sponsor (parent2) is sourced from supplier1, and
    # carries no brand colors of its own — the board must fall back to
    # supplier1's brand_primary ("#c00000" per conftest) with no takeover.
    parent2 = tier_boards["parent2"]
    supplier1 = seeded_db["supplier1"]
    p = client.get(f"/api/categories/{parent2.slug}/partners").json()["platinum"]
    assert p["brand_primary"] == supplier1.brand_primary
    assert p["brand_takeover"] is False


def test_partners_sponsor_overrides_supplier(client, seeded_db):
    # `parent` has no Platinum sponsor in the base fixture (see
    # test_partners_none_when_no_platinum) — feature one with its own
    # brand_primary, distinct from supplier1's ("#c00000").
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]
    res = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup.id),
            "category_id": str(parent.id),
            "tier": "Platinum",
            "status": "Active",
            "brand_primary": "#112233",
        },
        headers=headers,
    )
    assert res.status_code == 200, res.text

    p = client.get(f"/api/categories/{parent.slug}/partners").json()["platinum"]
    assert p["brand_primary"] == "#112233"
    assert p["brand_primary"] != sup.brand_primary
    assert p["brand_takeover"] is True


def test_keyword_sponsor_carries_brand_fields(db, client):
    # Route returns ONE sponsor object (query .first(), response_model=SponsorResponse).
    supplier = Supplier(id=uuid.uuid4(), name="Brand Co", brand_primary="#0a4a2e")
    db.add(supplier)
    db.flush()
    sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=supplier.id,
        keyword="brand-fallback-kw",
        description="Keyword sponsor",
        tier="gold",
    )
    db.add(sponsor)
    db.commit()

    body = client.get("/api/sponsors/keyword/brand-fallback-kw").json()
    assert "brand_primary" in body
    assert "brand_takeover" in body
    # No sponsor-level override → falls back to the supplier's brand color.
    assert body["brand_primary"] == supplier.brand_primary
    assert body["brand_takeover"] is False
