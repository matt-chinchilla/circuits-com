"""GET /api/categories/{slug}/partners — the top-level Category Sponsor banner.

The banner is a TOP-LEVEL-category artifact: a child slug resolves to its parent,
so every subpage shows the same partners. Platinum sponsor only (top-level tier;
2026-06-11 tier-boards matrix — was Featured). Platinum is single-slot, so a
second Platinum on the same category supersedes the first.
"""


def _auth(client):
    token = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _feature(client, headers, supplier_id, category_id):
    return client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(supplier_id),
            "category_id": str(category_id),
            "tier": "platinum",
            "status": "Active",
        },
        headers=headers,
    )


# --- service: get_category_partners (uses the conftest in-memory `db` session) ---


def test_partners_service_top_level_returns_featured(client, seeded_db, db):
    # NOTE: use the conftest `db` fixture (in-memory StaticPool engine), NOT
    # app.db.session.SessionLocal — the latter binds to the file DATABASE_URL
    # ("sqlite:///./test.db") and would NOT see the seeded in-memory data.
    from app.services.category_service import get_category_partners

    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    result = get_category_partners(db, parent.slug)
    assert result is not None
    assert result["slug"] == parent.slug
    assert result["platinum"] is not None
    assert result["platinum"]["supplier_name"] == "Avnet"


def test_partners_service_child_resolves_to_parent(client, seeded_db, db):
    from app.services.category_service import get_category_partners

    headers = _auth(client)
    sup, parent, child = seeded_db["supplier1"], seeded_db["parent"], seeded_db["child"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    result = get_category_partners(db, child.slug)
    assert result is not None
    # Child slug resolves to the parent's identity + the parent's Platinum board.
    assert result["slug"] == parent.slug
    assert result["name"] == parent.name
    assert result["platinum"] is not None
    assert result["platinum"]["supplier_name"] == "Avnet"


def test_partners_service_unknown_slug_returns_none(db):
    from app.services.category_service import get_category_partners

    assert get_category_partners(db, "nonexistent-slug") is None


# --- route: /{slug}/partners + ETag/304 ---


def test_partners_route_shape_and_no_cache(client, seeded_db):
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    r = client.get(f"/api/categories/{parent.slug}/partners")
    assert r.status_code == 200
    body = r.json()
    assert body["slug"] == parent.slug
    assert body["platinum"] is not None and body["platinum"]["supplier_name"] == "Avnet"
    cc = r.headers["cache-control"].lower()
    assert "no-cache" in cc and "max-age" not in cc
    assert r.headers.get("etag")


def test_partners_route_child_resolves_to_parent(client, seeded_db):
    headers = _auth(client)
    sup, parent, child = seeded_db["supplier1"], seeded_db["parent"], seeded_db["child"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    r = client.get(f"/api/categories/{child.slug}/partners")
    assert r.status_code == 200
    assert r.json()["slug"] == parent.slug


def test_partners_route_404_for_unknown(client, seeded_db):
    assert client.get("/api/categories/nope/partners").status_code == 404


def test_partners_etag_304_when_unchanged(client, seeded_db):
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]
    assert _feature(client, headers, sup.id, parent.id).status_code == 200

    r1 = client.get(f"/api/categories/{parent.slug}/partners")
    etag = r1.headers["etag"]
    r2 = client.get(f"/api/categories/{parent.slug}/partners", headers={"If-None-Match": etag})
    assert r2.status_code == 304
    assert r2.content == b""
    assert "no-cache" in r2.headers["cache-control"].lower()


def test_partners_etag_changes_after_mutation(client, seeded_db):
    """Anti-staleness guard: adding a sponsor changes the ETag, so an old
    If-None-Match no longer 304s. Proves inc1's freshness invariant survives."""
    headers = _auth(client)
    a, b, parent = seeded_db["supplier1"], seeded_db["supplier2"], seeded_db["parent"]
    assert _feature(client, headers, a.id, parent.id).status_code == 200

    etag1 = client.get(f"/api/categories/{parent.slug}/partners").headers["etag"]
    assert _feature(client, headers, b.id, parent.id).status_code == 200
    r = client.get(f"/api/categories/{parent.slug}/partners", headers={"If-None-Match": etag1})
    assert r.status_code == 200
    assert r.headers["etag"] != etag1
