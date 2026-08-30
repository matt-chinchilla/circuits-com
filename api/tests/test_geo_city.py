"""City-level geo resolution (services/geoip.geo_for_ip) and its track-time stamp.

Every parsing test drives a FAKE reader, so none of them depend on the
~124MB city database being on the machine — it is gitignored, the image
downloads it, and a test that skipped without it would be a test that never
ran in most places.

The record fixtures below are the REAL DB-IP City Lite 2026-08 shape, taken
from an actual lookup: note that `subdivisions[0]` carries `names` and NO
`iso_code`, which is why a region here is "California" and never "CA".
"""

import copy

import pytest

from app.models.page_view import PageView
from app.services import geoip
from app.services.geoip import EMPTY_GEO, GeoResult, geo_for_ip, reset_geoip

# Trimmed to the keys the parser reads; the real record also carries
# continent, geoname_ids, and names in ten languages.
FULL_RECORD = {
    "city": {"names": {"en": "Mountain View"}},
    "country": {"iso_code": "US", "names": {"en": "United States"}},
    "location": {"latitude": 37.422, "longitude": -122.085},
    "subdivisions": [{"names": {"en": "California"}}],
}


class FakeReader:
    """Counts lookups so "one mmdb read per call" stays checkable."""

    def __init__(self, record=None, raises=None):
        self.record = record
        self.raises = raises
        self.calls = 0

    def get(self, ip):
        self.calls += 1
        if self.raises is not None:
            raise self.raises
        return self.record

    def close(self):
        pass


@pytest.fixture(autouse=True)
def _fresh_reader():
    reset_geoip()
    yield
    reset_geoip()


@pytest.fixture
def fake_reader(monkeypatch):
    def _install(record=None, raises=None):
        reader = FakeReader(record, raises)
        monkeypatch.setattr(geoip, "_reader", reader)
        monkeypatch.setattr(geoip, "_open_failed", False)
        return reader

    return _install


def _record_without(*keys):
    record = copy.deepcopy(FULL_RECORD)
    for key in keys:
        record.pop(key)
    return record


class TestFullRecord:
    def test_every_field_resolves(self, fake_reader):
        fake_reader(FULL_RECORD)
        assert geo_for_ip("8.8.8.8") == GeoResult(
            country="US",
            region="California",
            city="Mountain View",
            latitude=37.42,
            longitude=-122.08,
        )

    def test_one_lookup_serves_all_five_fields(self, fake_reader):
        """The point of the rework: five columns, one mmdb read."""
        reader = fake_reader(FULL_RECORD)
        geo_for_ip("8.8.8.8")
        assert reader.calls == 1

    def test_region_is_the_name_not_a_code(self, fake_reader):
        fake_reader(FULL_RECORD)
        assert geo_for_ip("8.8.8.8").region == "California"

    def test_country_is_upper_cased(self, fake_reader):
        record = copy.deepcopy(FULL_RECORD)
        record["country"]["iso_code"] = "us"
        fake_reader(record)
        assert geo_for_ip("8.8.8.8").country == "US"


class TestPartialRecords:
    """The free tier knows a country for everything and a city for much less.
    Each absence must cost only its own field."""

    def test_no_subdivisions_key(self, fake_reader):
        fake_reader(_record_without("subdivisions"))
        geo = geo_for_ip("8.8.8.8")
        assert geo.region is None
        assert (geo.country, geo.city, geo.latitude) == ("US", "Mountain View", 37.42)

    def test_empty_subdivisions_list(self, fake_reader):
        record = copy.deepcopy(FULL_RECORD)
        record["subdivisions"] = []
        fake_reader(record)
        assert geo_for_ip("8.8.8.8").region is None

    def test_no_location(self, fake_reader):
        fake_reader(_record_without("location"))
        geo = geo_for_ip("8.8.8.8")
        assert (geo.latitude, geo.longitude) == (None, None)
        assert (geo.country, geo.city, geo.region) == ("US", "Mountain View", "California")

    def test_no_city(self, fake_reader):
        fake_reader(_record_without("city"))
        geo = geo_for_ip("8.8.8.8")
        assert geo.city is None
        assert (geo.country, geo.region, geo.latitude) == ("US", "California", 37.42)

    def test_country_only_record_is_the_fallback_db_shape(self, fake_reader):
        """What the committed country-lite database returns for every IP."""
        fake_reader({"country": {"iso_code": "DE"}})
        assert geo_for_ip("8.8.8.8") == GeoResult(country="DE")

    def test_no_country_but_a_city(self, fake_reader):
        fake_reader(_record_without("country"))
        geo = geo_for_ip("8.8.8.8")
        assert geo.country is None
        assert geo.city == "Mountain View"


class TestGarbageRecords:
    """Nothing a record can contain may raise out of a /api/track request."""

    @pytest.mark.parametrize(
        "record",
        [
            None,
            "not a dict",
            42,
            [],
            {"country": "US"},  # str where a mapping belongs
            {"country": {"iso_code": "USA"}},  # not alpha-2
            {"country": {"iso_code": 840}},
            {"city": {"names": {"en": 123}}},
            {"city": {"names": "Mountain View"}},
            {"city": "Mountain View"},
            {"subdivisions": "California"},
            {"subdivisions": ["California"]},  # list of str, not of dicts
            {"subdivisions": [{"iso_code": "CA"}]},  # no names → no region
            {"location": "37.4,-122"},
            {"location": {"latitude": "37.4", "longitude": "-122.0"}},
        ],
    )
    def test_junk_yields_empty_and_never_raises(self, fake_reader, record):
        fake_reader(record)
        assert geo_for_ip("8.8.8.8") == EMPTY_GEO

    def test_a_reader_error_is_swallowed(self, fake_reader):
        fake_reader(raises=ValueError("not an IP"))
        assert geo_for_ip("garbage") == EMPTY_GEO

    def test_blank_ip_short_circuits(self, fake_reader):
        reader = fake_reader(FULL_RECORD)
        assert geo_for_ip(None) == EMPTY_GEO
        assert geo_for_ip("") == EMPTY_GEO
        assert reader.calls == 0


class TestCoordinateSanity:
    def test_booleans_are_not_numbers(self, fake_reader):
        """`isinstance(True, int)` is True, so a bare numeric check would
        store a visitor at latitude 1.0."""
        fake_reader({"location": {"latitude": True, "longitude": False}})
        assert geo_for_ip("8.8.8.8").latitude is None

    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
    def test_non_finite_is_rejected(self, fake_reader, bad):
        fake_reader({"location": {"latitude": bad, "longitude": 1.0}})
        assert geo_for_ip("8.8.8.8").latitude is None

    @pytest.mark.parametrize("lat,lng", [(91.0, 0.0), (-90.5, 0.0), (0.0, 181.0), (0.0, -180.5)])
    def test_out_of_range_is_rejected(self, fake_reader, lat, lng):
        fake_reader({"location": {"latitude": lat, "longitude": lng}})
        assert geo_for_ip("8.8.8.8").latitude is None

    def test_boundaries_are_kept(self, fake_reader):
        fake_reader({"location": {"latitude": 90.0, "longitude": -180.0}})
        geo = geo_for_ip("8.8.8.8")
        assert (geo.latitude, geo.longitude) == (90.0, -180.0)

    def test_half_a_coordinate_is_no_coordinate(self, fake_reader):
        """A bubble needs a pair; keeping the good half would make
        `latitude IS NOT NULL` claim something is plottable when it is not."""
        fake_reader({"location": {"latitude": 37.422}})
        geo = geo_for_ip("8.8.8.8")
        assert (geo.latitude, geo.longitude) == (None, None)

    def test_integer_coordinates_become_floats(self, fake_reader):
        fake_reader({"location": {"latitude": 37, "longitude": -122}})
        geo = geo_for_ip("8.8.8.8")
        assert (geo.latitude, geo.longitude) == (37.0, -122.0)


class TestRoundingAndTruncation:
    def test_coordinates_round_to_two_decimals(self, fake_reader):
        """Free-tier points are city centroids; more digits would be
        precision the source does not have."""
        fake_reader({"location": {"latitude": 40.123456, "longitude": -74.987654}})
        geo = geo_for_ip("8.8.8.8")
        assert geo.latitude == 40.12
        assert geo.longitude == -74.99

    def test_long_names_are_cut_to_the_column_width(self, fake_reader):
        fake_reader(
            {
                "city": {"names": {"en": "C" * 100}},
                "subdivisions": [{"names": {"en": "R" * 100}}],
            }
        )
        geo = geo_for_ip("8.8.8.8")
        assert len(geo.city) == 80
        assert len(geo.region) == 80

    def test_a_real_long_name_survives_intact(self, fake_reader):
        """The cap is a guard, not a policy — no real place name reaches it."""
        name = "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch"
        fake_reader({"city": {"names": {"en": name}}})
        assert geo_for_ip("8.8.8.8").city == name

    def test_blank_names_become_none_not_empty_strings(self, fake_reader):
        fake_reader({"city": {"names": {"en": "   "}}, "subdivisions": [{"names": {"en": ""}}]})
        geo = geo_for_ip("8.8.8.8")
        assert geo.city is None
        assert geo.region is None


class TestDatabaseSelection:
    def test_city_database_is_preferred(self, monkeypatch, tmp_path):
        opened: list[str] = []
        city = tmp_path / "city.mmdb"
        country = tmp_path / "country.mmdb"
        city.write_bytes(b"x")
        country.write_bytes(b"x")
        monkeypatch.setattr(geoip, "CITY_DB_PATH", city)
        monkeypatch.setattr(geoip, "COUNTRY_DB_PATH", country)
        monkeypatch.setattr(
            geoip.maxminddb,
            "open_database",
            lambda path: opened.append(path) or FakeReader(FULL_RECORD),
        )
        assert geo_for_ip("8.8.8.8").city == "Mountain View"
        assert opened == [str(city)]

    def test_country_database_backs_up_a_missing_city_file(self, monkeypatch, tmp_path):
        """A plain checkout has only the committed country file, and must
        still geolocate — at country resolution."""
        opened: list[str] = []
        country = tmp_path / "country.mmdb"
        country.write_bytes(b"x")
        monkeypatch.setattr(geoip, "CITY_DB_PATH", tmp_path / "absent.mmdb")
        monkeypatch.setattr(geoip, "COUNTRY_DB_PATH", country)
        monkeypatch.setattr(
            geoip.maxminddb,
            "open_database",
            lambda path: opened.append(path) or FakeReader({"country": {"iso_code": "US"}}),
        )
        assert geo_for_ip("8.8.8.8") == GeoResult(country="US")
        assert opened == [str(country)]

    def test_a_corrupt_city_file_falls_through_to_the_country_file(self, monkeypatch, tmp_path):
        """Present but unreadable is not the same as absent — the exists()
        check alone would leave the fallback unreached."""
        city = tmp_path / "city.mmdb"
        country = tmp_path / "country.mmdb"
        city.write_bytes(b"not a database")
        country.write_bytes(b"x")
        monkeypatch.setattr(geoip, "CITY_DB_PATH", city)
        monkeypatch.setattr(geoip, "COUNTRY_DB_PATH", country)

        def opener(path):
            if path == str(city):
                raise OSError("corrupt")
            return FakeReader({"country": {"iso_code": "FR"}})

        monkeypatch.setattr(geoip.maxminddb, "open_database", opener)
        assert geo_for_ip("8.8.8.8").country == "FR"

    def test_no_database_at_all_is_empty_with_no_retry_storm(self, monkeypatch, tmp_path):
        """Both files unreadable: the open-failure memo must stop the second
        request re-attempting. Without it this reopens on every page view."""
        attempts: list[str] = []
        for name in ("city.mmdb", "country.mmdb"):
            (tmp_path / name).write_bytes(b"not a database")
        monkeypatch.setattr(geoip, "CITY_DB_PATH", tmp_path / "city.mmdb")
        monkeypatch.setattr(geoip, "COUNTRY_DB_PATH", tmp_path / "country.mmdb")

        def opener(path):
            attempts.append(path)
            raise OSError("corrupt")

        monkeypatch.setattr(geoip.maxminddb, "open_database", opener)
        assert geo_for_ip("8.8.8.8") == EMPTY_GEO
        assert len(attempts) == 2  # tried city, then country
        assert geoip._open_failed is True
        for _ in range(5):
            assert geo_for_ip("8.8.8.8") == EMPTY_GEO
        assert len(attempts) == 2, f"reopened per request: {attempts}"

    def test_reset_clears_the_reader_too(self, fake_reader):
        fake_reader(FULL_RECORD)
        assert geo_for_ip("8.8.8.8").city == "Mountain View"
        reset_geoip()
        assert geoip._reader is None


class TestTrackStampsCityColumns:
    """POST /api/track writes all five geo columns from the one lookup."""

    def _fake_geo(self, monkeypatch, result):
        from app.routes import analytics as analytics_route

        monkeypatch.setattr(analytics_route, "geo_for_ip", lambda ip: result)

    def _row(self, db, session_id):
        return db.query(PageView).filter(PageView.session_id == session_id).one()

    def test_full_result_lands_in_every_column(self, client, db, monkeypatch):
        self._fake_geo(
            monkeypatch,
            GeoResult(
                country="US",
                region="New York",
                city="Lake Ronkonkoma",
                latitude=40.83,
                longitude=-73.12,
            ),
        )
        resp = client.post("/api/track", json={"path": "/", "session_id": "city-1"})
        assert resp.status_code == 204
        row = self._row(db, "city-1")
        assert (row.country, row.region, row.city) == ("US", "New York", "Lake Ronkonkoma")
        assert (row.latitude, row.longitude) == (40.83, -73.12)

    def test_failed_lookup_still_stores_the_view(self, client, db, monkeypatch):
        """Fail-open: geo is never a reason for a page view to go missing."""
        self._fake_geo(monkeypatch, EMPTY_GEO)
        resp = client.post("/api/track", json={"path": "/", "session_id": "city-2"})
        assert resp.status_code == 204
        row = self._row(db, "city-2")
        assert row.country is None
        assert (row.region, row.city, row.latitude, row.longitude) == (None, None, None, None)

    def test_country_only_result_leaves_city_columns_null(self, client, db, monkeypatch):
        self._fake_geo(monkeypatch, GeoResult(country="JP"))
        client.post("/api/track", json={"path": "/", "session_id": "city-3"})
        row = self._row(db, "city-3")
        assert row.country == "JP"
        assert (row.region, row.city, row.latitude, row.longitude) == (None, None, None, None)

    def test_the_stored_name_is_already_truncated(self, client, db, monkeypatch):
        """End to end through the REAL parser (only the reader is faked):
        SQLite ignores VARCHAR(80), so if the 80 were not enforced in Python,
        Postgres would be the first thing to notice — in production."""
        monkeypatch.setattr(geoip, "_reader", FakeReader({"city": {"names": {"en": "C" * 100}}}))
        monkeypatch.setattr(geoip, "_open_failed", False)
        client.post(
            "/api/track",
            json={"path": "/", "session_id": "city-4"},
            headers={"X-Real-IP": "8.8.8.8"},
        )
        assert len(self._row(db, "city-4").city) == 80


class TestSchema:
    def test_new_columns_are_nullable_with_the_documented_widths(self):
        columns = PageView.__table__.c
        # SQLite ignores VARCHAR lengths at runtime — assert the metadata
        # contract instead (the established pattern for length checks).
        assert columns.region.type.length == 80
        assert columns.city.type.length == 80
        for name in ("region", "city", "latitude", "longitude"):
            assert columns[name].nullable is True, name
