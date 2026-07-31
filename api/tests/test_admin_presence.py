"""Tests for POST /api/admin/presence/ping — the in-memory "who's in the admin
right now" heartbeat behind the topbar presence bubbles.

The store is a MODULE-LEVEL dict (single-process uvicorn, no DB), so it leaks
across tests unless cleared — hence the autouse fixture below. The TTL is
exercised through the module's `_now` clock seam rather than a real sleep.
"""

import pytest

from app.routes import admin_presence


@pytest.fixture(autouse=True)
def clear_presence():
    """Module-level store — reset before AND after so neither this file's tests
    nor any later test file inherits a stale roster."""
    admin_presence._PRESENCE.clear()
    yield
    admin_presence._PRESENCE.clear()


def _auth_header(client, username="admin", password="testpass123"):
    resp = client.post(
        "/api/auth/login",
        json={"username": username, "password": password},
    )
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_requires_auth(client, seeded_db):
    resp = client.post("/api/admin/presence/ping")
    assert resp.status_code in (401, 403)


def test_ping_returns_self(client, seeded_db):
    resp = client.post("/api/admin/presence/ping", headers=_auth_header(client))
    assert resp.status_code == 200
    body = resp.json()
    assert [u["username"] for u in body] == ["admin"]
    assert body[0]["role"] == "admin"
    assert body[0]["user_id"]
    # `name` is always present in the payload (null until the User model gets one).
    assert body[0]["name"] is None


def test_repeat_ping_upserts_not_duplicates(client, seeded_db):
    header = _auth_header(client)
    client.post("/api/admin/presence/ping", headers=header)
    resp = client.post("/api/admin/presence/ping", headers=header)
    assert [u["username"] for u in resp.json()] == ["admin"]
    assert len(admin_presence._PRESENCE) == 1


def test_two_users_see_each_other(client, seeded_db):
    admin_header = _auth_header(client)
    company_header = _auth_header(client, username="kennedy_user")

    client.post("/api/admin/presence/ping", headers=admin_header)
    resp = client.post("/api/admin/presence/ping", headers=company_header)

    assert resp.status_code == 200
    usernames = [u["username"] for u in resp.json()]
    assert usernames == ["admin", "kennedy_user"]  # sorted by username

    # ...and the first user sees the second on its next heartbeat.
    resp2 = client.post("/api/admin/presence/ping", headers=admin_header)
    assert [u["username"] for u in resp2.json()] == ["admin", "kennedy_user"]


def test_stale_entry_drops_out(client, seeded_db, monkeypatch):
    """A user who stopped heartbeating falls off once past the TTL."""
    admin_header = _auth_header(client)
    company_header = _auth_header(client, username="kennedy_user")

    client.post("/api/admin/presence/ping", headers=admin_header)

    # Fast-forward past the TTL: only the user who pings now is active.
    later = admin_presence._now() + admin_presence.PRESENCE_TTL_SECONDS + 1
    monkeypatch.setattr(admin_presence, "_now", lambda: later)

    resp = client.post("/api/admin/presence/ping", headers=company_header)
    assert [u["username"] for u in resp.json()] == ["kennedy_user"]
    assert len(admin_presence._PRESENCE) == 1


def test_entry_inside_ttl_survives(client, seeded_db, monkeypatch):
    """Boundary companion to the test above — just under the TTL still counts."""
    admin_header = _auth_header(client)
    company_header = _auth_header(client, username="kennedy_user")

    client.post("/api/admin/presence/ping", headers=admin_header)

    later = admin_presence._now() + admin_presence.PRESENCE_TTL_SECONDS - 1
    monkeypatch.setattr(admin_presence, "_now", lambda: later)

    resp = client.post("/api/admin/presence/ping", headers=company_header)
    assert [u["username"] for u in resp.json()] == ["admin", "kennedy_user"]
