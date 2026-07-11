"""Migration 014 — Supplier brand-color fields exposed on create/update/read.

`Supplier.brand_primary/brand_secondary` columns already exist (they feed the
Platinum/Gold/Silver sponsor-board brand-takeover fallback), but the admin
create/update schemas never accepted them and `supplier_to_dict` never
serialized them — the admin brand-color picker had nothing to write to.
Mirrors `test_supplier_board_fields.py`'s round-trip pattern for
contact_role/coverage_hours.
"""


def _auth_header(client):
    resp = client.post("/api/auth/login", json={"username": "admin", "password": "testpass123"})
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def test_create_supplier_round_trips_brand_colors(client, seeded_db):
    headers = _auth_header(client)
    resp = client.post(
        "/api/suppliers/",
        json={
            "name": "Brand Colors Co",
            "brand_primary": "#1d3a8f",
            "brand_secondary": "#c45a16",
        },
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["brand_primary"] == "#1d3a8f"
    assert data["brand_secondary"] == "#c45a16"

    # Re-fetch via the detail route → fields persisted + serialize back out.
    got = client.get(f"/api/suppliers/{data['id']}").json()
    assert got["brand_primary"] == "#1d3a8f"
    assert got["brand_secondary"] == "#c45a16"


def test_update_supplier_sets_brand_colors(client, seeded_db):
    headers = _auth_header(client)
    created = client.post(
        "/api/suppliers/", json={"name": "Update Brand Co"}, headers=headers
    ).json()
    assert created["brand_primary"] is None
    assert created["brand_secondary"] is None

    resp = client.put(
        f"/api/suppliers/{created['id']}",
        json={
            "brand_primary": "#0a4a2e",
            "brand_secondary": "#44bd13",
        },
        headers=headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["brand_primary"] == "#0a4a2e"
    assert data["brand_secondary"] == "#44bd13"


def test_supplier_brand_color_rejects_invalid_hex(client, seeded_db):
    headers = _auth_header(client)
    r = client.post(
        "/api/suppliers/",
        json={"name": "Bad Brand Co", "brand_primary": "#zzz"},
        headers=headers,
    )
    assert r.status_code == 422, r.text
