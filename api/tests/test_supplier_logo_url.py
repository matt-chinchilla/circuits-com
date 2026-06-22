"""Admins can set a supplier's logo_url (a data-URL or http URL) on create/edit."""


def _auth(client):
    token = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_create_supplier_persists_logo_url(client, seeded_db):
    headers = _auth(client)
    data_url = "data:image/webp;base64," + ("A" * 3000)
    r = client.post(
        "/api/suppliers/",
        json={"name": "PixelParts", "logo_url": data_url},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    got = client.get(f"/api/suppliers/{sid}")
    assert got.status_code == 200
    assert got.json()["logo_url"] == data_url


def test_update_supplier_sets_logo_url(client, seeded_db):
    headers = _auth(client)
    created = client.post(
        "/api/suppliers/", json={"name": "NoLogo Inc"}, headers=headers
    ).json()
    assert created["logo_url"] is None
    r = client.put(
        f"/api/suppliers/{created['id']}",
        json={"logo_url": "https://cdn.example.com/logo.png"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["logo_url"] == "https://cdn.example.com/logo.png"
