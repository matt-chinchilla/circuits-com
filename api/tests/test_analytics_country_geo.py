"""GET /api/dashboard/geo/{country_code} — the drill-down for ANY country.

The map panel used to drill into the United States alone, because
/dashboard/analytics only ever aggregated `region`/`city` under
`country == "US"`. The COLUMNS were never US-only: DB-IP stamps a region, a
city and a centroid on every located page view. This route is those same two
aggregations with the country as a parameter.

What these tests pin, beyond "it returns rows":

* the **US case did not fork** — the payload this route builds for "US" is
  byte-for-byte the `us_states`/`us_cities` that /dashboard/analytics still
  ships inline, because both call the same two helpers. A future edit that
  optimises one and not the other has to break this file to do it.
* the country is a **filter, not a label** — "Western" is a province of Sri
  Lanka and a state of Australia, and a drill-down that added them together
  would be worse than one that showed nothing.
* window and segment behave exactly as they do on the map above, so a crawler
  flood cannot paint a province and last year's traffic cannot either.

`test_analytics_us_geo.py` is the sibling file and still passes unchanged —
that is the other half of the "did not fork" claim.
"""

from datetime import UTC, datetime, timedelta

from app.models.page_view import PageView

HUMAN_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/151.0.0.0 Safari/537.36"
)
BOT_UA = (
    "Mozilla/5.0 (compatible; meta-externalagent/1.1 "
    "(+https://developers.facebook.com/docs/sharing/webmasters/crawler))"
)


def _view(session_id, **kwargs):
    fields = {
        "path": "/",
        "session_id": session_id,
        "user_agent": HUMAN_UA,
        "country": "DE",
    }
    fields.update(kwargs)
    return PageView(**fields)


def _geo(client, auth_header, code="DE", **params):
    resp = client.get(f"/api/dashboard/geo/{code}", headers=auth_header(), params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _core(row):
    """A city row without its nondeterministic `last_seen`."""
    return {k: row[k] for k in ("city", "region", "lat", "lng", "views", "visitors")}


class TestTheGate:
    """Same wall as every other /dashboard route — see test_every_route_is_gated."""

    def test_anonymous_is_refused(self, client, seeded_db):
        assert client.get("/api/dashboard/geo/DE").status_code == 401

    def test_a_customer_token_is_refused(self, client, seeded_db, auth_header):
        """`require_staff`, not `get_current_user`: a signed-in customer is
        still a stranger to the analytics console."""
        resp = client.get(
            "/api/dashboard/geo/DE", headers=auth_header(email="kennedy_user@test.example")
        )
        assert resp.status_code == 403

    def test_staff_may_read(self, client, seeded_db, auth_header):
        assert client.get("/api/dashboard/geo/DE", headers=auth_header()).status_code == 200


class TestTheCountryCode:
    def test_a_well_formed_code_with_no_rows_is_not_an_error(self, client, seeded_db, auth_header):
        """A country nobody has visited is an empty drill-down, not a 404 —
        the panel renders its collecting state from exactly this."""
        data = _geo(client, auth_header, "ZW")
        assert data["country"] == "ZW"
        assert data["regions"] == []
        assert data["cities"] == []

    def test_a_malformed_code_is_refused_before_the_query(self, client, seeded_db, auth_header):
        for bad in ("USA", "1", "D", "de-BY", "%20"):
            resp = client.get(f"/api/dashboard/geo/{bad}", headers=auth_header())
            assert resp.status_code == 422, f"{bad} -> {resp.status_code}"

    def test_a_lowercase_code_finds_the_country(self, client, db, seeded_db, auth_header):
        """`geo_for_ip` stores the code uppercase. A lowercase path segment is
        a legitimate ISO alpha-2 spelling and must not silently return
        nothing."""
        db.add(_view("de-1", region="Bavaria"))
        db.commit()
        data = _geo(client, auth_header, "de")
        assert data["country"] == "DE"
        assert [r["name"] for r in data["regions"]] == ["Bavaria"]


class TestRegions:
    def _seed(self, db):
        """DE: Hesse 3 views / 2 sessions, Bavaria 2 / 2, Saxony 1 / 1."""
        db.add_all(
            [
                _view("de-a", region="Hesse", city="Frankfurt", latitude=50.11, longitude=8.68),
                _view("de-a", region="Hesse", city="Frankfurt", latitude=50.11, longitude=8.68),
                _view("de-b", region="Hesse", city="Kassel", latitude=51.31, longitude=9.49),
                _view("de-c", region="Bavaria", city="Munich", latitude=48.14, longitude=11.58),
                _view("de-d", region="Bavaria", city="Munich", latitude=48.14, longitude=11.58),
                _view("de-e", region="Saxony", city="Dresden", latitude=51.05, longitude=13.74),
            ]
        )
        db.commit()

    def test_ordering_and_visitor_counts(self, client, db, seeded_db, auth_header):
        self._seed(db)
        assert _geo(client, auth_header)["regions"] == [
            {"name": "Hesse", "views": 3, "visitors": 2},
            {"name": "Bavaria", "views": 2, "visitors": 2},
            {"name": "Saxony", "views": 1, "visitors": 1},
        ]

    def test_another_country_is_not_mixed_in(self, client, db, seeded_db, auth_header):
        """The whole point of the country scope: "Western" is a province of
        Sri Lanka AND a state of Australia."""
        self._seed(db)
        db.add_all(
            [
                _view("lk-1", country="LK", region="Western"),
                _view("au-1", country="AU", region="Western Australia"),
            ]
        )
        db.commit()
        assert {r["name"] for r in _geo(client, auth_header)["regions"]} == {
            "Hesse",
            "Bavaria",
            "Saxony",
        }
        assert _geo(client, auth_header, "LK")["regions"] == [
            {"name": "Western", "views": 1, "visitors": 1}
        ]

    def test_rows_without_a_region_are_excluded(self, client, db, seeded_db, auth_header):
        """A country-lite lookup resolves DE and nothing else; that view is
        counted in `countries` and must not become a nameless region."""
        self._seed(db)
        db.add(_view("de-noregion", region=None))
        db.commit()
        data = _geo(client, auth_header)
        assert sum(r["views"] for r in data["regions"]) == 6

    def test_equal_counts_break_ties_by_name(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view("t-1", region="Saxony"),
                _view("t-2", region="Bavaria"),
                _view("t-3", region="Hesse"),
            ]
        )
        db.commit()
        assert [r["name"] for r in _geo(client, auth_header)["regions"]] == [
            "Bavaria",
            "Hesse",
            "Saxony",
        ]

    def test_a_country_with_regions_but_no_city_points(self, client, db, seeded_db, auth_header):
        """The choropleth still paints; there is simply no bubble layer. A
        free-tier record with a subdivision and no centroid is common."""
        db.add_all(
            [
                _view("nc-1", region="Bavaria", city=None, latitude=None, longitude=None),
                _view("nc-2", region="Hesse", city="Frankfurt", latitude=None, longitude=None),
            ]
        )
        db.commit()
        data = _geo(client, auth_header)
        assert [r["name"] for r in data["regions"]] == ["Bavaria", "Hesse"]
        assert data["cities"] == []


class TestCities:
    def test_grouping_and_shape(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view("c1", region="Bavaria", city="Munich", latitude=48.14, longitude=11.58),
                _view("c2", region="Bavaria", city="Munich", latitude=48.14, longitude=11.58),
                _view("c3", region="Hesse", city="Frankfurt", latitude=50.11, longitude=8.68),
            ]
        )
        db.commit()
        assert [_core(c) for c in _geo(client, auth_header)["cities"]] == [
            {
                "city": "Munich",
                "region": "Bavaria",
                "lat": 48.14,
                "lng": 11.58,
                "views": 2,
                "visitors": 2,
            },
            {
                "city": "Frankfurt",
                "region": "Hesse",
                "lat": 50.11,
                "lng": 8.68,
                "views": 1,
                "visitors": 1,
            },
        ]

    def test_a_metro_stays_one_bubble(self, client, db, seeded_db, auth_header):
        """DB-IP resolves many addresses to sub-city districts whose labels are
        stripped at write time but whose centroids differ. Grouping on the
        POINT would fragment one metro; the centroid is averaged instead."""
        db.add_all(
            [
                _view("m1", region="Bavaria", city="Munich", latitude=48.10, longitude=11.50),
                _view("m2", region="Bavaria", city="Munich", latitude=48.20, longitude=11.60),
            ]
        )
        db.commit()
        cities = _geo(client, auth_header)["cities"]
        assert len(cities) == 1
        assert (cities[0]["lat"], cities[0]["lng"]) == (48.15, 11.55)

    def test_the_intel_fields_ride_along(self, client, db, seeded_db, auth_header):
        """The same card the US drill-down opens, so the same payload."""
        db.add_all(
            [
                _view(
                    "i1",
                    region="Bavaria",
                    city="Munich",
                    latitude=48.14,
                    longitude=11.58,
                    network="Deutsche Telekom AG",
                    device_type="desktop",
                ),
                _view(
                    "i2",
                    region="Bavaria",
                    city="Munich",
                    latitude=48.14,
                    longitude=11.58,
                    network="Vodafone GmbH",
                    device_type="mobile",
                ),
            ]
        )
        db.commit()
        city = _geo(client, auth_header)["cities"][0]
        assert [n["name"] for n in city["networks"]] == ["Deutsche Telekom AG", "Vodafone GmbH"]
        assert {d["type"] for d in city["devices"]} == {"desktop", "mobile"}
        assert city["last_seen"] is not None

    def test_another_country_is_not_mixed_in(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view("de-1", region="Bavaria", city="Munich", latitude=48.14, longitude=11.58),
                _view(
                    "ca-1",
                    country="CA",
                    region="Ontario",
                    city="Toronto",
                    latitude=43.65,
                    longitude=-79.38,
                ),
            ]
        )
        db.commit()
        assert [c["city"] for c in _geo(client, auth_header)["cities"]] == ["Munich"]
        assert [c["city"] for c in _geo(client, auth_header, "CA")["cities"]] == ["Toronto"]

    def test_limited_to_sixty_most_viewed(self, client, db, seeded_db, auth_header):
        """Same cap as the US layer, because it is the same code."""
        for i in range(70):
            db.add_all(
                [
                    _view(
                        f"lim-{i}-{n}",
                        region="Bavaria",
                        city=f"Town{i:02d}",
                        latitude=48.0 + i / 100,
                        longitude=11.0,
                    )
                    for n in range(i + 1)
                ]
            )
        db.commit()
        cities = _geo(client, auth_header)["cities"]
        assert len(cities) == 60
        assert cities[0]["city"] == "Town69"
        assert cities[-1]["views"] == 11  # Town10 — the 60th busiest


class TestWindowAndSegment:
    def test_crawler_traffic_does_not_paint_a_region(self, client, db, seeded_db, auth_header):
        db.add_all([_view(f"bot-{i}", region="Saarland", user_agent=BOT_UA) for i in range(9)])
        db.add(_view("human-1", region="Bavaria"))
        db.commit()
        assert [r["name"] for r in _geo(client, auth_header)["regions"]] == ["Bavaria"]
        assert _geo(client, auth_header, segment="bots")["regions"] == [
            {"name": "Saarland", "views": 9, "visitors": 9}
        ]
        assert {r["name"] for r in _geo(client, auth_header, segment="all")["regions"]} == {
            "Bavaria",
            "Saarland",
        }

    def test_the_window_applies_to_both_layers(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view(
                    "old-1",
                    region="Saxony",
                    city="Dresden",
                    latitude=51.05,
                    longitude=13.74,
                    created_at=datetime.now(UTC) - timedelta(days=90),
                ),
                _view("new-1", region="Bavaria", city="Munich", latitude=48.14, longitude=11.58),
            ]
        )
        db.commit()
        near = _geo(client, auth_header, days=30)
        assert [r["name"] for r in near["regions"]] == ["Bavaria"]
        assert [c["city"] for c in near["cities"]] == ["Munich"]
        far = _geo(client, auth_header, days=365)
        assert {r["name"] for r in far["regions"]} == {"Bavaria", "Saxony"}
        assert {c["city"] for c in far["cities"]} == {"Munich", "Dresden"}

    def test_the_response_echoes_its_window(self, client, seeded_db, auth_header):
        data = _geo(client, auth_header, days=7, segment="all")
        assert (data["period_days"], data["segment"]) == (7, "all")

    def test_an_invalid_segment_is_refused(self, client, seeded_db, auth_header):
        resp = client.get("/api/dashboard/geo/DE", headers=auth_header(), params={"segment": "x"})
        assert resp.status_code == 422


class TestTheUsCaseDidNotFork:
    """/dashboard/analytics still ships `us_states`/`us_cities` inline, and
    this route serves "US" — they must be the same aggregation, not two.

    Written as an equality between the two payloads rather than as two
    separate expectations, because the failure this guards against is DRIFT:
    an optimisation applied to one path and not the other.
    """

    def _seed(self, db):
        db.add_all(
            [
                _view(
                    "us-a",
                    country="US",
                    region="New York",
                    city="New York",
                    latitude=40.71,
                    longitude=-74.0,
                    network="Verizon",
                ),
                _view(
                    "us-a",
                    country="US",
                    region="New York",
                    city="New York",
                    latitude=40.71,
                    longitude=-74.0,
                    network="Verizon",
                ),
                _view(
                    "us-b",
                    country="US",
                    region="Texas",
                    city="Austin",
                    latitude=30.27,
                    longitude=-97.74,
                ),
                _view("us-c", country="US", region="Texas", city=None),
                _view("de-1", region="Bavaria", city="Munich", latitude=48.14, longitude=11.58),
            ]
        )
        db.commit()

    def test_regions_match_us_states(self, client, db, seeded_db, auth_header):
        self._seed(db)
        analytics = client.get("/api/dashboard/analytics", headers=auth_header()).json()
        assert _geo(client, auth_header, "US")["regions"] == analytics["us_states"]

    def test_cities_match_us_cities(self, client, db, seeded_db, auth_header):
        self._seed(db)
        analytics = client.get("/api/dashboard/analytics", headers=auth_header()).json()
        assert _geo(client, auth_header, "US")["cities"] == analytics["us_cities"]

    def test_they_match_under_a_narrowed_window_too(self, client, db, seeded_db, auth_header):
        self._seed(db)
        params = {"days": 7, "segment": "all"}
        analytics = client.get(
            "/api/dashboard/analytics", headers=auth_header(), params=params
        ).json()
        geo = _geo(client, auth_header, "US", **params)
        assert (geo["regions"], geo["cities"]) == (analytics["us_states"], analytics["us_cities"])


class TestRegionTrackedSince:
    def test_it_reports_the_first_located_view(self, client, db, seeded_db, auth_header):
        """A property of the DATABASE, not of the country asked for: the panel
        prints it to explain why history is thin, and the answer is the same
        wherever the reader drilled in."""
        assert _geo(client, auth_header)["region_tracked_since"] is None
        db.add(_view("since-1", region="Bavaria"))
        db.commit()
        assert _geo(client, auth_header)["region_tracked_since"] is not None
        assert (
            _geo(client, auth_header, "ZW")["region_tracked_since"]
            == _geo(client, auth_header, "DE")["region_tracked_since"]
        )


class TestGlobalTowns:
    """GET /api/dashboard/towns — the density map's identified layer.

    Same machinery as the drill-down's bubble layer (`_city_rows`) with the
    country dropped, which is the whole point: the density map and the
    choropleth now agree about what a place IS, rather than one grouping on a
    rounded coordinate and the other on a metro.
    """

    def _towns(self, client, auth_header, **params):
        resp = client.get("/api/dashboard/towns", headers=auth_header(), params=params)
        assert resp.status_code == 200, resp.text
        return resp.json()

    def test_the_gate(self, client, seeded_db, auth_header):
        assert client.get("/api/dashboard/towns").status_code == 401
        resp = client.get(
            "/api/dashboard/towns", headers=auth_header(email="kennedy_user@test.example")
        )
        assert resp.status_code == 403

    def test_it_spans_every_country(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view(
                    "t-de",
                    country="DE",
                    region="Bavaria",
                    city="Munich",
                    latitude=48.14,
                    longitude=11.58,
                ),
                _view(
                    "t-us",
                    country="US",
                    region="Texas",
                    city="Austin",
                    latitude=30.27,
                    longitude=-97.74,
                ),
                _view(
                    "t-jp",
                    country="JP",
                    region="Tokyo",
                    city="Tokyo",
                    latitude=35.69,
                    longitude=139.69,
                ),
            ]
        )
        db.commit()
        towns = self._towns(client, auth_header)["towns"]
        assert {(t["country"], t["city"]) for t in towns} == {
            ("DE", "Munich"),
            ("US", "Austin"),
            ("JP", "Tokyo"),
        }

    def test_identity_is_country_city_region(self, client, db, seeded_db, auth_header):
        """London Ontario and London England are two towns. Keyed on the name
        alone — or even on (city, region) — a GLOBAL list folds pairs like
        these together and the density map lies about where people are."""
        db.add_all(
            [
                _view(
                    "l-ca",
                    country="CA",
                    region="Ontario",
                    city="London",
                    latitude=42.98,
                    longitude=-81.24,
                ),
                _view(
                    "l-gb",
                    country="GB",
                    region="England",
                    city="London",
                    latitude=51.51,
                    longitude=-0.13,
                ),
            ]
        )
        db.commit()
        towns = self._towns(client, auth_header)["towns"]
        assert len(towns) == 2
        assert {t["country"] for t in towns} == {"CA", "GB"}

    def test_a_town_carries_the_intel_the_card_reads(self, client, db, seeded_db, auth_header):
        """The whole reason this route exists: a click on the density map has
        to open the SAME card the choropleth's dots open, with no second
        request and no fabricated fields."""
        db.add_all(
            [
                _view(
                    "i-1",
                    country="NL",
                    region="North Holland",
                    city="Amsterdam",
                    latitude=52.37,
                    longitude=4.9,
                    network="KPN B.V.",
                    device_type="desktop",
                ),
                _view(
                    "i-2",
                    country="NL",
                    region="North Holland",
                    city="Amsterdam",
                    latitude=52.37,
                    longitude=4.9,
                    network="KPN B.V.",
                    device_type="mobile",
                ),
            ]
        )
        db.commit()
        town = self._towns(client, auth_header)["towns"][0]
        assert town["city"] == "Amsterdam"
        assert town["region"] == "North Holland"
        assert town["country"] == "NL"
        assert (town["views"], town["visitors"]) == (2, 2)
        assert town["networks"] == [{"name": "KPN B.V.", "views": 2}]
        assert {d["type"] for d in town["devices"]} == {"desktop", "mobile"}
        assert town["last_seen"] is not None

    def test_a_metro_stays_one_town_with_an_averaged_centroid(
        self, client, db, seeded_db, auth_header
    ):
        db.add_all(
            [
                _view(
                    "m-1",
                    country="FR",
                    region="Île-de-France",
                    city="Paris",
                    latitude=48.8,
                    longitude=2.3,
                ),
                _view(
                    "m-2",
                    country="FR",
                    region="Île-de-France",
                    city="Paris",
                    latitude=48.9,
                    longitude=2.4,
                ),
            ]
        )
        db.commit()
        towns = self._towns(client, auth_header)["towns"]
        assert len(towns) == 1
        assert (towns[0]["lat"], towns[0]["lng"]) == (48.85, 2.35)

    def test_busiest_first(self, client, db, seeded_db, auth_header):
        db.add(_view("q-1", country="ZA", city="Quiet", latitude=1.0, longitude=1.0))
        for i in range(4):
            db.add(_view(f"b-{i}", country="ZA", city="Busy", latitude=2.0, longitude=2.0))
        db.commit()
        assert [t["city"] for t in self._towns(client, auth_header)["towns"]] == ["Busy", "Quiet"]

    def test_a_town_needs_a_name_and_a_point(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view("n-1", city="Nowhere"),  # named, unplaced
                _view("n-2", latitude=5.0, longitude=5.0),  # placed, unnamed
            ]
        )
        db.commit()
        assert self._towns(client, auth_header)["towns"] == []

    def test_the_window_and_segment_apply(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view("w-h", country="IT", city="Rome", latitude=41.9, longitude=12.5),
                _view(
                    "w-b",
                    country="IT",
                    city="Crawler",
                    latitude=1.0,
                    longitude=1.0,
                    user_agent=BOT_UA,
                ),
                _view(
                    "w-o",
                    country="IT",
                    city="Old",
                    latitude=2.0,
                    longitude=2.0,
                    created_at=datetime.now(UTC) - timedelta(days=90),
                ),
            ]
        )
        db.commit()
        assert [t["city"] for t in self._towns(client, auth_header, days=30)["towns"]] == ["Rome"]
        assert [
            t["city"] for t in self._towns(client, auth_header, days=30, segment="bots")["towns"]
        ] == ["Crawler"]
        assert {
            t["city"] for t in self._towns(client, auth_header, days=365, segment="all")["towns"]
        } == {"Rome", "Crawler", "Old"}

    def test_it_agrees_with_the_drill_down_about_a_town(self, client, db, seeded_db, auth_header):
        """Two views of one place. The density map and the country drill-down
        must not disagree about its name, its point or its numbers — they are
        the same helper, and this is what keeps them so."""
        db.add_all(
            [
                _view(
                    "a-1",
                    country="DE",
                    region="Bavaria",
                    city="Munich",
                    latitude=48.14,
                    longitude=11.58,
                    network="Telekom",
                ),
                _view(
                    "a-2",
                    country="DE",
                    region="Bavaria",
                    city="Munich",
                    latitude=48.14,
                    longitude=11.58,
                    network="Telekom",
                ),
            ]
        )
        db.commit()
        town = self._towns(client, auth_header)["towns"][0]
        city = _geo(client, auth_header, "DE")["cities"][0]
        assert town == city

    def test_the_response_echoes_its_window(self, client, seeded_db, auth_header):
        data = self._towns(client, auth_header, days=7, segment="all")
        assert (data["period_days"], data["segment"]) == (7, "all")

    def test_an_invalid_segment_is_refused(self, client, seeded_db, auth_header):
        resp = client.get("/api/dashboard/towns", headers=auth_header(), params={"segment": "x"})
        assert resp.status_code == 422
