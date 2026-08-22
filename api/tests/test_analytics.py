"""Tests for the page view tracking and analytics endpoints."""


def _login(client):
    resp = client.post("/api/auth/login", json={"email": "admin@test.example", "password": "testpass123"})
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


# ── geo_tracked_since: a fact about the DATABASE, not about the window ──────


class TestGeoTrackedSince:
    """The map panel prints this as "country data since X". It answers when
    geo tracking STARTED, so it must not move with the selected range — under
    the request window it slid forward and told the operator country data
    began at the start of whatever period they had picked."""

    def _seed(self, db):
        from datetime import UTC, datetime, timedelta

        from app.models.page_view import PageView

        now = datetime.now(UTC)
        # The first country-bearing row is far OUTSIDE any short window.
        for days_ago, country, ua in (
            (200, "US", "Mozilla/5.0 (Windows NT 10.0) Chrome/120"),
            (100, "DE", "Mozilla/5.0 (Windows NT 10.0) Chrome/120"),
            (1, "NL", "Mozilla/5.0 (Windows NT 10.0) Chrome/120"),
            (2, None, "Mozilla/5.0 (Windows NT 10.0) Chrome/120"),  # pre-geo history
        ):
            db.add(
                PageView(
                    path="/",
                    session_id=f"geo-since-{days_ago}",
                    user_agent=ua,
                    country=country,
                    created_at=now - timedelta(days=days_ago),
                )
            )
        db.commit()
        return now - timedelta(days=200)

    def _get(self, client, token, **params):
        resp = client.get(
            "/api/dashboard/analytics",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
        )
        assert resp.status_code == 200
        return resp.json()

    def test_ignores_the_window(self, client, db, seeded_db):
        token = _login(client)
        oldest = self._seed(db)

        stamps = {
            days: self._get(client, token, days=days)["geo_tracked_since"]
            for days in (7, 30, 365)
        }
        assert len(set(stamps.values())) == 1, f"stamp moved with the window: {stamps}"
        assert str(oldest.date()) in stamps[7]

    def test_ignores_the_segment(self, client, db, seeded_db):
        token = _login(client)
        self._seed(db)
        stamps = {
            seg: self._get(client, token, days=30, segment=seg)["geo_tracked_since"]
            for seg in ("humans", "bots", "all")
        }
        assert len(set(stamps.values())) == 1, f"stamp moved with the segment: {stamps}"

    def test_null_is_not_cached_so_the_first_row_lands(self, client, db, seeded_db):
        """An empty database answers "not yet". Caching that None would pin it
        forever, and the panel would never start reporting."""
        token = _login(client)
        assert self._get(client, token, days=30)["geo_tracked_since"] is None
        self._seed(db)
        assert self._get(client, token, days=30)["geo_tracked_since"] is not None

    def test_rows_without_a_country_do_not_set_it(self, client, db, seeded_db):
        from datetime import UTC, datetime, timedelta

        from app.models.page_view import PageView

        token = _login(client)
        now = datetime.now(UTC)
        db.add(
            PageView(
                path="/",
                session_id="pre-geo",
                user_agent="Mozilla/5.0 Chrome/120",
                country=None,
                created_at=now - timedelta(days=300),
            )
        )
        db.commit()
        assert self._get(client, token, days=365)["geo_tracked_since"] is None
