"""Tests for the page view tracking and analytics endpoints."""


def _login(client):
    resp = client.post("/api/auth/login", json={"username": "admin", "password": "testpass123"})
    return resp.json()["token"]


def test_track_page_view_returns_204(client, seeded_db):
    resp = client.post(
        "/api/track",
        json={"path": "/", "referrer": None, "session_id": "test-session-1"},
    )
    assert resp.status_code == 204


def test_track_records_page_view(client, seeded_db, db):
    from app.models.page_view import PageView

    client.post(
        "/api/track",
        json={"path": "/category/analog-ics", "referrer": "https://google.com", "session_id": "sess-abc"},
    )
    views = db.query(PageView).all()
    assert len(views) == 1
    assert views[0].path == "/category/analog-ics"
    assert views[0].referrer == "https://google.com"
    assert views[0].session_id == "sess-abc"
    assert views[0].device_type == "desktop"


def test_analytics_requires_auth(client, seeded_db):
    resp = client.get("/api/dashboard/analytics")
    assert resp.status_code == 401


def test_analytics_returns_structure(client, seeded_db):
    token = _login(client)

    client.post("/api/track", json={"path": "/", "session_id": "s1"})
    client.post("/api/track", json={"path": "/category/test", "session_id": "s1"})
    client.post("/api/track", json={"path": "/part/abc", "session_id": "s2"})

    resp = client.get(
        "/api/dashboard/analytics",
        headers={"Authorization": f"Bearer {token}"},
        params={"days": 30},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_views"] == 3
    assert data["unique_visitors"] == 2
    assert data["avg_pages_per_visit"] == 1.5
    assert len(data["top_pages"]) >= 2
    assert len(data["top_parts"]) == 1
    assert len(data["top_categories"]) == 1
    assert data["top_parts"][0]["path"] == "/part/abc"
