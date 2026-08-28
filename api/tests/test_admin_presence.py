"""Tests for POST /api/admin/presence/ping — the DB-backed (users.last_seen_at,
alembic 021) "who's in the admin right now" heartbeat behind the topbar
presence bubbles. DB-backed so it is correct under prod's multi-worker uvicorn.

The TTL is exercised through the module's `_now` clock seam rather than a real
sleep. Per-test DB isolation comes from the standard conftest fixtures, and the
login helper is conftest's shared `auth_header` fixture.
"""

from datetime import timedelta

import pytest

from app.routes import admin_presence


@pytest.fixture
def company_header(client, db, seeded_db, auth_header):
    """A SECOND STAFF account — the other console user these tests need.

    This was an activated customer until the fail-closed pass (2026-08-27):
    presence publishes every staff member's username/role/name to the caller,
    so /api/admin/presence is now require_staff and a customer — activated or
    not — is refused outright (see test_customer_is_refused below). Without a
    second principal the roster would hold one person and every 'two users see
    each other' assertion would be vacuous, so mint a second admin instead.
    """
    from app.models import User
    from app.services.auth_service import hash_password

    db.add(
        User(
            username="second_admin@test.example",
            email="second_admin@test.example",
            password_hash=hash_password("testpass123"),
            role="admin",
        )
    )
    db.commit()
    return auth_header(email="second_admin@test.example")


def test_requires_auth(client, seeded_db):
    resp = client.post("/api/admin/presence/ping")
    assert resp.status_code in (401, 403)


def test_customer_is_refused(client, db, seeded_db, auth_header):
    """Even an ACTIVATED customer never reaches presence — the roster names
    every staff member to the caller, which is exactly what the fail-closed
    pass exists to stop."""
    from datetime import UTC, datetime

    seeded_db["company_user"].activated_at = datetime.now(UTC)
    db.commit()
    resp = client.post(
        "/api/admin/presence/ping",
        headers=auth_header(email="kennedy_user@test.example"),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "staff_only"


def test_ping_returns_self(client, seeded_db, auth_header):
    resp = client.post("/api/admin/presence/ping", headers=auth_header())
    assert resp.status_code == 200
    body = resp.json()
    assert [u["username"] for u in body] == ["admin"]
    assert body[0]["role"] == "admin"
    assert body[0]["user_id"]
    # `name` is always present in the payload (null until the User model gets one).
    assert body[0]["name"] is None


def test_repeat_ping_upserts_not_duplicates(client, seeded_db, auth_header):
    header = auth_header()
    client.post("/api/admin/presence/ping", headers=header)
    resp = client.post("/api/admin/presence/ping", headers=header)
    assert [u["username"] for u in resp.json()] == ["admin"]


def test_two_users_see_each_other(client, seeded_db, auth_header, company_header):
    admin_header = auth_header()

    client.post("/api/admin/presence/ping", headers=admin_header)
    resp = client.post("/api/admin/presence/ping", headers=company_header)

    assert resp.status_code == 200
    usernames = [u["username"] for u in resp.json()]
    assert usernames == ["admin", "second_admin@test.example"]  # sorted by username

    # ...and the first user sees the second on its next heartbeat.
    resp2 = client.post("/api/admin/presence/ping", headers=admin_header)
    assert [u["username"] for u in resp2.json()] == ["admin", "second_admin@test.example"]


def test_stale_entry_drops_out(client, seeded_db, auth_header, company_header, monkeypatch):
    """A user who stopped heartbeating falls off once past the TTL."""
    admin_header = auth_header()

    client.post("/api/admin/presence/ping", headers=admin_header)

    # Fast-forward past the TTL: only the user who pings now is active.
    later = admin_presence._now() + timedelta(seconds=admin_presence.PRESENCE_TTL_SECONDS + 1)
    monkeypatch.setattr(admin_presence, "_now", lambda: later)

    resp = client.post("/api/admin/presence/ping", headers=company_header)
    assert [u["username"] for u in resp.json()] == ["second_admin@test.example"]


def test_entry_inside_ttl_survives(client, seeded_db, auth_header, company_header, monkeypatch):
    """Boundary companion to the test above — just under the TTL still counts."""
    admin_header = auth_header()

    client.post("/api/admin/presence/ping", headers=admin_header)

    later = admin_presence._now() + timedelta(seconds=admin_presence.PRESENCE_TTL_SECONDS - 1)
    monkeypatch.setattr(admin_presence, "_now", lambda: later)

    resp = client.post("/api/admin/presence/ping", headers=company_header)
    assert [u["username"] for u in resp.json()] == ["admin", "second_admin@test.example"]
