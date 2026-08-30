"""US state and city aggregation on GET /api/dashboard/analytics.

These are the map's two detail layers: a state choropleth (`us_states`) and a
city bubble layer (`us_cities`). Both are windowed by `days` and filtered by
`segment` exactly like the `countries` roll-up beside them — a crawler flood
must not paint a state, and neither must a view from last year.

`region_tracked_since` is the third addition and answers a different question
from the existing `geo_tracked_since`: country capture started at migration
040, city detail at 048, and the panel must not claim the finer data reaches
back to the older date."""

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
        "country": "US",
    }
    fields.update(kwargs)
    return PageView(**fields)


def _get(client, auth_header, **params):
    resp = client.get("/api/dashboard/analytics", headers=auth_header(), params=params)
    assert resp.status_code == 200
    return resp.json()


def _core(row):
    """A city row without its intel fields (visitors/last_seen/networks/
    devices) — for tests about grouping and ordering, where a nondeterministic
    `last_seen` timestamp would poison exact equality. The intel fields get
    their own class below."""
    return {k: row[k] for k in ("city", "region", "lat", "lng", "views")}


class TestUsStates:
    def _seed(self, db):
        """NY: 3 views over 2 sessions. CA: 2 views, 2 sessions. TX: 1."""
        db.add_all(
            [
                _view("ny-a", region="New York", city="New York", latitude=40.71, longitude=-74.0),
                _view("ny-a", region="New York", city="New York", latitude=40.71, longitude=-74.0),
                _view("ny-b", region="New York", city="Albany", latitude=42.65, longitude=-73.76),
                _view(
                    "ca-a", region="California", city="San Jose", latitude=37.34, longitude=-121.89
                ),
                _view(
                    "ca-b", region="California", city="San Jose", latitude=37.34, longitude=-121.89
                ),
                _view("tx-a", region="Texas", city="Austin", latitude=30.27, longitude=-97.74),
            ]
        )
        db.commit()

    def test_ordering_and_visitor_counts(self, client, db, seeded_db, auth_header):
        self._seed(db)
        assert _get(client, auth_header)["us_states"] == [
            {"name": "New York", "views": 3, "visitors": 2},
            {"name": "California", "views": 2, "visitors": 2},
            {"name": "Texas", "views": 1, "visitors": 1},
        ]

    def test_visitors_is_distinct_sessions_not_views(self, client, db, seeded_db, auth_header):
        """Three NY views from two sessions: 3 views, 2 visitors. A plain
        count would report 3 people in New York."""
        self._seed(db)
        new_york = _get(client, auth_header)["us_states"][0]
        assert (new_york["views"], new_york["visitors"]) == (3, 2)

    def test_non_us_regions_are_excluded(self, client, db, seeded_db, auth_header):
        """`region` outside the US is a province or a prefecture — it belongs
        on neither US layer."""
        self._seed(db)
        db.add_all(
            [
                _view("de-1", country="DE", region="Bavaria", city="Munich"),
                _view("ca-1", country="CA", region="Quebec", city="Montreal"),
            ]
        )
        db.commit()
        names = {row["name"] for row in _get(client, auth_header)["us_states"]}
        assert names == {"New York", "California", "Texas"}

    def test_us_rows_without_a_region_are_excluded(self, client, db, seeded_db, auth_header):
        """A country-lite lookup resolves US and nothing else; that view is
        counted in `countries` and must not become a nameless state."""
        self._seed(db)
        db.add(_view("us-noregion", region=None))
        db.commit()
        data = _get(client, auth_header)
        assert [row["name"] for row in data["us_states"]] == ["New York", "California", "Texas"]
        assert sum(row["views"] for row in data["us_states"]) == 6

    def test_bot_views_do_not_paint_a_state(self, client, db, seeded_db, auth_header):
        self._seed(db)
        db.add_all([_view(f"bot-{i}", region="Wyoming", user_agent=BOT_UA) for i in range(9)])
        db.commit()
        humans = {row["name"] for row in _get(client, auth_header)["us_states"]}
        assert "Wyoming" not in humans
        bots = _get(client, auth_header, segment="bots")["us_states"]
        assert bots == [{"name": "Wyoming", "views": 9, "visitors": 9}]

    def test_the_window_applies(self, client, db, seeded_db, auth_header):
        self._seed(db)
        db.add(
            _view(
                "old-1",
                region="Ohio",
                created_at=datetime.now(UTC) - timedelta(days=90),
            )
        )
        db.commit()
        assert "Ohio" not in {r["name"] for r in _get(client, auth_header, days=30)["us_states"]}
        assert "Ohio" in {r["name"] for r in _get(client, auth_header, days=365)["us_states"]}

    def test_empty_when_there_is_no_us_data(self, client, db, seeded_db, auth_header):
        db.add(_view("de-only", country="DE", region="Bavaria"))
        db.commit()
        assert _get(client, auth_header)["us_states"] == []


class TestUsCities:
    def test_grouping_and_shape(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view("c1", region="New York", city="Albany", latitude=42.65, longitude=-73.76),
                _view("c2", region="New York", city="Albany", latitude=42.65, longitude=-73.76),
                _view("c3", region="Texas", city="Austin", latitude=30.27, longitude=-97.74),
            ]
        )
        db.commit()
        assert [_core(c) for c in _get(client, auth_header)["us_cities"]] == [
            {"city": "Albany", "region": "New York", "lat": 42.65, "lng": -73.76, "views": 2},
            {"city": "Austin", "region": "Texas", "lat": 30.27, "lng": -97.74, "views": 1},
        ]

    def test_same_name_in_two_states_stays_two_bubbles(self, client, db, seeded_db, auth_header):
        """REGION is what makes a name a place: Springfield MA and Springfield
        IL are different pins even though the label matches."""
        db.add_all(
            [
                _view(
                    "s1",
                    region="Massachusetts",
                    city="Springfield",
                    latitude=42.1,
                    longitude=-72.59,
                ),
                _view("s2", region="Illinois", city="Springfield", latitude=39.8, longitude=-89.64),
            ]
        )
        db.commit()
        cities = _get(client, auth_header)["us_cities"]
        assert len(cities) == 2
        assert {c["region"] for c in cities} == {"Massachusetts", "Illinois"}

    def test_a_city_without_a_point_is_not_a_bubble(self, client, db, seeded_db, auth_header):
        """It still counts toward its state — it just cannot be plotted."""
        db.add_all(
            [
                _view("p1", region="Nevada", city="Reno", latitude=39.53, longitude=-119.81),
                _view("p2", region="Nevada", city="Elko", latitude=None, longitude=None),
            ]
        )
        db.commit()
        data = _get(client, auth_header)
        assert [c["city"] for c in data["us_cities"]] == ["Reno"]
        assert data["us_states"] == [{"name": "Nevada", "views": 2, "visitors": 2}]

    def test_a_bubble_may_have_no_region(self, client, db, seeded_db, auth_header):
        """City known, subdivision absent — a real free-tier record shape.
        The pin is still plottable, so it is still returned."""
        db.add(_view("nr-1", region=None, city="Somewhere", latitude=41.0, longitude=-72.0))
        db.commit()
        assert [_core(c) for c in _get(client, auth_header)["us_cities"]] == [
            {"city": "Somewhere", "region": None, "lat": 41.0, "lng": -72.0, "views": 1}
        ]

    def test_non_us_cities_are_excluded(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view("us-1", region="Maine", city="Portland", latitude=43.66, longitude=-70.26),
                _view(
                    "ca-1",
                    country="CA",
                    region="Quebec",
                    city="Montreal",
                    latitude=45.5,
                    longitude=-73.57,
                ),
            ]
        )
        db.commit()
        assert [c["city"] for c in _get(client, auth_header)["us_cities"]] == ["Portland"]

    def test_limited_to_sixty_most_viewed(self, client, db, seeded_db, auth_header):
        """80 distinct cities, each with a distinct view count so the cut is
        unambiguous: the busiest 60 survive, ordered."""
        for i in range(80):
            db.add_all(
                [
                    _view(
                        f"lim-{i}-{n}",
                        region="Iowa",
                        city=f"City{i:02d}",
                        latitude=40.0 + i / 100,
                        longitude=-90.0,
                    )
                    for n in range(i + 1)
                ]
            )
        db.commit()
        cities = _get(client, auth_header)["us_cities"]
        assert len(cities) == 60
        assert _core(cities[0]) == {
            "city": "City79",
            "region": "Iowa",
            "lat": 40.79,
            "lng": -90.0,
            "views": 80,
        }
        assert cities[-1]["views"] == 21  # City20 — the 60th busiest

    def test_bots_and_the_window_apply(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view("live", region="Utah", city="Provo", latitude=40.23, longitude=-111.66),
                _view(
                    "botc",
                    region="Utah",
                    city="Ogden",
                    latitude=41.22,
                    longitude=-111.97,
                    user_agent=BOT_UA,
                ),
                _view(
                    "oldc",
                    region="Utah",
                    city="Orem",
                    latitude=40.29,
                    longitude=-111.69,
                    created_at=datetime.now(UTC) - timedelta(days=90),
                ),
            ]
        )
        db.commit()
        assert [c["city"] for c in _get(client, auth_header, days=30)["us_cities"]] == ["Provo"]


class TestRegionTrackedSince:
    """Same sticky-cache contract as `geo_tracked_since`, and a SEPARATE
    stamp: city capture began months after country capture, and one shared
    value would backdate the finer data over history that has none."""

    def _seed(self, db):
        now = datetime.now(UTC)
        # The first region-bearing row sits far outside any short window.
        db.add_all(
            [
                _view("rt-old", region="Ohio", created_at=now - timedelta(days=200)),
                _view("rt-mid", region="Ohio", created_at=now - timedelta(days=100)),
                _view("rt-new", region="Ohio", created_at=now - timedelta(days=1)),
            ]
        )
        db.commit()
        return now - timedelta(days=200)

    def test_ignores_the_window(self, client, db, seeded_db, auth_header):
        oldest = self._seed(db)
        stamps = {
            days: _get(client, auth_header, days=days)["region_tracked_since"]
            for days in (7, 30, 365)
        }
        assert len(set(stamps.values())) == 1, f"stamp moved with the window: {stamps}"
        assert str(oldest.date()) in stamps[7]

    def test_ignores_the_segment(self, client, db, seeded_db, auth_header):
        self._seed(db)
        stamps = {
            seg: _get(client, auth_header, days=30, segment=seg)["region_tracked_since"]
            for seg in ("humans", "bots", "all")
        }
        assert len(set(stamps.values())) == 1, f"stamp moved with the segment: {stamps}"

    def test_null_is_not_cached_so_the_first_row_lands(self, client, db, seeded_db, auth_header):
        """An empty database answers "not yet". Caching that None would pin it
        forever and the panel would never start reporting."""
        assert _get(client, auth_header)["region_tracked_since"] is None
        self._seed(db)
        assert _get(client, auth_header)["region_tracked_since"] is not None

    def test_a_known_stamp_is_not_re_queried(self, client, db, seeded_db, auth_header):
        """Sticky by design: once known it is held in process, so a row
        inserted with an EARLIER date does not move it until a restart. That
        is the trade the cache buys — the query never runs twice — and the
        only thing that could move it is a backfill, which cannot happen here
        (ip_hash is one-way)."""
        first = _get(client, auth_header, days=365)["region_tracked_since"]
        self._seed(db)
        held = _get(client, auth_header, days=365)["region_tracked_since"]
        assert first is None and held is not None

        db.add(_view("rt-older", region="Ohio", created_at=datetime.now(UTC) - timedelta(days=400)))
        db.commit()
        assert _get(client, auth_header, days=365)["region_tracked_since"] == held

        from app.routes.analytics import reset_analytics_state

        reset_analytics_state()
        assert _get(client, auth_header, days=365)["region_tracked_since"] != held

    def test_country_only_history_does_not_set_it(self, client, db, seeded_db, auth_header):
        """The whole reason this is its own stamp: rows with a country and no
        region are exactly what the pre-048 history looks like."""
        db.add(_view("pre-city", region=None, created_at=datetime.now(UTC) - timedelta(days=300)))
        db.commit()
        data = _get(client, auth_header, days=365)
        assert data["geo_tracked_since"] is not None  # country capture had started
        assert data["region_tracked_since"] is None  # city capture had not

    def test_the_two_stamps_are_independent(self, client, db, seeded_db, auth_header):
        now = datetime.now(UTC)
        db.add_all(
            [
                _view("cty", region=None, created_at=now - timedelta(days=300)),
                _view("rgn", region="Ohio", created_at=now - timedelta(days=10)),
            ]
        )
        db.commit()
        data = _get(client, auth_header, days=365)
        assert str((now - timedelta(days=300)).date()) in data["geo_tracked_since"]
        assert str((now - timedelta(days=10)).date()) in data["region_tracked_since"]


class TestPayloadIsAdditive:
    def test_existing_geo_fields_are_untouched(self, client, db, seeded_db, auth_header):
        db.add_all(
            [
                _view("keep-1", region="Ohio", city="Columbus", latitude=39.96, longitude=-83.0),
                _view("keep-2", country=None),
            ]
        )
        db.commit()
        data = _get(client, auth_header)
        assert data["countries"] == [{"code": "US", "views": 1, "visitors": 1}]
        assert data["geo_unknown_views"] == 1
        for key in ("us_states", "us_cities", "region_tracked_since"):
            assert key in data


class TestUsCityIntel:
    """The dot-click card's data: visitors, last_seen, networks, devices —
    stamped per city row, same window and segment as the row itself."""

    def _seed_one_city(self, db, **overrides):
        base = {"region": "New York", "city": "Ronkonkoma", "latitude": 40.82, "longitude": -73.11}
        base.update(overrides)
        return _view(base.pop("session_id"), **base)

    def test_visitors_are_distinct_sessions(self, client, db, seeded_db, auth_header):
        for sid in ("v-a", "v-a", "v-a", "v-b"):
            db.add(self._seed_one_city(db, session_id=sid))
        db.commit()
        (row,) = _get(client, auth_header)["us_cities"]
        assert (row["views"], row["visitors"]) == (4, 2)

    def test_last_seen_is_the_newest_view(self, client, db, seeded_db, auth_header):
        now = datetime.now(UTC)
        newest = now - timedelta(days=2)
        db.add(self._seed_one_city(db, session_id="ls-1", created_at=now - timedelta(days=9)))
        db.add(self._seed_one_city(db, session_id="ls-2", created_at=newest))
        db.commit()
        (row,) = _get(client, auth_header)["us_cities"]
        assert row["last_seen"] is not None
        assert row["last_seen"].startswith(str(newest.date()))

    def test_networks_are_the_top_three_by_views(self, client, db, seeded_db, auth_header):
        counts = {"Verizon Fios": 5, "Optimum Online": 4, "Spectrum": 3, "Comcast Cable": 2}
        for name, n in counts.items():
            for i in range(n):
                db.add(self._seed_one_city(db, session_id=f"nw-{name}-{i}", network=name))
        db.add(self._seed_one_city(db, session_id="nw-null", network=None))
        db.commit()
        (row,) = _get(client, auth_header)["us_cities"]
        # Top THREE, busiest first; the fourth network and the NULL row are
        # summarised only by the dot's own view count.
        assert row["networks"] == [
            {"name": "Verizon Fios", "views": 5},
            {"name": "Optimum Online", "views": 4},
            {"name": "Spectrum", "views": 3},
        ]
        assert row["views"] == 15

    def test_a_city_with_no_network_rows_gets_an_empty_list(
        self, client, db, seeded_db, auth_header
    ):
        db.add(self._seed_one_city(db, session_id="nn-1"))
        db.commit()
        (row,) = _get(client, auth_header)["us_cities"]
        assert row["networks"] == []
        assert row["devices"] == []

    def test_devices_split_by_type(self, client, db, seeded_db, auth_header):
        for i in range(3):
            db.add(self._seed_one_city(db, session_id=f"dv-d-{i}", device_type="desktop"))
        db.add(self._seed_one_city(db, session_id="dv-m", device_type="mobile"))
        db.commit()
        (row,) = _get(client, auth_header)["us_cities"]
        assert row["devices"] == [
            {"type": "desktop", "views": 3},
            {"type": "mobile", "views": 1},
        ]

    def test_breakdowns_respect_the_segment(self, client, db, seeded_db, auth_header):
        db.add(self._seed_one_city(db, session_id="sg-h", network="Verizon Fios"))
        for i in range(5):
            db.add(
                self._seed_one_city(
                    db, session_id=f"sg-b-{i}", network="CrawlerNet", user_agent=BOT_UA
                )
            )
        db.commit()
        (human_row,) = _get(client, auth_header)["us_cities"]
        assert human_row["networks"] == [{"name": "Verizon Fios", "views": 1}]
        (bot_row,) = _get(client, auth_header, segment="bots")["us_cities"]
        assert bot_row["networks"] == [{"name": "CrawlerNet", "views": 5}]

    def test_breakdowns_respect_the_window(self, client, db, seeded_db, auth_header):
        old = datetime.now(UTC) - timedelta(days=90)
        db.add(self._seed_one_city(db, session_id="wn-new", network="Verizon Fios"))
        db.add(self._seed_one_city(db, session_id="wn-old", network="Frontier", created_at=old))
        db.commit()
        (row,) = _get(client, auth_header, days=30)["us_cities"]
        assert row["networks"] == [{"name": "Verizon Fios", "views": 1}]


class TestMetroGrouping:
    """DB-IP resolves many addresses to sub-city districts: same (stripped)
    label, same region, DIFFERENT centroid. One metro must stay one bubble."""

    def test_district_centroids_merge_into_one_bubble_at_their_mean(
        self, client, db, seeded_db, auth_header
    ):
        db.add_all(
            [
                _view("m-1", region="New York", city="New York", latitude=40.75, longitude=-73.99),
                _view("m-2", region="New York", city="New York", latitude=40.81, longitude=-73.95),
            ]
        )
        db.commit()
        (row,) = _get(client, auth_header)["us_cities"]
        assert row["views"] == 2
        assert (row["lat"], row["lng"]) == (40.78, -73.97)

    def test_the_merged_bubble_owns_all_of_the_metro_intel(
        self, client, db, seeded_db, auth_header
    ):
        db.add_all(
            [
                _view(
                    "mi-1",
                    region="New York",
                    city="New York",
                    latitude=40.75,
                    longitude=-73.99,
                    network="Verizon Fios",
                ),
                _view(
                    "mi-2",
                    region="New York",
                    city="New York",
                    latitude=40.81,
                    longitude=-73.95,
                    network="Spectrum",
                ),
            ]
        )
        db.commit()
        (row,) = _get(client, auth_header)["us_cities"]
        assert row["visitors"] == 2
        assert {n["name"] for n in row["networks"]} == {"Verizon Fios", "Spectrum"}


class TestBreakdownIsolation:
    def test_two_cities_never_share_each_others_networks_or_devices(
        self, client, db, seeded_db, auth_header
    ):
        """The bucket key is built by hand in two places — this is the test
        that goes red if either ever drops half the key."""
        db.add_all(
            [
                _view(
                    "iso-a",
                    region="Texas",
                    city="Austin",
                    latitude=30.27,
                    longitude=-97.74,
                    network="AT&T Internet",
                    device_type="desktop",
                ),
                _view(
                    "iso-b",
                    region="Illinois",
                    city="Chicago",
                    latitude=41.88,
                    longitude=-87.63,
                    network="Comcast Cable",
                    device_type="mobile",
                ),
            ]
        )
        db.commit()
        cities = {c["city"]: c for c in _get(client, auth_header)["us_cities"]}
        assert cities["Austin"]["networks"] == [{"name": "AT&T Internet", "views": 1}]
        assert cities["Austin"]["devices"] == [{"type": "desktop", "views": 1}]
        assert cities["Chicago"]["networks"] == [{"name": "Comcast Cable", "views": 1}]
        assert cities["Chicago"]["devices"] == [{"type": "mobile", "views": 1}]
