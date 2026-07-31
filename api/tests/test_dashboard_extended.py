"""Dashboard overhaul endpoints (2026-07-30).

Covers /api/dashboard/{stats.monthly_revenue, trends, revenue-compare,
sales-reps, expenses, expenses/breakdown}, /api/admin/sales-reps, and the
Sponsor.sold_by round-trip (admin-only — must never leak to the public payload).

Two SQLite quirks shape the assertions:
  * Numeric columns come back as Decimal but serialize to a JSON STRING unless
    the route float()-casts them — several tests assert the JSON type is a
    number precisely to catch a regression there.
  * Day bucketing is America/New_York, so "today" is computed with zoneinfo
    here too; using date.today() (machine-local/UTC) would flake near midnight.
"""

import calendar
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from app.models import Category, Expense, PageView, Revenue, Sponsor

EASTERN = ZoneInfo("America/New_York")


def _today_est() -> date:
    return datetime.now(EASTERN).date()


def _auth_header(client):
    resp = client.post(
        "/api/auth/login", json={"email": "admin@test.example", "password": "testpass123"}
    )
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _month_end(first: date) -> date:
    return first.replace(day=calendar.monthrange(first.year, first.month)[1])


def _add_revenue(db, supplier, amount, period_start, period_end=None):
    row = Revenue(
        id=uuid.uuid4(),
        supplier_id=supplier.id,
        type="sponsorship",
        amount=Decimal(str(amount)),
        description="test",
        period_start=period_start,
        period_end=period_end or period_start,
    )
    db.add(row)
    db.commit()
    return row


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


class TestExtendedDashboardAuth:
    def test_all_new_endpoints_require_auth(self, client, seeded_db):
        for path in (
            "/api/dashboard/trends",
            "/api/dashboard/revenue-compare",
            "/api/dashboard/sales-reps",
            "/api/dashboard/expenses",
            "/api/dashboard/expenses/breakdown",
            "/api/admin/sales-reps",
        ):
            assert client.get(path).status_code == 401, path


# ---------------------------------------------------------------------------
# /stats — monthly_revenue
# ---------------------------------------------------------------------------


class TestMonthlyRevenue:
    def test_stats_exposes_monthly_revenue_as_a_number(self, client, seeded_db):
        resp = client.get("/api/dashboard/stats", headers=_auth_header(client))
        assert resp.status_code == 200
        data = resp.json()
        assert "monthly_revenue" in data
        # float()-cast, not a NUMERIC string.
        assert isinstance(data["monthly_revenue"], int | float)
        # Legacy fields still present.
        assert data["parts_count"] == 2
        assert data["revenue_total"] == 600.0

    def test_monthly_revenue_counts_only_the_current_month(self, client, seeded_db, db):
        first = _today_est().replace(day=1)
        _add_revenue(db, seeded_db["supplier1"], "250.50", first, _month_end(first))
        # Fully inside a prior month → excluded.
        prev_end = first - timedelta(days=1)
        _add_revenue(db, seeded_db["supplier1"], "999.00", prev_end.replace(day=1), prev_end)

        data = client.get("/api/dashboard/stats", headers=_auth_header(client)).json()
        assert data["monthly_revenue"] == 250.50

    def test_monthly_revenue_includes_a_period_spanning_the_month(self, client, seeded_db, db):
        """A contract that STARTED earlier but still covers today counts."""
        first = _today_est().replace(day=1)
        _add_revenue(
            db,
            seeded_db["supplier1"],
            "120.00",
            (first - timedelta(days=1)).replace(day=1),
            _month_end(first),
        )
        data = client.get("/api/dashboard/stats", headers=_auth_header(client)).json()
        assert data["monthly_revenue"] == 120.0


# ---------------------------------------------------------------------------
# /trends
# ---------------------------------------------------------------------------


class TestTrends:
    def test_every_series_has_exactly_n_points_ending_today(self, client, seeded_db):
        resp = client.get("/api/dashboard/trends?days=14", headers=_auth_header(client))
        assert resp.status_code == 200
        data = resp.json()
        assert data["days"] == 14

        today = _today_est()
        expected_days = [(today - timedelta(days=i)).isoformat() for i in range(13, -1, -1)]
        assert set(data["series"]) == {"parts", "suppliers", "sponsors", "revenue", "traffic"}
        for name, series in data["series"].items():
            assert len(series) == 14, name
            # No gaps, no dupes, aligned across every series.
            assert [pt["day"] for pt in series] == expected_days, name

    def test_default_window_is_30_days(self, client, seeded_db):
        data = client.get("/api/dashboard/trends", headers=_auth_header(client)).json()
        assert data["days"] == 30
        assert len(data["series"]["parts"]) == 30

    def test_window_is_clamped(self, client, seeded_db):
        data = client.get("/api/dashboard/trends?days=100000", headers=_auth_header(client)).json()
        assert data["days"] == 365
        assert len(data["series"]["traffic"]) == 365

    def test_cumulative_series_are_monotonic_and_end_at_the_total(self, client, seeded_db):
        data = client.get("/api/dashboard/trends?days=10", headers=_auth_header(client)).json()
        for name, total in (("parts", 2), ("suppliers", 2), ("sponsors", 1)):
            values = [pt["value"] for pt in data["series"][name]]
            assert values == sorted(values), f"{name} dipped"
            # Rows seeded "now" land on today's bucket; the final point is the
            # full table count either way (forward-filled, never window-local).
            assert values[-1] == total, name

    def test_traffic_is_a_zero_filled_daily_count(self, client, seeded_db, db):
        today = _today_est()
        for _ in range(3):
            db.add(
                PageView(
                    id=uuid.uuid4(),
                    path="/",
                    session_id="s1",
                    device_type="desktop",
                    browser="Chrome",
                )
            )
        db.commit()

        series = client.get("/api/dashboard/trends?days=5", headers=_auth_header(client)).json()[
            "series"
        ]["traffic"]
        by_day = {pt["day"]: pt["value"] for pt in series}
        assert by_day[today.isoformat()] == 3
        # Every other day explicitly zero-filled (not absent).
        assert sum(by_day.values()) == 3
        assert all(isinstance(v, int) for v in by_day.values())

    def test_revenue_series_is_zero_filled_and_numeric(self, client, seeded_db, db):
        today = _today_est()
        _add_revenue(db, seeded_db["supplier1"], "42.25", today)

        series = client.get("/api/dashboard/trends?days=5", headers=_auth_header(client)).json()[
            "series"
        ]["revenue"]
        by_day = {pt["day"]: pt["value"] for pt in series}
        assert by_day[today.isoformat()] == 42.25
        assert len(by_day) == 5
        assert all(isinstance(v, int | float) for v in by_day.values())
        assert sum(by_day.values()) == 42.25


# ---------------------------------------------------------------------------
# /revenue-compare
# ---------------------------------------------------------------------------


class TestRevenueCompare:
    def test_shape_newest_month_first_with_full_day_coverage(self, client, seeded_db):
        data = client.get(
            "/api/dashboard/revenue-compare?months=3", headers=_auth_header(client)
        ).json()
        months = data["months"]
        assert len(months) == 3

        today = _today_est()
        assert months[0]["key"] == f"{today.year:04d}-{today.month:02d}"
        assert months[0]["label"] == calendar.month_name[today.month]
        # Strictly descending keys → newest first.
        assert [m["key"] for m in months] == sorted([m["key"] for m in months], reverse=True)

        for month in months:
            year, mon = (int(part) for part in month["key"].split("-"))
            days_in_month = calendar.monthrange(year, mon)[1]
            assert len(month["daily"]) == days_in_month
            assert [pt["day"] for pt in month["daily"]] == list(range(1, days_in_month + 1))

    def test_revenue_lands_on_its_day_of_month_others_zero(self, client, seeded_db, db):
        today = _today_est()
        _add_revenue(db, seeded_db["supplier1"], "310.75", today)

        months = client.get(
            "/api/dashboard/revenue-compare?months=1", headers=_auth_header(client)
        ).json()["months"]
        daily = months[0]["daily"]
        assert daily[today.day - 1]["value"] == 310.75
        assert isinstance(daily[today.day - 1]["value"], int | float)
        # Future / absent days are 0, never null or missing.
        assert all(pt["value"] == 0 for pt in daily if pt["day"] != today.day)

    def test_months_param_is_clamped(self, client, seeded_db):
        months = client.get(
            "/api/dashboard/revenue-compare?months=500", headers=_auth_header(client)
        ).json()["months"]
        assert len(months) == 24


# ---------------------------------------------------------------------------
# /sales-reps
# ---------------------------------------------------------------------------


def _fresh_child(db, parent, slug):
    """A brand-new subcategory — UNIQUE(supplier_id, category_id) means a test
    can't hang a second sponsorship off seeded_db's child for supplier2."""
    cat = Category(
        id=uuid.uuid4(),
        name=slug.replace("-", " ").title(),
        slug=slug,
        icon="cpu",
        parent_id=parent.id,
        sort_order=50,
    )
    db.add(cat)
    db.commit()
    return cat


def _make_sponsor(db, supplier, category, tier, sold_by=None, amount=None, status="Active"):
    row = Sponsor(
        id=uuid.uuid4(),
        supplier_id=supplier.id,
        category_id=category.id,
        tier=tier,
        status=status,
        sold_by=sold_by,
        amount=None if amount is None else Decimal(str(amount)),
    )
    db.add(row)
    db.commit()
    return row


class TestSalesReps:
    def test_groups_by_rep_and_uses_explicit_amount(self, client, seeded_db, db):
        parent = seeded_db["parent"]
        other_child = _fresh_child(db, parent, "logic-gates")
        _make_sponsor(db, seeded_db["supplier1"], parent, "Platinum", "Anthony", "1500.00")
        _make_sponsor(db, seeded_db["supplier2"], other_child, "Silver", "Anthony", "300.00")

        data = client.get("/api/dashboard/sales-reps", headers=_auth_header(client)).json()
        reps = {r["name"]: r for r in data["reps"]}
        assert "Anthony" in reps
        assert reps["Anthony"]["total"] == 1800.0
        assert isinstance(reps["Anthony"]["total"], int | float)
        companies = {c["company"] for c in reps["Anthony"]["customers"]}
        assert companies == {"Avnet", "Kennedy Electronics"}
        tiers = {c["tier"] for c in reps["Anthony"]["customers"]}
        assert tiers == {"Platinum", "Silver"}

    def test_falls_back_to_the_tier_default_amount(self, client, seeded_db, db):
        # Lowercase tier on purpose — legacy seed casing must still resolve.
        _make_sponsor(db, seeded_db["supplier1"], seeded_db["parent"], "platinum", "Daniel")
        data = client.get("/api/dashboard/sales-reps", headers=_auth_header(client)).json()
        daniel = next(r for r in data["reps"] if r["name"] == "Daniel")
        assert daniel["total"] == 2500.0
        assert daniel["customers"][0]["tier"] == "Platinum"

    def test_excludes_expired_and_unattributed_sponsorships(self, client, seeded_db, db):
        parent = seeded_db["parent"]
        other_child = _fresh_child(db, parent, "logic-gates")
        _make_sponsor(db, seeded_db["supplier1"], parent, "Platinum", "Ronald", "100", "Expired")
        # sold_by omitted → not a rep's deal at all.
        _make_sponsor(db, seeded_db["supplier2"], other_child, "Silver", None, "900")

        data = client.get("/api/dashboard/sales-reps", headers=_auth_header(client)).json()
        assert all(r["name"] != "Ronald" for r in data["reps"])

    def test_null_status_counts_as_active(self, client, seeded_db, db):
        """Legacy seed rows omit `status`; a naive != 'Expired' filter drops them."""
        _make_sponsor(
            db, seeded_db["supplier1"], seeded_db["parent"], "Platinum", "Daniel", "700", None
        )
        data = client.get("/api/dashboard/sales-reps", headers=_auth_header(client)).json()
        daniel = next(r for r in data["reps"] if r["name"] == "Daniel")
        assert daniel["total"] == 700.0

    def test_empty_when_nothing_is_attributed(self, client, seeded_db):
        data = client.get("/api/dashboard/sales-reps", headers=_auth_header(client)).json()
        assert data["reps"] == []


class TestSeedSalesRepAttribution:
    """`_seed_sponsor_sold_by` — Demo-vs-rep attribution, fill-only-NULL semantics."""

    def test_attributes_each_active_sponsor_to_a_rep_or_demo(self, db, seeded_db):
        from app.db.seed import (
            _DEMO_SELLER,
            _SALES_REP_USERNAMES,
            _seed_admin_user,
            _seed_sponsor_sold_by,
        )

        _seed_admin_user(db)
        parent = seeded_db["parent"]
        _make_sponsor(db, seeded_db["supplier1"], parent, "Platinum", status="Active")
        _make_sponsor(
            db,
            seeded_db["supplier2"],
            _fresh_child(db, parent, "logic-gates"),
            "Silver",
            status="Active",
        )

        _seed_sponsor_sold_by(db)
        db.commit()

        # Every active sponsorship is attributed to a real rep OR the "Demo"
        # catch-all (real distributors + seeded demo suppliers -> Demo; genuine
        # hand-added accounts -> a rep). None is left unattributed.
        valid = set(_SALES_REP_USERNAMES) | {_DEMO_SELLER}
        assigned = [s.sold_by for s in db.query(Sponsor).all()]
        assert assigned, "expected the seed to attribute the active sponsors"
        assert all(name in valid for name in assigned)

    def test_is_idempotent_and_never_reshuffles(self, db, seeded_db):
        from app.db.seed import _seed_admin_user, _seed_sponsor_sold_by

        _seed_admin_user(db)
        _seed_sponsor_sold_by(db)
        db.commit()

        # An admin re-assigns a deal by hand; a re-seed must leave it alone.
        sponsor = db.query(Sponsor).first()
        sponsor.sold_by = "Ronald"
        db.commit()

        _seed_sponsor_sold_by(db)
        db.commit()
        assert db.query(Sponsor).first().sold_by == "Ronald"

    def test_no_op_without_seeded_reps(self, db, seeded_db):
        from app.db.seed import _seed_sponsor_sold_by

        _seed_sponsor_sold_by(db)
        db.commit()
        assert db.query(Sponsor).first().sold_by is None


class TestAdminSalesRepsLookup:
    def test_lists_admin_usernames(self, client, seeded_db):
        data = client.get("/api/admin/sales-reps", headers=_auth_header(client)).json()
        # conftest seeds one admin + one 'company'-role user; only admins qualify.
        assert data["reps"] == ["admin"]

    def test_includes_the_owner(self, client, db, seeded_db):
        # `owner` is a tier ABOVE admin (alembic 022). A `role == "admin"`
        # filter drops the site owner out of the sponsor form's rep list, so
        # his existing deals render as "matthew (former)" and he can't be
        # picked on a new one.
        import bcrypt

        from app.models import User

        db.add(
            User(
                username="matthew",
                email="matthew@test.example",
                password_hash=bcrypt.hashpw(b"testpass123", bcrypt.gensalt()).decode(),
                role="owner",
            )
        )
        db.commit()
        data = client.get("/api/admin/sales-reps", headers=_auth_header(client)).json()
        assert data["reps"] == ["admin", "matthew"]


# ---------------------------------------------------------------------------
# /expenses + /expenses/breakdown
# ---------------------------------------------------------------------------


def _add_expense(db, category, vendor, amount, period_start, period_end=None):
    row = Expense(
        id=uuid.uuid4(),
        category=category,
        vendor=vendor,
        amount=Decimal(str(amount)),
        description="test",
        period_start=period_start,
        period_end=period_end or period_start,
    )
    db.add(row)
    db.commit()
    return row


class TestDashboardExpenses:
    def test_compare_shape_matches_revenue_compare(self, client, seeded_db, db):
        today = _today_est()
        _add_expense(db, "infrastructure", "Amazon Web Services", "21.23", today)

        months = client.get(
            "/api/dashboard/expenses?months=3", headers=_auth_header(client)
        ).json()["months"]
        assert len(months) == 3
        assert months[0]["key"] == f"{today.year:04d}-{today.month:02d}"
        days_in_month = calendar.monthrange(today.year, today.month)[1]
        assert len(months[0]["daily"]) == days_in_month
        assert months[0]["daily"][today.day - 1]["value"] == 21.23
        assert isinstance(months[0]["daily"][today.day - 1]["value"], int | float)

    def test_breakdown_groups_current_month_by_category(self, client, seeded_db, db):
        today = _today_est()
        first = today.replace(day=1)
        _add_expense(db, "infrastructure", "Amazon Web Services", "21.23", first)
        _add_expense(db, "ai", "Anthropic", "120.00", first)
        _add_expense(db, "domain", "Name.com", "1.50", first)
        # Prior month → must NOT be counted.
        prev_end = first - timedelta(days=1)
        _add_expense(db, "email", "Hover", "500.00", prev_end.replace(day=1), prev_end)

        data = client.get("/api/dashboard/expenses/breakdown", headers=_auth_header(client)).json()
        assert data["month"] == f"{today.year:04d}-{today.month:02d}"
        assert data["total"] == 142.73
        assert isinstance(data["total"], int | float)

        categories = data["categories"]
        assert [c["category"] for c in categories] == ["ai", "infrastructure", "domain"]
        assert categories[0]["label"] == "AI / LLM"
        assert categories[0]["vendor"] == "Anthropic"
        # One entry PER CATEGORY — safe as a React key.
        assert len({c["category"] for c in categories}) == len(categories)

    def test_breakdown_merges_vendors_inside_one_category(self, client, seeded_db, db):
        first = _today_est().replace(day=1)
        _add_expense(db, "infrastructure", "Amazon Web Services", "21.23", first)
        _add_expense(db, "infrastructure", "Cloudflare", "20.00", first)

        data = client.get("/api/dashboard/expenses/breakdown", headers=_auth_header(client)).json()
        assert len(data["categories"]) == 1
        entry = data["categories"][0]
        assert entry["amount"] == 41.23
        assert entry["vendor"] == "Amazon Web Services, Cloudflare"

    def test_breakdown_empty_month(self, client, seeded_db):
        data = client.get("/api/dashboard/expenses/breakdown", headers=_auth_header(client)).json()
        assert data["total"] == 0
        assert data["categories"] == []


# ---------------------------------------------------------------------------
# Sponsor.sold_by — admin-only round trip
# ---------------------------------------------------------------------------


class TestSponsorSoldBy:
    def test_create_and_patch_round_trip(self, client, seeded_db):
        headers = _auth_header(client)
        created = client.post(
            "/api/admin/sponsors/",
            json={
                "supplier_id": str(seeded_db["supplier1"].id),
                "category_id": str(seeded_db["parent"].id),
                "tier": "Platinum",
                "status": "Active",
                "sold_by": "Anthony",
            },
            headers=headers,
        )
        assert created.status_code == 200
        assert created.json()["sold_by"] == "Anthony"

        sponsor_id = created.json()["id"]
        patched = client.patch(
            f"/api/admin/sponsors/{sponsor_id}",
            json={"sold_by": "Ronald"},
            headers=headers,
        )
        assert patched.status_code == 200
        assert patched.json()["sold_by"] == "Ronald"

        listed = client.get("/api/admin/sponsors/", headers=headers).json()
        assert {s["sold_by"] for s in listed if s["id"] == sponsor_id} == {"Ronald"}

    def test_sold_by_is_absent_from_the_public_sponsor_payload(self, client, seeded_db, db):
        """The public /partners + /{slug} responses are UNAUTHENTICATED — an
        internal sales attribution must never ride along on them."""
        from app.schemas.sponsor import SponsorResponse

        assert "sold_by" not in SponsorResponse.model_fields

        seeded_db["sponsor"].sold_by = "Anthony"
        db.commit()

        partners = client.get(f"/api/categories/{seeded_db['parent'].slug}/partners").json()
        payload = repr(partners)
        assert "sold_by" not in payload
        assert "Anthony" not in payload

        category = client.get(f"/api/categories/{seeded_db['child'].slug}").json()
        assert "sold_by" not in repr(category)
