"""The customer console's chart panels — account_dashboard.charts_router.

Every panel here answers a question the staff board already answers
company-wide, so a test that passes against UNSCOPED code measures nothing.
The fixture is therefore built as a Venn diagram with a second, fully populated
customer AND the company's own books in it: for every "sees N" assertion below
there is a row that must not be counted, and the numbers are chosen so that
dropping a WHERE clause produces a DIFFERENT figure rather than the same one by
luck. Customer B's rows are deliberately large and ugly (9999, 7777) so a leak
is unmistakable in a failure message.

Three panels' scoping was mutation-proven by removing the filter and watching
these redden — see the report for which.

The routes are mounted on a throwaway app rather than ``app.main``, matching
tests/test_account_dashboard.py: a test that 404s until an unrelated file is
edited is a test that gets deleted instead of read.
"""

import inspect
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi import FastAPI, params
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.models import (
    ActivityEvent,
    Expense,
    Lead,
    Manufacturer,
    OutboundClick,
    Part,
    PartListing,
    Revenue,
    Sponsor,
    SupplierFeed,
    User,
)
from app.routes import account_dashboard
from app.routes.dashboard import _month_end, _month_start, _today_est
from app.services.account_kpis import DEFAULT_KPI, KPIS_BY_KEY
from app.services.account_scope import account_scope
from app.services.auth_service import create_token

FEED_SECRET = "mouser-live-key-do-not-ship"
FEED_URL = "https://feed.invalid/kennedy.json"


def _key(day) -> str:
    return f"{day.year:04d}-{day.month:02d}"


@pytest.fixture
def world(db, seeded_db):
    """seeded_db plus a second customer, a maker, and the company's own books.

    Parts, as a Venn diagram over (carried by Kennedy, made by Nordic):

      part1       — carried by Kennedy AND Avnet, no manufacturer row (child)
      part_both   — carried by Kennedy, made by Nordic          (child)
      part_made   — made by Nordic, carried by nobody           (child)
      part_other  — made by Renesas, carried by Avnet           (PARENT)
      part2       — neither (from seeded_db)                    (child)
    """
    kennedy = seeded_db["supplier2"]
    avnet = seeded_db["supplier1"]
    parent, child = seeded_db["parent"], seeded_db["child"]
    today = _today_est()
    this_month, last_month = _month_start(today, 0), _month_start(today, 1)

    nordic = Manufacturer(
        id=uuid.uuid4(),
        name="Nordic Semiconductor",
        slug="nordic-semiconductor",
        canonical_key="nordicsemiconductor",
    )
    renesas = Manufacturer(
        id=uuid.uuid4(),
        name="Renesas Electronics",
        slug="renesas-electronics",
        canonical_key="renesaselectronics",
    )
    db.add_all([nordic, renesas])
    db.flush()

    def _part(sku, mfr, category):
        p = Part(
            id=uuid.uuid4(),
            sku=sku,
            description=f"{sku} test part",
            manufacturer_name=mfr.name,
            manufacturer_id=mfr.id,
            category_id=category.id,
            lifecycle_status="active",
        )
        db.add(p)
        return p

    part_made = _part("NRF52840-QIAA-R7", nordic, child)
    part_both = _part("NRF52833-QIAA", nordic, child)
    part_other = _part("R5F5210", renesas, parent)
    db.flush()

    db.add_all(
        [
            PartListing(
                id=uuid.uuid4(),
                part_id=part_both.id,
                supplier_id=kennedy.id,
                sku="KEN-NRF52833",
                stock_quantity=42,
                unit_price=Decimal("5.1000"),
            ),
            PartListing(
                id=uuid.uuid4(),
                part_id=part_other.id,
                supplier_id=avnet.id,
                sku="AVN-R5F5210",
                stock_quantity=7,
                unit_price=Decimal("6.2000"),
            ),
        ]
    )
    db.flush()

    # ── Sponsorships ────────────────────────────────────────────────────────
    kennedy_gold = seeded_db["sponsor"]  # status NULL — the legacy shape
    kennedy_gold.amount = Decimal("1500.00")
    kennedy_keyword = Sponsor(
        id=uuid.uuid4(),
        supplier_id=kennedy.id,
        keyword="capacitors",
        description="Kennedy's keyword placement",
        tier="Platinum",
        status="Active",
        amount=Decimal("2500.00"),
    )
    kennedy_expired = Sponsor(
        id=uuid.uuid4(),
        supplier_id=kennedy.id,
        category_id=parent.id,
        description="Kennedy's lapsed placement",
        tier="silver",
        status="Expired",
        amount=Decimal("250.00"),
    )
    avnet_sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=avnet.id,
        keyword="resistors",
        description="Avnet's own placement",
        tier="Platinum",
        status="Active",
        amount=Decimal("9999.00"),
    )
    db.add_all([kennedy_keyword, kennedy_expired, avnet_sponsor])
    db.flush()

    # ── People ──────────────────────────────────────────────────────────────
    pw = seeded_db["company_user"].password_hash
    customer_a = seeded_db["company_user"]  # Kennedy
    customer_a.activated_at = datetime.now(UTC)

    def _customer(name, **links):
        u = User(
            id=uuid.uuid4(),
            username=name,
            password_hash=pw,
            role="user",
            email=f"{name}@test.example",
            email_verified_at=datetime.now(UTC),
            activated_at=datetime.now(UTC),
            **links,
        )
        db.add(u)
        return u

    customer_b = _customer("avnet_user", supplier_id=avnet.id)
    maker_user = _customer("maker_user", manufacturer_id=nordic.id)
    free_user = _customer("free_user")
    # Distributes AND manufactures, with NO overlap between the two sides —
    # so the union assertion cannot be satisfied by either half alone.
    both_user = _customer("both_user", supplier_id=kennedy.id, manufacturer_id=renesas.id)
    # Distributes a part it makes itself. Only used to prove self-exclusion.
    self_dealer = _customer("self_dealer", supplier_id=kennedy.id, manufacturer_id=nordic.id)
    unactivated = _customer("pending_user", supplier_id=kennedy.id)
    unactivated.activated_at = None
    db.flush()

    # ── Referral clicks ─────────────────────────────────────────────────────
    now = datetime.now(UTC)

    def _clicks(supplier, part, days_ago, count):
        for _ in range(count):
            db.add(
                OutboundClick(
                    id=uuid.uuid4(),
                    part_id=part.id,
                    supplier_id=supplier.id,
                    clicked_at=now - timedelta(days=days_ago),
                )
            )

    _clicks(kennedy, seeded_db["part1"], 0, 3)  # today
    _clicks(kennedy, seeded_db["part1"], 2, 1)  # inside the 30-day window
    _clicks(kennedy, part_both, 40, 2)  # outside 30 days, inside 12 months
    _clicks(kennedy, part_both, 800, 1)  # outside both windows
    _clicks(avnet, seeded_db["part1"], 0, 5)  # customer B's
    db.flush()

    # ── Revenue ─────────────────────────────────────────────────────────────
    # seeded_db's two rows carry FIXED 2026-03 dates, which drift in and out of
    # a rolling 12-month window as the calendar moves. Replaced with rows
    # anchored to the current month so the assertions below stay true forever.
    for row in db.query(Revenue).all():
        db.delete(row)
    db.flush()

    def _revenue(supplier, amount, first):
        db.add(
            Revenue(
                id=uuid.uuid4(),
                supplier_id=supplier.id,
                type="sponsorship",
                amount=Decimal(amount),
                description="test",
                period_start=first,
                period_end=_month_end(first),
            )
        )

    _revenue(kennedy, "750.00", this_month)
    _revenue(kennedy, "250.00", last_month)
    _revenue(avnet, "9999.00", this_month)
    db.flush()

    # ── Cost books ──────────────────────────────────────────────────────────
    def _expense(owner, category, vendor, amount, first):
        db.add(
            Expense(
                id=uuid.uuid4(),
                category=category,
                vendor=vendor,
                amount=Decimal(amount),
                period_start=first,
                period_end=_month_end(first),
                user_id=None if owner is None else owner.id,
            )
        )

    _expense(customer_a, "infrastructure", "Hetzner", "120.50", this_month)
    _expense(customer_a, "ai", "Anthropic", "80.00", this_month)
    _expense(customer_a, "domain", "Hover", "60.00", last_month)
    _expense(None, "infrastructure", "AWS", "5000.00", this_month)  # the COMPANY's book
    _expense(customer_b, "email", "Postmark", "7777.00", this_month)
    db.flush()

    # ── Prospect lists ──────────────────────────────────────────────────────
    def _lead(owner, company, contact, outcome=None):
        row = Lead(
            id=uuid.uuid4(),
            source_key=f"{company}|{contact}|{uuid.uuid4()}",
            company_name=company,
            company_slug=company.lower().replace(" ", "-"),
            contact_name=contact,
            needs_enrichment=contact is None,
            last_outcome=outcome,
        )
        row.user_id = None if owner is None else owner.id
        db.add(row)
        return row

    a_leads = [_lead(customer_a, f"Prospect {n}", f"Buyer {n}", "connected") for n in range(5)]
    a_placeholder = _lead(customer_a, "Nameless Industries", None)
    _lead(customer_b, "Avnet's Prospect", "Somebody Else", "voicemail")
    for n in range(3):
        _lead(None, f"Circuit Center Roster {n}", f"Roster Contact {n}", "connected")
    db.flush()

    # ── Feed activity ───────────────────────────────────────────────────────
    def _event(supplier, kind, title, detail, minutes_ago):
        db.add(
            ActivityEvent(
                id=uuid.uuid4(),
                kind=kind,
                supplier_id=None if supplier is None else supplier.id,
                title=title,
                detail=detail,
                created_at=now - timedelta(minutes=minutes_ago),
            )
        )

    _event(kennedy, "part_synced", "LM7805CT — TI", "Clock and Timing", 1)
    _event(kennedy, "part_imported", "NRF52833-QIAA — Nordic", "Clock and Timing", 2)
    _event(kennedy, "sync_finished", "Kennedy Electronics", "3 updated, 0 created", 3)
    _event(kennedy, "sync_started", "Kennedy Electronics", None, 4)  # never rendered
    _event(avnet, "part_synced", "AVNET-SECRET — Avnet", "Passives", 1)
    _event(avnet, "sync_finished", "Avnet", "9999 updated", 2)
    _event(None, "sync_finished", "System", "unattributed run", 1)
    db.flush()

    db.add_all(
        [
            SupplierFeed(
                supplier_id=kennedy.id,
                auto_import_enabled=True,
                last_synced_at=now - timedelta(hours=6),
                api_key=FEED_SECRET,
                feed_url=FEED_URL,
            ),
            SupplierFeed(supplier_id=avnet.id, auto_import_enabled=False),
        ]
    )
    db.commit()

    return {
        **seeded_db,
        "kennedy": kennedy,
        "avnet": avnet,
        "nordic": nordic,
        "renesas": renesas,
        "part_made": part_made,
        "part_both": part_both,
        "part_other": part_other,
        "kennedy_gold": kennedy_gold,
        "kennedy_keyword": kennedy_keyword,
        "kennedy_expired": kennedy_expired,
        "avnet_sponsor": avnet_sponsor,
        "customer_a": customer_a,
        "customer_b": customer_b,
        "maker_user": maker_user,
        "free_user": free_user,
        "both_user": both_user,
        "self_dealer": self_dealer,
        "unactivated": unactivated,
        "a_leads": a_leads,
        "a_placeholder": a_placeholder,
        "this_month": this_month,
        "last_month": last_month,
    }


@pytest.fixture
def api(db):
    app = FastAPI()
    app.include_router(account_dashboard.charts_router)
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def as_(user):
    return {"Authorization": f"Bearer {create_token(str(user.id), user.role)}"}


def get(api, user, path, **params):
    resp = api.get(f"/api/account{path}", headers=as_(user), params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def refused(api, path, user=None, method="get"):
    headers = as_(user) if user is not None else {}
    return getattr(api, method)(f"/api/account{path}", headers=headers)


# ── The fixture itself ──────────────────────────────────────────────────────
class TestTheFixtureHasSomethingToLeak:
    """Guards every "sees only N" assertion below from passing vacuously."""

    def test_other_people_own_rows_in_every_table_under_test(self, world, db):
        assert db.query(OutboundClick).count() == 12  # 6 Kennedy's, 5 Avnet's, 1 stale
        assert db.query(Revenue).count() == 3
        assert db.query(Expense).count() == 5
        assert db.query(Lead).count() == 10
        assert db.query(ActivityEvent).count() == 7
        assert db.query(SupplierFeed).count() == 2
        assert db.query(Sponsor).count() == 4

    def test_the_company_keeps_books_no_customer_owns(self, world, db):
        assert db.query(Expense).filter(Expense.user_id.is_(None)).count() == 1
        assert db.query(Lead).filter(Lead.user_id.is_(None)).count() == 3


# ── GET/PUT /kpi ────────────────────────────────────────────────────────────
class TestKpiTile:
    def test_the_default_is_parts_by_category_when_nothing_is_stored(self, api, world):
        body = get(api, world["customer_a"], "/kpi")
        assert world["customer_a"].dashboard_kpi is None
        assert body["selected"] == DEFAULT_KPI

    def test_the_series_is_the_callers_own_catalog(self, api, world):
        """Kennedy carries part1 and part_both, both in the child category.
        The catalog holds five parts across two categories."""
        assert get(api, world["customer_a"], "/kpi")["points"] == [
            {"label": world["child"].name, "value": 2}
        ]

    def test_a_second_customer_gets_a_different_series(self, api, world):
        """Avnet carries part1 (child) and part_other (parent) — a different
        SHAPE, so an unscoped implementation cannot match both."""
        assert get(api, world["customer_b"], "/kpi")["points"] == [
            {"label": world["child"].name, "value": 1},
            {"label": world["parent"].name, "value": 1},
        ]

    def test_both_links_are_a_union_counted_once(self, api, world):
        assert get(api, world["both_user"], "/kpi")["points"] == [
            {"label": world["child"].name, "value": 2},
            {"label": world["parent"].name, "value": 1},
        ]

    def test_an_unlinked_customer_gets_an_empty_series_and_a_200(self, api, world):
        body = get(api, world["free_user"], "/kpi")
        assert body["selected"] == DEFAULT_KPI
        assert body["points"] == []

    def test_the_picker_only_offers_what_the_account_can_answer(self, api, world):
        def keys(user):
            return [entry["key"] for entry in get(api, user, "/kpi")["available"]]

        assert keys(world["customer_a"]) == [
            DEFAULT_KPI,
            "manufacturers_by_parts",
            "stock_by_category",
            "inventory_value_by_category",
        ]
        assert keys(world["maker_user"]) == [DEFAULT_KPI, "distributors_by_parts"]
        assert keys(world["both_user"]) == list(KPIS_BY_KEY)
        assert keys(world["free_user"]) == [DEFAULT_KPI]

    def test_the_selection_is_always_one_of_the_offered_keys(self, api, world):
        for user in (world["customer_a"], world["maker_user"], world["free_user"]):
            body = get(api, user, "/kpi")
            assert body["selected"] in {entry["key"] for entry in body["available"]}

    def test_manufacturers_by_parts_lists_only_the_makers_on_my_shelf(self, api, world):
        body = put(api, world["customer_a"], "manufacturers_by_parts")
        # Nordic makes part_both, which Kennedy carries. Renesas is Avnet's.
        assert body["points"] == [{"label": "Nordic Semiconductor", "value": 1}]

    def test_distributors_by_parts_lists_only_who_stocks_my_parts(self, api, world):
        body = put(api, world["maker_user"], "distributors_by_parts")
        assert body["points"] == [{"label": "Kennedy Electronics", "value": 1}]

    def test_stock_is_my_own_shelf_not_every_offer_on_my_parts(self, api, world):
        """Kennedy holds 8000 of part1 and 42 of part_both. Avnet's 15000 of
        the SAME part must never be added to that."""
        assert put(api, world["customer_a"], "stock_by_category")["points"] == [
            {"label": world["child"].name, "value": 8042}
        ]

    def test_inventory_value_multiplies_price_by_units(self, api, world):
        points = put(api, world["customer_a"], "inventory_value_by_category")["points"]
        assert points == [{"label": world["child"].name, "value": 4054.2}]
        assert isinstance(points[0]["value"], float)

    def test_a_choice_is_persisted_and_read_back(self, api, world, db):
        put(api, world["customer_a"], "stock_by_category")
        db.expire_all()
        assert get(api, world["customer_a"], "/kpi")["selected"] == "stock_by_category"

    def test_an_unknown_key_is_refused(self, api, world):
        resp = api.put(
            "/api/account/kpi", headers=as_(world["customer_a"]), json={"key": "profit_margin"}
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "unknown_kpi"

    def test_a_key_this_account_cannot_answer_is_refused(self, api, world, db):
        """Capability IS validity: a maker naming a distributor's KPI is
        rejected exactly like a misspelling, and nothing is stored."""
        resp = api.put(
            "/api/account/kpi", headers=as_(world["maker_user"]), json={"key": "stock_by_category"}
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "unknown_kpi"
        db.expire_all()
        assert world["maker_user"].dashboard_kpi is None

    def test_a_stored_key_the_account_can_no_longer_answer_falls_back(self, api, world, db):
        """users.dashboard_kpi has no FK and an account can lose a link. The
        read must render the default, not 500 and not a blank panel."""
        world["maker_user"].dashboard_kpi = "stock_by_category"
        db.commit()
        assert get(api, world["maker_user"], "/kpi")["selected"] == DEFAULT_KPI

    def test_a_stored_key_the_registry_dropped_falls_back(self, api, world, db):
        world["customer_a"].dashboard_kpi = "kpi_from_a_previous_release"
        db.commit()
        assert get(api, world["customer_a"], "/kpi")["selected"] == DEFAULT_KPI

    def test_staff_and_anonymous_are_refused(self, api, world):
        assert refused(api, "/kpi", world["admin_user"]).status_code == 403
        assert refused(api, "/kpi").status_code in (401, 403)
        assert api.put("/api/account/kpi", json={"key": DEFAULT_KPI}).status_code in (401, 403)
        assert (
            api.put(
                "/api/account/kpi", headers=as_(world["admin_user"]), json={"key": DEFAULT_KPI}
            ).status_code
            == 403
        )


def put(api, user, key):
    resp = api.put("/api/account/kpi", headers=as_(user), json={"key": key})
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── GET /referral-clicks ────────────────────────────────────────────────────
class TestReferralClicks:
    def test_every_slot_in_both_series_is_filled(self, api, world):
        body = get(api, world["customer_a"], "/referral-clicks")
        assert len(body["daily"]) == 30
        assert len(body["monthly"]) == 12
        assert all(isinstance(point["clicks"], int) for point in body["daily"])
        # Oldest first, and contiguous.
        assert [point["date"] for point in body["daily"]] == sorted(
            point["date"] for point in body["daily"]
        )
        assert [point["month"] for point in body["monthly"]] == sorted(
            point["month"] for point in body["monthly"]
        )
        assert body["monthly"][-1]["month"] == _key(world["this_month"])

    def test_only_this_distributors_clicks_are_counted(self, api, world):
        a = get(api, world["customer_a"], "/referral-clicks")
        b = get(api, world["customer_b"], "/referral-clicks")
        # The exact pins ARE the scoping proof: the union would be 9, and an
        # unscoped query hands BOTH accounts 9, failing both lines. (An earlier
        # `a + b != a` flourish here was a tautology — true whenever b is
        # non-zero — and asserted nothing; exact values do the work.)
        assert a["total_30d"] == 4  # 3 today + 1 two days ago
        assert b["total_30d"] == 5
        assert a["daily"][-1]["clicks"] == 3
        assert b["daily"][-1]["clicks"] == 5

    def test_the_monthly_series_reaches_further_back_than_the_daily_one(self, api, world):
        body = get(api, world["customer_a"], "/referral-clicks")
        assert sum(point["clicks"] for point in body["monthly"]) == 6
        assert body["total_30d"] == 4

    def test_a_click_older_than_the_window_is_not_counted(self, api, world, db):
        """The 800-day-old row must be in neither series, and must not be
        quietly summed into total_30d either."""
        assert (
            db.query(OutboundClick).filter(OutboundClick.supplier_id == world["kennedy"].id).count()
            == 7
        )
        body = get(api, world["customer_a"], "/referral-clicks")
        assert sum(point["clicks"] for point in body["monthly"]) == 6

    def test_total_30d_is_the_daily_series_total(self, api, world):
        body = get(api, world["customer_a"], "/referral-clicks")
        assert body["total_30d"] == sum(point["clicks"] for point in body["daily"])

    def test_a_maker_or_unlinked_account_gets_a_zero_filled_200(self, api, world):
        for user in (world["maker_user"], world["free_user"]):
            body = get(api, user, "/referral-clicks")
            assert body["total_30d"] == 0
            assert len(body["daily"]) == 30
            assert len(body["monthly"]) == 12
            assert {point["clicks"] for point in body["daily"]} == {0}
            assert {point["clicks"] for point in body["monthly"]} == {0}

    def test_nothing_here_is_called_revenue(self, api, world):
        """The recorded honesty rule: these are people we sent, not money we
        saw. A field named revenue/amount here would be a claim we cannot
        stand behind."""
        text = api.get("/api/account/referral-clicks", headers=as_(world["customer_a"])).text
        assert "revenue" not in text.lower()
        assert "amount" not in text.lower()

    def test_staff_and_anonymous_are_refused(self, api, world):
        assert refused(api, "/referral-clicks", world["admin_user"]).status_code == 403
        assert refused(api, "/referral-clicks").status_code in (401, 403)


# ── GET /revenue ────────────────────────────────────────────────────────────
class TestRevenue:
    def test_twelve_months_oldest_first(self, api, world):
        body = get(api, world["customer_a"], "/revenue")
        months = [point["month"] for point in body["months"]]
        assert len(months) == 12
        assert months == sorted(months)
        assert months[-1] == _key(world["this_month"])
        assert months[-2] == _key(world["last_month"])

    def test_only_this_suppliers_revenue_is_bucketed(self, api, world):
        body = get(api, world["customer_a"], "/revenue")
        by_month = {point["month"]: point["amount"] for point in body["months"]}
        assert by_month[_key(world["this_month"])] == 750.0
        assert by_month[_key(world["last_month"])] == 250.0
        assert body["total"] == 1000.0
        # Avnet's 9999 would be visible in either figure.
        assert get(api, world["customer_b"], "/revenue")["total"] == 9999.0

    def test_months_with_no_rows_are_zero_not_absent(self, api, world):
        body = get(api, world["customer_a"], "/revenue")
        assert sum(1 for point in body["months"] if point["amount"] == 0) == 10

    def test_money_reaches_the_wire_as_a_number(self, api, world):
        body = get(api, world["customer_a"], "/revenue")
        assert isinstance(body["total"], int | float)
        assert all(isinstance(point["amount"], int | float) for point in body["months"])
        assert '"total":1000.0' in api.get(
            "/api/account/revenue", headers=as_(world["customer_a"])
        ).text.replace(" ", "")

    def test_a_maker_or_unlinked_account_gets_zeroes_and_a_200(self, api, world):
        for user in (world["maker_user"], world["free_user"]):
            body = get(api, user, "/revenue")
            assert body["total"] == 0
            assert len(body["months"]) == 12
            assert {point["amount"] for point in body["months"]} == {0.0}

    def test_staff_and_anonymous_are_refused(self, api, world):
        assert refused(api, "/revenue", world["admin_user"]).status_code == 403
        assert refused(api, "/revenue").status_code in (401, 403)


# ── GET /sponsor-mix ────────────────────────────────────────────────────────
class TestSponsorMix:
    def test_the_flow_is_company_then_tier_then_placement(self, api, world):
        body = get(api, world["customer_a"], "/sponsor-mix")
        # Company, then every tier, then the placements — the graph is emitted
        # level by level, which is the order a Sankey is read in.
        assert [node["name"] for node in body["nodes"]] == [
            "Kennedy Electronics",
            "Gold",
            "Platinum",
            world["child"].name,
            "capacitors",
        ]
        assert {(link["source"], link["target"], link["value"]) for link in body["links"]} == {
            ("Kennedy Electronics", "Gold", 1500.0),
            ("Kennedy Electronics", "Platinum", 2500.0),
            ("Gold", world["child"].name, 1500.0),
            ("Platinum", "capacitors", 2500.0),
        }

    def test_another_customers_placement_never_appears(self, api, world):
        body = get(api, world["customer_a"], "/sponsor-mix")
        names = {node["name"] for node in body["nodes"]}
        assert "Avnet" not in names
        assert "resistors" not in names
        assert all(link["value"] != 9999.0 for link in body["links"])
        # And B sees theirs, so this is scoping and not an empty route.
        assert {
            node["name"] for node in get(api, world["customer_b"], "/sponsor-mix")["nodes"]
        } == {
            "Avnet",
            "Platinum",
            "resistors",
        }

    def test_a_lapsed_placement_is_not_where_money_flows(self, api, world):
        names = {node["name"] for node in get(api, world["customer_a"], "/sponsor-mix")["nodes"]}
        assert "Silver" not in names
        assert world["parent"].name not in names

    def test_a_null_status_placement_counts_as_active(self, api, world, db):
        """`status != 'Expired'` is UNKNOWN for NULL. Expire the only non-NULL
        active row; the legacy one must still carry its money."""
        world["kennedy_keyword"].status = "Expired"
        db.commit()
        body = get(api, world["customer_a"], "/sponsor-mix")
        assert {node["name"] for node in body["nodes"]} == {
            "Kennedy Electronics",
            "Gold",
            world["child"].name,
        }

    def test_a_zero_amount_keeps_its_link(self, api, world, db):
        """A placement we have not billed for is still a placement. Dropping
        the link would erase it from the customer's own map of their account."""
        world["kennedy_keyword"].amount = Decimal("0.00")
        db.commit()
        body = get(api, world["customer_a"], "/sponsor-mix")
        assert ("Platinum", "capacitors", 0.0) in {
            (link["source"], link["target"], link["value"]) for link in body["links"]
        }

    def test_a_placement_named_after_its_tier_does_not_close_a_cycle(self, api, world, db):
        """ECharts refuses to draw a Sankey with a cycle, so a keyword that
        collides with a node name is renamed rather than merged."""
        world["kennedy_keyword"].keyword = "Platinum"
        db.commit()
        body = get(api, world["customer_a"], "/sponsor-mix")
        names = [node["name"] for node in body["nodes"]]
        assert len(names) == len(set(names))
        assert "Platinum (placement)" in names
        assert all(link["source"] != link["target"] for link in body["links"])

    def test_one_supplier_cannot_hold_two_placements_on_one_target(self, world, db):
        """Why the collision guard only has to worry about the company and the
        tiers: within a single supplier the DB already makes placements
        distinct, so two placement nodes can never share a name."""
        from sqlalchemy.exc import IntegrityError

        world["kennedy_keyword"].keyword = None
        world["kennedy_keyword"].category_id = world["child"].id  # kennedy_gold's
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()

    def test_a_placement_seen_before_its_clashing_tier_is_still_renamed(self, api, world, db):
        """Order independence: the Gold row is older, so its placement is
        processed before the Platinum tier is ever reached."""
        world["kennedy_gold"].category_id = None
        world["kennedy_gold"].keyword = "Platinum"
        db.commit()
        body = get(api, world["customer_a"], "/sponsor-mix")
        names = [node["name"] for node in body["nodes"]]
        assert len(names) == len(set(names))
        assert "Platinum (placement)" in names
        assert ("Gold", "Platinum (placement)") in {
            (link["source"], link["target"]) for link in body["links"]
        }

    def test_a_maker_or_unlinked_account_gets_an_empty_graph(self, api, world):
        for user in (world["maker_user"], world["free_user"]):
            assert get(api, user, "/sponsor-mix") == {"nodes": [], "links": []}

    def test_staff_and_anonymous_are_refused(self, api, world):
        assert refused(api, "/sponsor-mix", world["admin_user"]).status_code == 403
        assert refused(api, "/sponsor-mix").status_code in (401, 403)


# ── GET /book-of-business ───────────────────────────────────────────────────
class TestBookOfBusiness:
    def test_a_distributor_sees_the_makers_it_carries(self, api, world):
        body = get(api, world["customer_a"], "/book-of-business")
        assert body["center"] == {"name": "Kennedy Electronics"}
        assert body["nodes"] == [
            {
                "id": str(world["nordic"].id),
                "name": "Nordic Semiconductor",
                "kind": "manufacturer",
                "parts_count": 1,
            }
        ]
        assert body["links"] == [
            {"source": "center", "target": str(world["nordic"].id), "value": 1}
        ]

    def test_a_maker_sees_the_distributors_stocking_it(self, api, world):
        body = get(api, world["maker_user"], "/book-of-business")
        assert body["center"] == {"name": "Nordic Semiconductor"}
        assert [(node["name"], node["kind"]) for node in body["nodes"]] == [
            ("Kennedy Electronics", "supplier")
        ]

    def test_another_companys_counterparties_never_appear(self, api, world):
        names = {
            node["name"] for node in get(api, world["customer_a"], "/book-of-business")["nodes"]
        }
        assert "Renesas Electronics" not in names
        # Avnet carries the Renesas part, so an unscoped join surfaces it.
        assert {
            node["name"] for node in get(api, world["customer_b"], "/book-of-business")["nodes"]
        } == {"Renesas Electronics"}

    def test_both_links_contribute_and_neither_replaces_the_other(self, api, world):
        """both_user distributes for Kennedy and manufactures as Renesas —
        two disjoint relationships, so neither half alone can satisfy this."""
        body = get(api, world["both_user"], "/book-of-business")
        assert body["center"] == {"name": "Kennedy Electronics"}
        assert {(node["name"], node["kind"]) for node in body["nodes"]} == {
            ("Nordic Semiconductor", "manufacturer"),
            ("Avnet", "supplier"),
        }

    def test_a_company_is_not_its_own_counterparty(self, api, world):
        """self_dealer distributes a part it makes. The control account, linked
        only to Kennedy, DOES see Nordic — so this is exclusion, not emptiness."""
        assert get(api, world["self_dealer"], "/book-of-business")["nodes"] == []
        assert get(api, world["customer_a"], "/book-of-business")["nodes"]

    def test_an_unlinked_account_has_no_centre_and_no_counterparties(self, api, world):
        body = get(api, world["free_user"], "/book-of-business")
        assert body == {"center": {"name": None}, "nodes": [], "links": []}

    def test_staff_and_anonymous_are_refused(self, api, world):
        assert refused(api, "/book-of-business", world["admin_user"]).status_code == 403
        assert refused(api, "/book-of-business").status_code in (401, 403)


# ── GET /activity ───────────────────────────────────────────────────────────
class TestActivity:
    def test_only_this_companys_events_newest_first(self, api, world):
        events = get(api, world["customer_a"], "/activity")["events"]
        assert [event["kind"] for event in events] == [
            "part_synced",
            "part_imported",
            "sync_finished",
        ]
        assert all("AVNET-SECRET" not in event["label"] for event in events)
        assert all("unattributed" not in event["label"] for event in events)

    def test_a_started_run_is_not_progress(self, api, world):
        kinds = {event["kind"] for event in get(api, world["customer_a"], "/activity")["events"]}
        assert "sync_started" not in kinds

    def test_the_label_is_the_staff_boards_own_sentence(self, api, world):
        events = get(api, world["customer_a"], "/activity")["events"]
        assert events[0]["label"] == "Synced LM7805CT — TI into Clock and Timing"
        assert events[1]["label"] == "Imported NRF52833-QIAA — Nordic into Clock and Timing"
        assert events[2]["label"] == "Inventory sync — 3 updated, 0 created"

    def test_the_feed_is_capped(self, api, world, db):
        now = datetime.now(UTC)
        for n in range(25):
            db.add(
                ActivityEvent(
                    id=uuid.uuid4(),
                    kind="part_synced",
                    supplier_id=world["kennedy"].id,
                    title=f"BULK-{n:03d} — TI",
                    detail="Clock and Timing",
                    created_at=now - timedelta(seconds=n),
                )
            )
        db.commit()
        assert len(get(api, world["customer_a"], "/activity")["events"]) == 20

    def test_a_maker_or_unlinked_account_gets_an_empty_feed(self, api, world):
        for user in (world["maker_user"], world["free_user"]):
            assert get(api, user, "/activity") == {"events": []}

    def test_staff_and_anonymous_are_refused(self, api, world):
        assert refused(api, "/activity", world["admin_user"]).status_code == 403
        assert refused(api, "/activity").status_code in (401, 403)


# ── GET /import-queue ───────────────────────────────────────────────────────
class TestImportQueue:
    def test_it_reports_this_suppliers_own_row(self, api, world):
        body = get(api, world["customer_a"], "/import-queue")
        assert body["feed"]["auto_import_enabled"] is True
        assert body["feed"]["last_synced_at"] is not None
        # Avnet's row says the opposite, so this is a read of THEIR row.
        assert get(api, world["customer_b"], "/import-queue")["feed"] == {
            "auto_import_enabled": False,
            "last_synced_at": None,
        }

    def test_the_credential_and_the_feed_url_never_leave_the_server(self, api, world):
        text = api.get("/api/account/import-queue", headers=as_(world["customer_a"])).text
        assert FEED_SECRET not in text
        assert FEED_URL not in text
        assert "api_key" not in text
        assert "import_cursor" not in text
        body = api.get("/api/account/import-queue", headers=as_(world["customer_a"])).json()
        assert set(body["feed"]) == {"auto_import_enabled", "last_synced_at"}

    def test_no_feed_row_is_null_not_an_error(self, api, world):
        for user in (world["maker_user"], world["free_user"]):
            assert get(api, user, "/import-queue") == {"feed": None}

    def test_staff_and_anonymous_are_refused(self, api, world):
        assert refused(api, "/import-queue", world["admin_user"]).status_code == 403
        assert refused(api, "/import-queue").status_code in (401, 403)


# ── GET /operating-costs ────────────────────────────────────────────────────
class TestOperatingCosts:
    def test_subscriptions_and_the_customers_own_expenses(self, api, world):
        body = get(api, world["customer_a"], "/operating-costs")
        assert body["month"] == _key(world["this_month"])
        assert {
            (line["kind"], line["category"], line["vendor"], line["amount"])
            for line in body["lines"]
        } == {
            ("subscription", "gold", "Circuit Center", 1500.0),
            ("subscription", "platinum", "Circuit Center", 2500.0),
            ("expense", "infrastructure", "Hetzner", 120.5),
            ("expense", "ai", "Anthropic", 80.0),
        }
        assert body["total"] == 4200.5

    def test_the_companys_own_operating_costs_are_never_a_customers(self, api, world):
        """expenses.user_id NULL is Circuit Center's book — the AWS bill. An
        `or_(... .is_(None))` convenience in the filter publishes it."""
        body = get(api, world["customer_a"], "/operating-costs")
        assert all(line["vendor"] != "AWS" for line in body["lines"])
        assert all(line["amount"] != 5000.0 for line in body["lines"])

    def test_another_customers_book_is_never_mixed_in(self, api, world):
        a = get(api, world["customer_a"], "/operating-costs")
        b = get(api, world["customer_b"], "/operating-costs")
        assert all(line["vendor"] != "Postmark" for line in a["lines"])
        assert ("expense", "email", "Postmark", 7777.0) in {
            (line["kind"], line["category"], line["vendor"], line["amount"]) for line in b["lines"]
        }
        assert a["total"] != b["total"]

    def test_a_lapsed_sponsorship_is_not_a_recurring_cost(self, api, world):
        body = get(api, world["customer_a"], "/operating-costs")
        assert all(line["category"] != "silver" for line in body["lines"])

    def test_a_month_with_no_expenses_still_bills_the_subscriptions(self, api, world):
        """A monthly recurring charge that vanished from an empty month would
        read as a month it was not billed."""
        body = get(api, world["customer_a"], "/operating-costs", month=_key(world["last_month"]))
        assert body["month"] == _key(world["last_month"])
        kinds = [line["kind"] for line in body["lines"]]
        assert kinds.count("subscription") == 2
        assert [line["vendor"] for line in body["lines"] if line["kind"] == "expense"] == ["Hover"]
        assert body["total"] == 4060.0

    def test_a_subscription_is_not_billed_into_months_before_it_existed(
        self, api, world, db
    ):
        """A placement bought in August must not appear as a March cost line.

        The fixture's sponsorships carry NULL dates (legacy/seed shape) and
        keep billing every month; a DATED one is bounded to the months its
        window overlaps. `total` follows.
        """
        import uuid as uuid_mod
        from decimal import Decimal

        from app.models import Sponsor

        db.add(
            Sponsor(
                id=uuid_mod.uuid4(),
                supplier_id=world["kennedy"].id,
                keyword="inductors",
                description="bought mid-cycle",
                tier="Silver",
                status="Active",
                amount=Decimal("250.00"),
                start_date=world["this_month"],
            )
        )
        db.commit()

        last = get(
            api, world["customer_a"], "/operating-costs", month=_key(world["last_month"])
        )
        assert all(line["category"] != "silver" for line in last["lines"])
        assert last["total"] == 4060.0  # unchanged from the undated world

        now = get(api, world["customer_a"], "/operating-costs")
        assert ("subscription", "silver", 250.0) in {
            (line["kind"], line["category"], line["amount"]) for line in now["lines"]
        }

    def test_the_pager_only_offers_months_this_customer_has(self, api, world):
        body = get(api, world["customer_a"], "/operating-costs")
        assert body["available_months"] == [
            _key(world["this_month"]),
            _key(world["last_month"]),
        ]
        # The company's own AWS month is in the same table and must not appear
        # for an account that holds no rows of its own.
        assert get(api, world["free_user"], "/operating-costs")["available_months"] == []

    def test_an_unlinked_account_gets_an_empty_book_and_a_200(self, api, world):
        for user in (world["maker_user"], world["free_user"]):
            body = get(api, user, "/operating-costs")
            assert body["lines"] == []
            assert body["total"] == 0

    def test_a_malformed_month_is_refused_before_the_handler(self, api, world):
        assert (
            api.get(
                "/api/account/operating-costs",
                headers=as_(world["customer_a"]),
                params={"month": "2026-13"},
            ).status_code
            == 422
        )

    def test_staff_and_anonymous_are_refused(self, api, world):
        assert refused(api, "/operating-costs", world["admin_user"]).status_code == 403
        assert refused(api, "/operating-costs").status_code in (401, 403)


# ── GET /leads-summary ──────────────────────────────────────────────────────
class TestLeadsSummary:
    def test_only_the_callers_own_prospects_are_counted(self, api, world):
        body = get(api, world["customer_a"], "/leads-summary")
        assert body["total"] == 6
        assert len(body["recent"]) == 5

    def test_the_companys_outreach_roster_is_never_a_customers(self, api, world):
        """leads.user_id NULL is Circuit Center's own call list — real names,
        real phone numbers, real outcomes."""
        body = get(api, world["customer_a"], "/leads-summary")
        names = {row["name"] for row in body["recent"]}
        assert not any(name.startswith("Roster Contact") for name in names)
        assert "Somebody Else" not in names
        assert get(api, world["customer_b"], "/leads-summary")["total"] == 1

    def test_a_placeholder_row_shows_the_company_not_an_invented_name(self, api, world, db):
        for row in db.query(Lead).filter(Lead.user_id == world["customer_a"].id).all():
            if row.id != world["a_placeholder"].id:
                db.delete(row)
        db.commit()
        body = get(api, world["customer_a"], "/leads-summary")
        assert body["recent"] == [{"name": "Nameless Industries", "status": None}]

    def test_an_outcome_is_carried_through(self, api, world):
        statuses = {
            row["status"] for row in get(api, world["customer_a"], "/leads-summary")["recent"]
        }
        assert statuses <= {"connected", None}

    def test_an_account_with_no_prospects_gets_zero_and_a_200(self, api, world):
        for user in (world["maker_user"], world["free_user"]):
            assert get(api, user, "/leads-summary") == {"total": 0, "recent": []}

    def test_staff_and_anonymous_are_refused(self, api, world):
        assert refused(api, "/leads-summary", world["admin_user"]).status_code == 403
        assert refused(api, "/leads-summary").status_code in (401, 403)


# ── The gate, swept ─────────────────────────────────────────────────────────
CHART_PATHS = (
    "/kpi",
    "/referral-clicks",
    "/revenue",
    "/sponsor-mix",
    "/book-of-business",
    "/activity",
    "/import-queue",
    "/operating-costs",
    "/leads-summary",
)


class TestTheGateIsTheSameOnEveryPanel:
    """Per-endpoint gate tests above prove each panel; this proves the SET.

    A panel added to the router without the scope dependency would be caught by
    the wiring test below, but a panel that took the scope and somehow lost the
    activation check would not — activation (D17) is the whole authorization
    boundary here, and it is worth asserting against every path rather than
    against the one that happened to get a test.
    """

    def test_an_unactivated_customer_is_refused_everywhere(self, api, world):
        for path in CHART_PATHS:
            resp = refused(api, path, world["unactivated"])
            assert resp.status_code == 403, path
            assert resp.json()["detail"] == "account_not_activated", path

    def test_staff_are_refused_everywhere(self, api, world):
        for path in CHART_PATHS:
            assert refused(api, path, world["admin_user"]).status_code == 403, path

    def test_anonymous_is_refused_everywhere(self, api, world):
        for path in CHART_PATHS:
            assert refused(api, path).status_code in (401, 403), path


# ── Wiring ──────────────────────────────────────────────────────────────────
class TestEveryChartRouteIsScoped:
    def test_the_prefix_is_the_account_namespace(self):
        assert account_dashboard.charts_router.prefix == "/api/account"

    def test_the_contract_is_fully_mounted(self):
        paths = {
            (route.path, method)
            for route in account_dashboard.charts_router.routes
            for method in route.methods
            if method != "HEAD"
        }
        assert paths == {
            ("/api/account/kpi", "GET"),
            ("/api/account/kpi", "PUT"),
            ("/api/account/referral-clicks", "GET"),
            ("/api/account/revenue", "GET"),
            ("/api/account/sponsor-mix", "GET"),
            ("/api/account/book-of-business", "GET"),
            ("/api/account/activity", "GET"),
            ("/api/account/import-queue", "GET"),
            ("/api/account/operating-costs", "GET"),
            ("/api/account/leads-summary", "GET"),
        }

    def test_every_route_takes_the_scope_dependency(self):
        """The gate is the dependency. A route added here without it is an
        unscoped, company-wide read behind a customer URL."""
        for route in account_dashboard.charts_router.routes:
            deps = [
                p.default.dependency
                for p in inspect.signature(route.endpoint).parameters.values()
                if isinstance(p.default, params.Depends)
            ]
            assert account_scope in deps, f"{route.path} is not scoped"

    def test_the_panels_are_registered_on_the_real_app(self):
        """A second router is a second thing to forget to include."""
        from app.main import app

        mounted = {route.path for route in app.routes if hasattr(route, "path")}
        assert "/api/account/kpi" in mounted
        assert "/api/account/leads-summary" in mounted
