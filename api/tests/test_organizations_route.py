"""GET /api/dashboard/organizations — which companies are visiting the site.

The panel's whole claim is specificity: a row names an organization, says how
many distinct PEOPLE came from it, where they were, and what they read. These
tests pin the parts of that claim that could quietly become false — the
segment and window the map beside it already uses, "visitors" meaning distinct
sessions rather than page views, the top-N cuts, and the summary counts the
filter chips are drawn from.

Same fixtures and the same shape as test_analytics_us_geo.py.
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

CORP = "Cirrus Logic Inc."
ISP = "Verizon Business"
HOST = "Hetzner Online GmbH"


def _view(session_id, **kwargs):
    fields = {
        "path": "/",
        "session_id": session_id,
        "user_agent": HUMAN_UA,
        "country": "US",
        "network": CORP,
    }
    fields.update(kwargs)
    return PageView(**fields)


def _get(client, auth_header, **params):
    resp = client.get("/api/dashboard/organizations", headers=auth_header(), params=params)
    assert resp.status_code == 200
    return resp.json()


def _orgs(client, auth_header, **params):
    return _get(client, auth_header, **params)["organizations"]


def _by_name(client, auth_header, **params):
    return {o["name"]: o for o in _orgs(client, auth_header, **params)}


class TestTheWall:
    """The same gate every other dashboard route carries. There is no demo
    account to exempt any more (alembic 044 deleted the row); the wall the
    route has to hold is customer-versus-staff."""

    def test_unauthenticated_is_401(self, client, seeded_db):
        assert client.get("/api/dashboard/organizations").status_code == 401

    def test_a_customer_account_is_refused(self, client, seeded_db, auth_header):
        """A signed-in customer is still a stranger to this data: it names
        other companies' visits, not their own."""
        resp = client.get(
            "/api/dashboard/organizations",
            headers=auth_header(email="kennedy_user@test.example"),
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "staff_only"

    def test_staff_are_admitted(self, client, seeded_db, auth_header):
        assert client.get("/api/dashboard/organizations", headers=auth_header()).status_code == 200

    def test_an_invalid_segment_is_422(self, client, seeded_db, auth_header):
        resp = client.get(
            "/api/dashboard/organizations",
            headers=auth_header(),
            params={"segment": "martians"},
        )
        assert resp.status_code == 422


class TestOrdering:
    def test_ordered_by_distinct_visitors_not_views(self, client, db, seeded_db, auth_header):
        """One person reading ten pages must not outrank three people reading
        one each — the owner's question is how many PEOPLE came."""
        db.add_all([_view("loud", network="Loud Corp") for _ in range(10)])
        db.add_all([_view(f"crowd-{i}", network="Crowd Corp") for i in range(3)])
        db.commit()
        rows = _orgs(client, auth_header)
        assert [r["name"] for r in rows] == ["Crowd Corp", "Loud Corp"]
        assert (rows[0]["visitors"], rows[0]["views"]) == (3, 3)
        assert (rows[1]["visitors"], rows[1]["views"]) == (1, 10)

    def test_views_break_a_visitor_tie(self, client, db, seeded_db, auth_header):
        db.add_all([_view("a", network="Busier Corp") for _ in range(4)])
        db.add(_view("b", network="Quieter Corp"))
        db.commit()
        assert [r["name"] for r in _orgs(client, auth_header)] == [
            "Busier Corp",
            "Quieter Corp",
        ]

    def test_the_name_breaks_a_total_tie_so_the_order_is_stable(
        self, client, db, seeded_db, auth_header
    ):
        db.add_all([_view("z", network="Zeta Corp"), _view("a", network="Alpha Corp")])
        db.commit()
        assert [r["name"] for r in _orgs(client, auth_header)] == ["Alpha Corp", "Zeta Corp"]


class TestTheWindowAndTheSegment:
    """The map above this panel is windowed and segmented; a row here that
    disagreed with it would be worse than no row."""

    def test_the_window_applies(self, client, db, seeded_db, auth_header):
        old = datetime.now(UTC) - timedelta(days=90)
        db.add(_view("now", network="Recent Corp"))
        db.add(_view("then", network="Ancient Corp", created_at=old))
        db.commit()
        assert [r["name"] for r in _orgs(client, auth_header, days=30)] == ["Recent Corp"]
        assert {r["name"] for r in _orgs(client, auth_header, days=365)} == {
            "Recent Corp",
            "Ancient Corp",
        }

    def test_crawlers_are_not_companies(self, client, db, seeded_db, auth_header):
        db.add(_view("human", network="Human Corp"))
        db.add_all([_view(f"bot-{i}", network="Crawler Corp", user_agent=BOT_UA) for i in range(9)])
        db.commit()
        assert [r["name"] for r in _orgs(client, auth_header)] == ["Human Corp"]
        assert [r["name"] for r in _orgs(client, auth_header, segment="bots")] == ["Crawler Corp"]
        assert {r["name"] for r in _orgs(client, auth_header, segment="all")} == {
            "Human Corp",
            "Crawler Corp",
        }

    def test_the_response_echoes_the_window_it_used(self, client, seeded_db, auth_header):
        data = _get(client, auth_header, days=7, segment="all")
        assert (data["period_days"], data["segment"]) == (7, "all")

    def test_days_is_capped_at_a_year(self, client, seeded_db, auth_header):
        assert _get(client, auth_header, days=9999)["period_days"] == 365


class TestClassification:
    def test_each_row_carries_its_kind(self, client, db, seeded_db, auth_header):
        db.add_all([_view("c", network=CORP), _view("i", network=ISP), _view("h", network=HOST)])
        db.commit()
        rows = _by_name(client, auth_header)
        assert rows[CORP]["kind"] == "corporate"
        assert rows[ISP]["kind"] == "isp"
        assert rows[HOST]["kind"] == "hosting"

    def test_the_summary_counts_partition_the_list(self, client, db, seeded_db, auth_header):
        """The filter chips are drawn from these three numbers, so they have
        to add up to the rows the panel actually received."""
        db.add_all(
            [
                _view("c1", network=CORP),
                _view("c2", network="Club Car, LLC"),
                _view("i1", network=ISP),
                _view("h1", network=HOST),
            ]
        )
        db.commit()
        data = _get(client, auth_header)
        assert (data["corporate_count"], data["isp_count"], data["hosting_count"]) == (2, 1, 1)
        assert data["corporate_count"] + data["isp_count"] + data["hosting_count"] == len(
            data["organizations"]
        )

    def test_an_empty_window_is_empty_not_absent(self, client, seeded_db, auth_header):
        data = _get(client, auth_header)
        assert data["organizations"] == []
        assert (data["corporate_count"], data["isp_count"], data["hosting_count"]) == (0, 0, 0)


class TestRowsWithoutANetwork:
    def test_a_null_network_contributes_nothing(self, client, db, seeded_db, auth_header):
        """Everything before migration 049 looks like this. Those views are
        real and are counted by /dashboard/analytics; they simply have no
        organization to name, and must not become a nameless row here."""
        db.add_all([_view(f"pre-{i}", network=None) for i in range(5)])
        db.add(_view("named", network=CORP))
        db.commit()
        data = _get(client, auth_header)
        assert [r["name"] for r in data["organizations"]] == [CORP]
        assert data["organizations"][0]["views"] == 1
        assert data["corporate_count"] == 1

    def test_a_whitespace_only_network_is_dropped(self, client, db, seeded_db, auth_header):
        """It classifies as `unknown`, and an unknown row would break the
        counts' promise to partition the list."""
        db.add(_view("blank", network="   "))
        db.add(_view("real", network=CORP))
        db.commit()
        data = _get(client, auth_header)
        assert [r["name"] for r in data["organizations"]] == [CORP]
        assert data["corporate_count"] + data["isp_count"] + data["hosting_count"] == 1


class TestFirstAndLastSeen:
    def test_the_span_of_the_visit(self, client, db, seeded_db, auth_header):
        now = datetime.now(UTC)
        first, last = now - timedelta(days=20), now - timedelta(days=2)
        db.add(_view("s1", created_at=first))
        db.add(_view("s2", created_at=last))
        db.add(_view("s3", created_at=now - timedelta(days=9)))
        db.commit()
        (row,) = _orgs(client, auth_header, days=30)
        assert row["first_seen"].startswith(str(first.date()))
        assert row["last_seen"].startswith(str(last.date()))

    def test_the_span_is_windowed_like_everything_else(self, client, db, seeded_db, auth_header):
        """ "First seen" means first seen IN THIS WINDOW. A stamp from outside
        it would contradict the row's own view count."""
        now = datetime.now(UTC)
        db.add(_view("ancient", created_at=now - timedelta(days=200)))
        db.add(_view("recent", created_at=now - timedelta(days=3)))
        db.commit()
        (row,) = _orgs(client, auth_header, days=30)
        assert row["views"] == 1
        assert row["first_seen"].startswith(str((now - timedelta(days=3)).date()))


class TestLocations:
    def test_top_three_by_views(self, client, db, seeded_db, auth_header):
        counts = {"Austin": 5, "Dallas": 4, "Houston": 3, "El Paso": 2}
        for city, n in counts.items():
            for i in range(n):
                db.add(_view(f"{city}-{i}", city=city, region="Texas"))
        db.commit()
        (row,) = _orgs(client, auth_header)
        assert row["locations"] == [
            {"city": "Austin", "region": "Texas", "country": "US", "views": 5},
            {"city": "Dallas", "region": "Texas", "country": "US", "views": 4},
            {"city": "Houston", "region": "Texas", "country": "US", "views": 3},
        ]

    def test_a_country_without_a_city_is_still_an_answer(self, client, db, seeded_db, auth_header):
        """Pre-048 history and country-lite lookups both look like this.
        "Somewhere in Germany" beats showing nothing."""
        db.add(_view("de", country="DE", city=None, region=None))
        db.commit()
        (row,) = _orgs(client, auth_header)
        assert row["locations"] == [{"city": None, "region": None, "country": "DE", "views": 1}]

    def test_a_row_with_no_place_at_all_is_not_a_location(self, client, db, seeded_db, auth_header):
        db.add(_view("nowhere", country=None, city=None, region=None))
        db.commit()
        (row,) = _orgs(client, auth_header)
        assert row["locations"] == []

    def test_same_city_name_in_two_states_stays_two_locations(
        self, client, db, seeded_db, auth_header
    ):
        db.add(_view("ma", city="Springfield", region="Massachusetts"))
        db.add(_view("il", city="Springfield", region="Illinois"))
        db.commit()
        (row,) = _orgs(client, auth_header)
        assert {loc["region"] for loc in row["locations"]} == {
            "Massachusetts",
            "Illinois",
        }


class TestWhatTheyRead:
    """The expander's payload — the part of the panel that answers "what did
    this company come here to research"."""

    def test_top_five_pages_by_views(self, client, db, seeded_db, auth_header):
        for n, path in enumerate(["/a", "/b", "/c", "/d", "/e", "/f"]):
            for i in range(6 - n):
                db.add(_view(f"{path}-{i}", path=path))
        db.commit()
        (row,) = _orgs(client, auth_header)
        assert row["top_pages"] == [
            {"path": "/a", "views": 6},
            {"path": "/b", "views": 5},
            {"path": "/c", "views": 4},
            {"path": "/d", "views": 3},
            {"path": "/e", "views": 2},
        ]

    def test_top_three_referrers_and_nulls_are_not_a_source(
        self, client, db, seeded_db, auth_header
    ):
        for ref, n in {
            "https://a.example": 4,
            "https://b.example": 3,
            "https://c.example": 2,
        }.items():
            for i in range(n):
                db.add(_view(f"{ref}-{i}", referrer=ref))
        db.add(_view("direct", referrer=None))
        db.add(_view("d.example", referrer="https://d.example"))
        db.commit()
        (row,) = _orgs(client, auth_header)
        assert [r["referrer"] for r in row["referrers"]] == [
            "https://a.example",
            "https://b.example",
            "https://c.example",
        ]

    def test_devices_split_by_type(self, client, db, seeded_db, auth_header):
        for i in range(3):
            db.add(_view(f"d-{i}", device_type="desktop"))
        db.add(_view("m", device_type="mobile"))
        db.commit()
        (row,) = _orgs(client, auth_header)
        assert row["devices"] == [
            {"type": "desktop", "views": 3},
            {"type": "mobile", "views": 1},
        ]

    def test_an_organization_with_no_detail_gets_empty_lists(
        self, client, db, seeded_db, auth_header
    ):
        """Never a fabricated placeholder — an unknown is shown as absent."""
        db.add(_view("bare", country=None, referrer=None, device_type=None))
        db.commit()
        (row,) = _orgs(client, auth_header)
        assert (row["locations"], row["referrers"], row["devices"]) == ([], [], [])
        assert row["top_pages"] == [{"path": "/", "views": 1}]

    def test_the_breakdowns_respect_the_segment_and_the_window(
        self, client, db, seeded_db, auth_header
    ):
        old = datetime.now(UTC) - timedelta(days=90)
        db.add(_view("h", path="/human", device_type="desktop"))
        db.add(_view("b", path="/bot", device_type="mobile", user_agent=BOT_UA))
        db.add(_view("o", path="/old", device_type="tablet", created_at=old))
        db.commit()
        (row,) = _orgs(client, auth_header, days=30)
        assert row["top_pages"] == [{"path": "/human", "views": 1}]
        assert row["devices"] == [{"type": "desktop", "views": 1}]


class TestBreakdownIsolation:
    def test_two_organizations_never_share_each_others_detail(
        self, client, db, seeded_db, auth_header
    ):
        """The bucket key is rebuilt by hand for four breakdowns — this is the
        test that goes red if any of them ever drops it."""
        db.add(
            _view(
                "a",
                network="Alpha Corp",
                path="/part/alpha",
                city="Austin",
                region="Texas",
                referrer="https://alpha.example",
                device_type="desktop",
            )
        )
        db.add(
            _view(
                "b",
                network="Beta Corp",
                path="/part/beta",
                city="Chicago",
                region="Illinois",
                referrer="https://beta.example",
                device_type="mobile",
            )
        )
        db.commit()
        rows = _by_name(client, auth_header)
        assert rows["Alpha Corp"]["top_pages"] == [{"path": "/part/alpha", "views": 1}]
        assert rows["Alpha Corp"]["locations"][0]["city"] == "Austin"
        assert rows["Alpha Corp"]["referrers"] == [
            {"referrer": "https://alpha.example", "views": 1}
        ]
        assert rows["Alpha Corp"]["devices"] == [{"type": "desktop", "views": 1}]
        assert rows["Beta Corp"]["top_pages"] == [{"path": "/part/beta", "views": 1}]
        assert rows["Beta Corp"]["locations"][0]["city"] == "Chicago"


class TestTheCap:
    def test_the_list_stops_at_two_hundred(self, client, db, seeded_db, auth_header):
        """A runaway guard, not a design limit — production has resolved 177
        distinct networks in its whole history. With every organization tied
        on visitors and views, the name tiebreaker decides, so the cut is
        exact rather than arbitrary."""
        for i in range(210):
            db.add(_view(f"cap-{i}", network=f"Org{i:03d} Corp"))
        db.commit()
        data = _get(client, auth_header)
        names = [r["name"] for r in data["organizations"]]
        assert len(names) == 200
        assert names[0] == "Org000 Corp"
        assert names[-1] == "Org199 Corp"

    def test_the_counts_describe_the_returned_list(self, client, db, seeded_db, auth_header):
        for i in range(210):
            db.add(_view(f"cnt-{i}", network=f"Org{i:03d} Corp"))
        db.commit()
        data = _get(client, auth_header)
        assert data["corporate_count"] == 200


class TestNetworkTrackedSince:
    """The empty state's honesty. ASN capture began at migration 049, months
    after country (040) and later than city (048), so this needs its own stamp
    — the same sticky, window-independent contract as its two siblings."""

    def test_it_ignores_the_window(self, client, db, seeded_db, auth_header):
        oldest = datetime.now(UTC) - timedelta(days=200)
        db.add(_view("old", created_at=oldest))
        db.add(_view("new"))
        db.commit()
        stamps = {
            days: _get(client, auth_header, days=days)["network_tracked_since"]
            for days in (7, 30, 365)
        }
        assert len(set(stamps.values())) == 1, f"stamp moved with the window: {stamps}"
        assert str(oldest.date()) in stamps[7]

    def test_null_is_not_cached_so_the_first_row_lands(self, client, db, seeded_db, auth_header):
        assert _get(client, auth_header)["network_tracked_since"] is None
        db.add(_view("first"))
        db.commit()
        assert _get(client, auth_header)["network_tracked_since"] is not None

    def test_rows_without_a_network_do_not_set_it(self, client, db, seeded_db, auth_header):
        """Exactly what the pre-049 history looks like."""
        db.add(_view("pre", network=None, created_at=datetime.now(UTC) - timedelta(days=300)))
        db.commit()
        assert _get(client, auth_header, days=365)["network_tracked_since"] is None

    def test_the_stamp_is_sticky_until_a_restart(self, client, db, seeded_db, auth_header):
        db.add(_view("now"))
        db.commit()
        held = _get(client, auth_header, days=365)["network_tracked_since"]
        db.add(_view("older", created_at=datetime.now(UTC) - timedelta(days=400)))
        db.commit()
        assert _get(client, auth_header, days=365)["network_tracked_since"] == held

        from app.routes.analytics import reset_analytics_state

        reset_analytics_state()
        assert _get(client, auth_header, days=365)["network_tracked_since"] != held


class TestTheSiblingRouteIsUntouched:
    def test_analytics_still_answers(self, client, db, seeded_db, auth_header):
        """The segment derivation was lifted into a shared helper; this is the
        cheap proof that the route it was lifted OUT of still works."""
        db.add(_view("s1", network=CORP))
        db.add(_view("b1", network=HOST, user_agent=BOT_UA))
        db.commit()
        resp = client.get("/api/dashboard/analytics", headers=auth_header())
        assert resp.status_code == 200
        data = resp.json()
        assert (data["human_views"], data["bot_views"]) == (1, 1)
