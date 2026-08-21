"""Segment-aware analytics aggregation (GET /api/dashboard/analytics).

The endpoint DEFAULTS to segment=humans: a crawler flood must never read
as visitors again (2026-08-20: one Meta crawler == "712 visitors")."""

from app.models.page_view import PageView

META_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/145.0.0.0 Safari/537.36 (compatible; meta-externalagent/1.1 "
    "(+https://developers.facebook.com/docs/sharing/webmasters/crawler))"
)
PERPLEXITY_UA = (
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; "
    "+https://perplexity.ai/perplexitybot)"
)
HUMAN_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/151.0.0.0 Safari/537.36"
)


def _seed_views(db):
    """3 bot views (2 Meta, 1 Perplexity — each its own session, crawler
    style), 2 human views in ONE session, 1 NULL-UA view, 1 geo'd human."""
    rows = [
        PageView(path="/part/a", session_id="m1", user_agent=META_UA),
        PageView(path="/part/b", session_id="m2", user_agent=META_UA),
        PageView(path="/part/c", session_id="p1", user_agent=PERPLEXITY_UA),
        PageView(path="/", session_id="h1", user_agent=HUMAN_UA),
        PageView(path="/bom", session_id="h1", user_agent=HUMAN_UA),
        PageView(path="/about", session_id="n1", user_agent=None),
        PageView(path="/join", session_id="h2", user_agent=HUMAN_UA, country="US"),
    ]
    db.add_all(rows)
    db.commit()


def _get(client, auth_header, **params):
    resp = client.get("/api/dashboard/analytics", headers=auth_header(), params=params)
    assert resp.status_code == 200
    return resp.json()


class TestSegments:
    def test_default_is_humans(self, client, db, seeded_db, auth_header):
        _seed_views(db)
        data = _get(client, auth_header)
        assert data["segment"] == "humans"
        # 2 human + 1 NULL-UA (no bot evidence) + 1 geo'd human = 4
        assert data["total_views"] == 4
        assert data["unique_visitors"] == 3  # h1, n1, h2

    def test_bots_segment(self, client, db, seeded_db, auth_header):
        _seed_views(db)
        data = _get(client, auth_header, segment="bots")
        assert data["total_views"] == 3
        assert data["unique_visitors"] == 3  # one session per crawler fetch

    def test_all_segment(self, client, db, seeded_db, auth_header):
        _seed_views(db)
        data = _get(client, auth_header, segment="all")
        assert data["total_views"] == 7

    def test_badge_totals_are_segment_independent(self, client, db, seeded_db, auth_header):
        _seed_views(db)
        for segment in ("humans", "bots", "all"):
            data = _get(client, auth_header, segment=segment)
            assert data["bot_views"] == 3
            assert data["human_views"] == 4

    def test_invalid_segment_is_422(self, client, seeded_db, auth_header):
        resp = client.get(
            "/api/dashboard/analytics", headers=auth_header(), params={"segment": "martians"}
        )
        assert resp.status_code == 422

    def test_sections_respect_segment(self, client, db, seeded_db, auth_header):
        _seed_views(db)
        data = _get(client, auth_header)  # humans
        paths = {p["path"] for p in data["top_pages"]}
        assert "/part/a" not in paths  # bot-only page
        assert "/" in paths

    def test_no_bots_present_keeps_humans_working(self, client, db, seeded_db, auth_header):
        db.add(PageView(path="/", session_id="only-h", user_agent=HUMAN_UA))
        db.commit()
        data = _get(client, auth_header)
        assert data["total_views"] == 1
        data = _get(client, auth_header, segment="bots")
        assert data["total_views"] == 0


class TestCrawlerPanel:
    def test_families_named_and_ordered(self, client, db, seeded_db, auth_header):
        _seed_views(db)
        data = _get(client, auth_header)
        fams = [c["family"] for c in data["crawlers"]]
        assert fams == ["Meta", "Perplexity"]
        meta = data["crawlers"][0]
        assert meta["views"] == 2
        assert meta["sessions"] == 2
        assert meta["last_seen"] is not None

    def test_panel_present_even_on_humans_segment(self, client, db, seeded_db, auth_header):
        _seed_views(db)
        data = _get(client, auth_header, segment="humans")
        assert len(data["crawlers"]) == 2


class TestCountries:
    def test_countries_shape_and_segment(self, client, db, seeded_db, auth_header):
        _seed_views(db)
        data = _get(client, auth_header)
        assert data["countries"] == [{"code": "US", "views": 1, "visitors": 1}]
        # 3 human-segment rows lack a country (pre-geo history posture)
        assert data["geo_unknown_views"] == 3
        assert data["geo_tracked_since"] is not None

    def test_no_geo_data_yet(self, client, db, seeded_db, auth_header):
        db.add(PageView(path="/", session_id="h9", user_agent=HUMAN_UA))
        db.commit()
        data = _get(client, auth_header)
        assert data["countries"] == []
        assert data["geo_tracked_since"] is None
