"""Tests for GET /api/admin/image-proxy — the server-side logo fetch that lets
the admin cropper + brand-color extraction run on a pasted image URL (a direct
cross-origin <img> would taint the canvas and kill both).

The network fetch is monkeypatched at the module's _fetch_image seam; the URL
validation (_assert_public_http_url) is exercised for real since it is pure.
"""

import pytest
from fastapi import HTTPException

from app.routes import admin_media


def _auth_header(client):
    resp = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "testpass123"},
    )
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_requires_auth(client, seeded_db):
    resp = client.get("/api/admin/image-proxy", params={"url": "https://example.com/a.png"})
    assert resp.status_code in (401, 403)


def test_success_streams_bytes_and_content_type(client, seeded_db, monkeypatch):
    async def fake_fetch(url):
        assert url == "https://logos.example.com/acme.png"
        return b"\x89PNGdata", "image/png"

    monkeypatch.setattr(admin_media, "_fetch_image", fake_fetch)
    resp = client.get(
        "/api/admin/image-proxy",
        params={"url": "https://logos.example.com/acme.png"},
        headers=_auth_header(client),
    )
    assert resp.status_code == 200
    assert resp.content == b"\x89PNGdata"
    assert resp.headers["content-type"].startswith("image/png")
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_fetch_errors_surface_as_422(client, seeded_db, monkeypatch):
    async def fake_fetch(url):
        raise HTTPException(422, "That URL did not return a raster image.")

    monkeypatch.setattr(admin_media, "_fetch_image", fake_fetch)
    resp = client.get(
        "/api/admin/image-proxy",
        params={"url": "https://example.com/page.html"},
        headers=_auth_header(client),
    )
    assert resp.status_code == 422
    assert "raster image" in resp.json()["detail"]


@pytest.mark.parametrize(
    "bad_url",
    [
        "ftp://example.com/logo.png",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "not-a-url",
        "",
    ],
)
def test_rejects_non_http_schemes(bad_url):
    with pytest.raises(HTTPException) as exc:
        admin_media._assert_public_http_url(bad_url)
    assert exc.value.status_code == 422


@pytest.mark.parametrize(
    "private_url",
    [
        "http://127.0.0.1/logo.png",
        "http://localhost/logo.png",
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.5/logo.png",
        "http://192.168.1.1/logo.png",
        "http://0.0.0.0/x.png",
    ],
)
def test_rejects_private_hosts(private_url):
    """SSRF guard: loopback / RFC1918 / link-local (cloud metadata) all 422."""
    with pytest.raises(HTTPException) as exc:
        admin_media._assert_public_http_url(private_url)
    assert exc.value.status_code == 422


def test_accepts_public_host():
    # example.com is stable public DNS; the guard only resolves, never fetches.
    admin_media._assert_public_http_url("https://example.com/logo.png")
