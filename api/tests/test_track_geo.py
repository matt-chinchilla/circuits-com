"""Track-time IP→country capture (services/geoip.py + POST /api/track).

The contract under test is FAIL-OPEN: no geo condition may ever break or
slow /api/track — a missing database, an unparseable IP, or a reader error
stores country NULL and the page view still lands."""

from pathlib import Path

import pytest

from app.models.page_view import PageView
from app.services import geoip
from app.services.geoip import country_for_ip, reset_geoip


@pytest.fixture(autouse=True)
def _fresh_reader():
    reset_geoip()
    yield
    reset_geoip()


class TestCountryForIp:
    def test_none_ip_is_none(self):
        assert country_for_ip(None) is None
        assert country_for_ip("") is None

    def test_missing_database_fails_open(self, monkeypatch):
        monkeypatch.setattr(geoip, "DB_PATH", Path("/nonexistent/geo.mmdb"))
        assert country_for_ip("8.8.8.8") is None
        # The failed open is remembered — no per-request retry storm.
        assert geoip._open_failed is True

    def test_reset_clears_failure_memo(self, monkeypatch):
        monkeypatch.setattr(geoip, "DB_PATH", Path("/nonexistent/geo.mmdb"))
        country_for_ip("8.8.8.8")
        assert geoip._open_failed is True
        reset_geoip()
        assert geoip._open_failed is False

    def test_invalid_ip_is_none_and_reader_survives(self):
        if not geoip.DB_PATH.exists():
            pytest.skip("committed mmdb not present")
        assert country_for_ip("testclient") is None
        assert country_for_ip("not-an-ip") is None
        # Reader stays healthy for the next lookup.
        assert geoip._open_failed is False

    def test_known_public_ip_resolves(self):
        if not geoip.DB_PATH.exists():
            pytest.skip("committed mmdb not present")
        iso = country_for_ip("8.8.8.8")
        assert iso is not None
        assert len(iso) == 2
        assert iso == iso.upper()


class TestTrackStoresCountry:
    def test_track_with_no_geo_stores_null_and_204(self, client, db, monkeypatch):
        # TestClient's host is "testclient" — not an IP; geo must not object.
        resp = client.post("/api/track", json={"path": "/", "session_id": "geo-s1"})
        assert resp.status_code == 204
        row = db.query(PageView).filter(PageView.session_id == "geo-s1").one()
        assert row.country is None

    def test_track_stores_resolved_country(self, client, db, monkeypatch):
        # country_for_ip is imported into the route module's namespace.
        from app.routes import analytics as analytics_route

        monkeypatch.setattr(analytics_route, "country_for_ip", lambda ip: "US")
        client.post("/api/track", json={"path": "/", "session_id": "geo-s2"})
        row = db.query(PageView).filter(PageView.session_id == "geo-s2").one()
        assert row.country == "US"

    def test_forged_xff_cannot_place_the_pin(self, client, db, monkeypatch):
        """Geo reads the edge-observed hop (rightmost XFF / X-Real-IP), never
        the attacker-typed leftmost value that lands in request.client."""
        from app.routes import analytics as analytics_route

        seen: list[str | None] = []

        def fake_lookup(ip):
            seen.append(ip)
            return {"10.0.0.7": "DE", "9.9.9.9": "XX"}.get(ip or "")

        monkeypatch.setattr(analytics_route, "country_for_ip", fake_lookup)
        client.post(
            "/api/track",
            json={"path": "/", "session_id": "geo-s3"},
            headers={"X-Forwarded-For": "9.9.9.9, 10.0.0.7"},
        )
        row = db.query(PageView).filter(PageView.session_id == "geo-s3").one()
        assert row.country == "DE"
        assert seen == ["10.0.0.7"]  # the forged 9.9.9.9 never reached geo


class TestSchema:
    def test_country_column_metadata(self):
        col = PageView.__table__.c.country
        assert col.nullable is True
        # SQLite ignores VARCHAR lengths at runtime — assert the metadata
        # contract instead (the established pattern for length checks).
        assert col.type.length == 2
