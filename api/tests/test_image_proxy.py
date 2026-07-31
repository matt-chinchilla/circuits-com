"""Tests for GET /api/admin/image-proxy — the server-side logo fetch that lets
the admin cropper + brand-color extraction run on a pasted image URL (a direct
cross-origin <img> would taint the canvas and kill both).

Two layers of coverage:

* ROUTE level — the network fetch is monkeypatched at the module's _fetch_image
  seam, so only wiring/auth/headers are under test.
* FETCH level — _fetch_image is called DIRECTLY with admin_media._TRANSPORT
  swapped for an httpx.MockTransport, so the real guards (per-hop SSRF
  re-validation, redirect cap, content-type filter, 8 MB cap) execute against
  scripted responses instead of being stubbed away.

The URL validation (_assert_public_http_url) is exercised for real since it is
pure — but it resolves DNS, so the transport-level tests that are NOT about it
replace it with a spy (which also locks in "called once per hop").
"""

import httpx
import pytest
from fastapi import HTTPException

from app.routes import admin_media

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"fake-pixels"


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


# ---------------------------------------------------------------------------
# _fetch_image against a MockTransport — the guards run for REAL here.
# ---------------------------------------------------------------------------


def _use_transport(monkeypatch, handler) -> None:
    monkeypatch.setattr(admin_media, "_TRANSPORT", httpx.MockTransport(handler))


@pytest.fixture
def guard_spy(monkeypatch):
    """DNS-free stand-in for _assert_public_http_url that records every hop.

    Used only by the tests that are NOT about the SSRF guard itself (they would
    otherwise need live DNS). Asserting on the recorded hops locks the wiring:
    switching the client to follow_redirects=True would skip the per-hop
    re-validation and drop these counts.
    """
    hops: list[str] = []

    def spy(url: str) -> None:
        hops.append(url)

    monkeypatch.setattr(admin_media, "_assert_public_http_url", spy)
    return hops


@pytest.mark.asyncio
async def test_redirect_to_private_host_is_rejected(monkeypatch):
    """SSRF: a public first hop that 302s to the cloud-metadata IP still 422s.

    The REAL _assert_public_http_url runs here — both URLs use literal IPs so no
    DNS is needed (getaddrinfo short-circuits on numeric hosts).
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://169.254.169.254/x.png"})

    _use_transport(monkeypatch, handler)
    with pytest.raises(HTTPException) as exc:
        await admin_media._fetch_image("https://93.184.216.34/logo.png")
    assert exc.value.status_code == 422
    assert "not reachable" in exc.value.detail


@pytest.mark.asyncio
async def test_non_image_content_type_rejected(monkeypatch, guard_spy):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/html; charset=utf-8"}, content=b"<html></html>"
        )

    _use_transport(monkeypatch, handler)
    with pytest.raises(HTTPException) as exc:
        await admin_media._fetch_image("https://cdn.example.com/page.html")
    assert exc.value.status_code == 422
    assert "raster image" in exc.value.detail
    assert guard_spy == ["https://cdn.example.com/page.html"]


@pytest.mark.asyncio
async def test_svg_content_type_rejected(monkeypatch, guard_spy):
    """SVG is an image/* but can smuggle script + breaks canvas export."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "image/svg+xml"}, content=b"<svg/>")

    _use_transport(monkeypatch, handler)
    with pytest.raises(HTTPException) as exc:
        await admin_media._fetch_image("https://cdn.example.com/logo.svg")
    assert exc.value.status_code == 422
    assert "raster image" in exc.value.detail


@pytest.mark.asyncio
async def test_body_over_8mb_rejected(monkeypatch, guard_spy):
    """9 MB streamed in 1 MB chunks trips the cap mid-stream (never buffered whole)."""

    async def nine_megabytes():
        for _ in range(9):
            yield b"\0" * (1024 * 1024)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "image/png"}, content=nine_megabytes())

    _use_transport(monkeypatch, handler)
    with pytest.raises(HTTPException) as exc:
        await admin_media._fetch_image("https://cdn.example.com/huge.png")
    assert exc.value.status_code == 422
    assert "larger than 8 MB" in exc.value.detail


@pytest.mark.asyncio
async def test_redirect_chain_over_limit_rejected(monkeypatch, guard_spy):
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": f"/hop{len(requested)}.png"})

    _use_transport(monkeypatch, handler)
    with pytest.raises(HTTPException) as exc:
        await admin_media._fetch_image("https://cdn.example.com/logo.png")
    assert exc.value.status_code == 422
    assert "Too many redirects" in exc.value.detail
    # 1 original + _MAX_REDIRECTS hops, each re-validated before it is fetched.
    assert len(requested) == admin_media._MAX_REDIRECTS + 1
    assert len(guard_spy) == admin_media._MAX_REDIRECTS + 1
    assert requested[-1].endswith("/hop3.png")


@pytest.mark.asyncio
async def test_happy_path_returns_bytes_and_normalized_type(monkeypatch, guard_spy):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["accept"] == "image/*"
        assert "CircuitCenterAdmin" in request.headers["user-agent"]
        return httpx.Response(
            200, headers={"content-type": "image/PNG; charset=binary"}, content=PNG_BYTES
        )

    _use_transport(monkeypatch, handler)
    data, ctype = await admin_media._fetch_image("https://cdn.example.com/acme.png")
    assert data == PNG_BYTES
    assert ctype == "image/png"  # parameters stripped, lower-cased
    assert guard_spy == ["https://cdn.example.com/acme.png"]


@pytest.mark.asyncio
async def test_transport_error_surfaces_as_422(monkeypatch, guard_spy):
    """A dead host must not bubble an httpx exception into a 500."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    _use_transport(monkeypatch, handler)
    with pytest.raises(HTTPException) as exc:
        await admin_media._fetch_image("https://cdn.example.com/acme.png")
    assert exc.value.status_code == 422
    assert "Could not fetch" in exc.value.detail
