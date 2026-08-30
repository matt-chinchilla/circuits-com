"""Track-time IP→country capture (services/geoip.py + POST /api/track).

The contract under test is FAIL-OPEN: no geo condition may ever break or
slow /api/track — a missing database, an unparseable IP, or a reader error
stores country NULL and the page view still lands."""

from pathlib import Path

import pytest

from app.models.page_view import PageView
from app.services import geoip
from app.services.geoip import GeoResult, country_for_ip, reset_geoip


@pytest.fixture(autouse=True)
def _fresh_reader():
    reset_geoip()
    yield
    reset_geoip()


def _hide_every_database(monkeypatch):
    """Both candidates gone. Patching only one leaves the other to open, and
    since the city file is present on a built machine and absent on a fresh
    checkout, a one-path patch would pass or fail by environment."""
    monkeypatch.setattr(geoip, "CITY_DB_PATH", Path("/nonexistent/city.mmdb"))
    monkeypatch.setattr(geoip, "COUNTRY_DB_PATH", Path("/nonexistent/country.mmdb"))


def _skip_without_a_database():
    if not (geoip.CITY_DB_PATH.exists() or geoip.COUNTRY_DB_PATH.exists()):
        pytest.skip("no mmdb present")


class TestCountryForIp:
    def test_none_ip_is_none(self):
        assert country_for_ip(None) is None
        assert country_for_ip("") is None

    def test_missing_database_fails_open(self, monkeypatch):
        _hide_every_database(monkeypatch)
        assert country_for_ip("8.8.8.8") is None
        # The failed open is remembered — no per-request retry storm.
        assert geoip._open_failed is True

    def test_reset_clears_failure_memo(self, monkeypatch):
        _hide_every_database(monkeypatch)
        country_for_ip("8.8.8.8")
        assert geoip._open_failed is True
        reset_geoip()
        assert geoip._open_failed is False

    def test_invalid_ip_is_none_and_reader_survives(self):
        _skip_without_a_database()
        assert country_for_ip("testclient") is None
        assert country_for_ip("not-an-ip") is None
        # Reader stays healthy for the next lookup.
        assert geoip._open_failed is False

    def test_known_public_ip_resolves(self):
        _skip_without_a_database()
        iso = country_for_ip("8.8.8.8")
        assert iso is not None
        assert len(iso) == 2
        assert iso == iso.upper()

    def test_it_delegates_to_geo_for_ip(self, monkeypatch):
        """The signup path imports this name and stores nothing but the ISO
        code; it must stay a view onto the one lookup, not a second reader."""
        monkeypatch.setattr(geoip, "geo_for_ip", lambda ip: GeoResult(country="PT", city="Lisbon"))
        assert country_for_ip("8.8.8.8") == "PT"


class TestTrackStoresCountry:
    def test_track_with_no_geo_stores_null_and_204(self, client, db, monkeypatch):
        # TestClient's host is "testclient" — not an IP; geo must not object.
        resp = client.post("/api/track", json={"path": "/", "session_id": "geo-s1"})
        assert resp.status_code == 204
        row = db.query(PageView).filter(PageView.session_id == "geo-s1").one()
        assert row.country is None

    def test_track_stores_resolved_country(self, client, db, monkeypatch):
        # geo_for_ip is imported into the route module's namespace.
        from app.routes import analytics as analytics_route

        monkeypatch.setattr(analytics_route, "geo_for_ip", lambda ip: GeoResult(country="US"))
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
            return GeoResult(country={"10.0.0.7": "DE", "9.9.9.9": "XX"}.get(ip or ""))

        monkeypatch.setattr(analytics_route, "geo_for_ip", fake_lookup)
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


class TestTrustedClientAddr:
    """`client_ip` is a rate-limit KEY (IPv6 collapses to its /64 network);
    `trusted_client_addr` is the ADDRESS. Same trust chain, two exits — a
    CIDR string is not something a GeoIP reader or a per-visitor hash can use."""

    def _request(self, headers=None, host="203.0.113.9"):
        from starlette.requests import Request

        raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
        return Request({"type": "http", "headers": raw, "client": (host, 1234)})

    def test_ipv6_is_bucketed_for_keys_but_whole_for_geo(self):
        from app.services.rate_limit import client_ip, trusted_client_addr

        req = self._request({"X-Real-IP": "2001:db8:abcd:1234:5678:9abc:def0:1"})
        # The rate-limit key still buckets — that property is load-bearing.
        assert client_ip(req) == "2001:db8:abcd:1234::/64"
        # The geo/hash source is the real host, with no prefix length on it.
        assert trusted_client_addr(req) == "2001:db8:abcd:1234:5678:9abc:def0:1"
        assert "/" not in trusted_client_addr(req)

    def test_ipv4_agrees_on_both_exits(self):
        from app.services.rate_limit import client_ip, trusted_client_addr

        req = self._request({"X-Real-IP": "198.51.100.4"})
        assert client_ip(req) == "198.51.100.4"
        assert trusted_client_addr(req) == "198.51.100.4"

    def test_same_trust_chain_as_client_ip(self):
        """Rightmost XFF hop wins — the leftmost is caller-typed."""
        from app.services.rate_limit import trusted_client_addr

        req = self._request({"X-Forwarded-For": "9.9.9.9, 2001:db8::5"})
        assert trusted_client_addr(req) == "2001:db8::5"

    def test_v4_mapped_v6_unwraps(self):
        from app.services.rate_limit import trusted_client_addr

        assert trusted_client_addr(self._request({"X-Real-IP": "::ffff:1.2.3.4"})) == "1.2.3.4"

    def test_non_ip_host_is_none_not_a_guess(self):
        from app.services.rate_limit import client_ip, trusted_client_addr

        req = self._request(host="testclient")
        assert trusted_client_addr(req) is None  # fail-open: no country, no hash
        assert client_ip(req) == "testclient"  # the key still has something to key on

    def test_unparseable_header_falls_through_to_the_next_hop(self):
        from app.services.rate_limit import trusted_client_addr

        req = self._request({"X-Real-IP": "garbage", "X-Forwarded-For": "9.9.9.9, 198.51.100.7"})
        assert trusted_client_addr(req) == "198.51.100.7"


class TestIpv6VisitorsGeolocate:
    def test_ipv6_address_reaches_geoip_unbucketed(self, client, db, monkeypatch):
        """The bug: geo was fed `client_ip`, i.e. `2001:db8::/64`, which no
        reader accepts — so every IPv6 visitor stored country NULL."""
        from app.routes import analytics as analytics_route

        seen: list[str | None] = []

        def fake_lookup(ip):
            seen.append(ip)
            # A reader really does reject a network string; model that.
            return GeoResult() if ip is None or "/" in ip else GeoResult(country="NL")

        monkeypatch.setattr(analytics_route, "geo_for_ip", fake_lookup)
        client.post(
            "/api/track",
            json={"path": "/", "session_id": "v6-s1"},
            headers={"X-Real-IP": "2001:db8:abcd:1234::99"},
        )
        assert seen == ["2001:db8:abcd:1234::99"]
        row = db.query(PageView).filter(PageView.session_id == "v6-s1").one()
        assert row.country == "NL"

    def test_ipv6_hosts_in_one_subnet_hash_apart(self, client, db, monkeypatch):
        """The /64 also merged every subscriber behind one line into one
        ip_hash. Distinct hosts must stay distinct visitors."""
        for i, addr in enumerate(("2001:db8:1:2::a", "2001:db8:1:2::b")):
            client.post(
                "/api/track",
                json={"path": "/", "session_id": f"v6-hash-{i}"},
                headers={"X-Real-IP": addr},
            )
        hashes = {
            row.ip_hash
            for row in db.query(PageView).filter(PageView.session_id.like("v6-hash-%")).all()
        }
        assert len(hashes) == 2


class TestTrackThrottleIsNotForgeable:
    """The 30/min bucket used to be keyed on `payload.session_id` — a value
    the caller types — so any flooder minted a virgin allowance per invented
    id. It is keyed on the edge-observed address now."""

    def _post(self, client, session_id, addr="198.51.100.50"):
        return client.post(
            "/api/track",
            json={"path": "/x", "session_id": session_id},
            headers={"X-Real-IP": addr},
        )

    def test_rotating_session_ids_cannot_escape_the_bucket(self, client, db):
        from app.routes.analytics import _RATE_MAX

        # Every request invents a fresh session id — the old escape hatch.
        for i in range(_RATE_MAX + 20):
            assert self._post(client, f"forged-{i}").status_code == 204
        stored = db.query(PageView).filter(PageView.session_id.like("forged-%")).count()
        assert stored == _RATE_MAX, f"forged ids stored {stored} rows, cap is {_RATE_MAX}"

    def test_a_different_address_has_its_own_allowance(self, client, db):
        from app.routes.analytics import _RATE_MAX

        for i in range(_RATE_MAX + 5):
            self._post(client, f"host-a-{i}", addr="198.51.100.60")
        assert self._post(client, "host-b-1", addr="198.51.100.61").status_code == 204
        assert db.query(PageView).filter(PageView.session_id == "host-b-1").count() == 1

    def test_ipv6_rotation_within_a_64_shares_one_bucket(self, client, db):
        """A host owns its whole /64, so per-address buckets would be free to
        rotate — this is exactly why the THROTTLE keys on client_ip and the
        geo lookup does not."""
        from app.routes.analytics import _RATE_MAX

        for i in range(_RATE_MAX + 10):
            self._post(client, f"v6-flood-{i}", addr=f"2001:db8:dead:beef::{i:x}")
        stored = db.query(PageView).filter(PageView.session_id.like("v6-flood-%")).count()
        assert stored == _RATE_MAX

    def test_an_honest_visitor_is_unaffected(self, client, db):
        assert self._post(client, "honest-1", addr="198.51.100.70").status_code == 204
        assert db.query(PageView).filter(PageView.session_id == "honest-1").count() == 1
