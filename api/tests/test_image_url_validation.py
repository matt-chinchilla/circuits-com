"""Server-side image URL validation — supplier logo_url + sponsor image_url."""


def _auth(client):
    token = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _create_sponsor(client, headers, supplier_id, category_id, **kwargs):
    return client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(supplier_id),
            "category_id": str(category_id),
            "tier": "platinum",
            "status": "Active",
            **kwargs,
        },
        headers=headers,
    )


# ── Supplier logo_url — 422 cases ────────────────────────────────────────────


def test_supplier_logo_url_rejects_javascript(client, seeded_db):
    headers = _auth(client)
    r = client.post(
        "/api/suppliers/",
        json={"name": "BadSupplier1", "logo_url": "javascript:alert(1)"},
        headers=headers,
    )
    assert r.status_code == 422, r.text


def test_supplier_logo_url_rejects_data_text_html(client, seeded_db):
    headers = _auth(client)
    r = client.post(
        "/api/suppliers/",
        json={"name": "BadSupplier2", "logo_url": "data:text/html;base64,AAAA"},
        headers=headers,
    )
    assert r.status_code == 422, r.text


def test_supplier_logo_url_rejects_data_image_svg(client, seeded_db):
    headers = _auth(client)
    r = client.post(
        "/api/suppliers/",
        json={"name": "BadSupplier3", "logo_url": "data:image/svg+xml;base64,AAAA"},
        headers=headers,
    )
    assert r.status_code == 422, r.text


def test_supplier_logo_url_rejects_over_length(client, seeded_db):
    headers = _auth(client)
    r = client.post(
        "/api/suppliers/",
        json={"name": "BadSupplier4", "logo_url": "A" * 200_001},
        headers=headers,
    )
    assert r.status_code == 422, r.text


# ── Supplier logo_url — 200 cases ────────────────────────────────────────────


def test_supplier_logo_url_accepts_https_url(client, seeded_db):
    headers = _auth(client)
    r = client.post(
        "/api/suppliers/",
        json={"name": "GoodSupplier1", "logo_url": "https://cdn.example.com/a.png"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["logo_url"] == "https://cdn.example.com/a.png"


def test_supplier_logo_url_accepts_data_image_webp(client, seeded_db):
    headers = _auth(client)
    r = client.post(
        "/api/suppliers/",
        json={"name": "GoodSupplier2", "logo_url": "data:image/webp;base64,AAAA"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["logo_url"] == "data:image/webp;base64,AAAA"


def test_supplier_logo_url_accepts_omitted(client, seeded_db):
    headers = _auth(client)
    r = client.post(
        "/api/suppliers/",
        json={"name": "GoodSupplier3"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["logo_url"] is None


# ── Sponsor image_url — 422 case ─────────────────────────────────────────────


def test_sponsor_image_url_rejects_javascript(client, seeded_db):
    headers = _auth(client)
    r = _create_sponsor(
        client,
        headers,
        seeded_db["supplier1"].id,
        seeded_db["parent"].id,
        image_url="javascript:alert(1)",
    )
    assert r.status_code == 422, r.text


# ── Sponsor image_url — 200 case ─────────────────────────────────────────────


def test_sponsor_image_url_accepts_https_url(client, seeded_db):
    headers = _auth(client)
    r = _create_sponsor(
        client,
        headers,
        seeded_db["supplier1"].id,
        seeded_db["parent"].id,
        image_url="https://x/y.png",
    )
    assert r.status_code == 200, r.text
    assert r.json()["image_url"] == "https://x/y.png"
