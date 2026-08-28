"""The customer console's own numbers — app/routes/account_dashboard.py.

A scoping test that passes against UNSCOPED code is measuring nothing, so the
fixture here is built as a Venn diagram with a second, fully-populated customer
in it: every "sees N" assertion below has a matching row that must NOT be
counted, and the totals are chosen so that "no filter at all" produces a
DIFFERENT number rather than the same one by luck. Each filter has been
mutation-checked (break it, watch these redden) — see the report.

The endpoints are mounted on a throwaway app rather than ``app.main``: the
router is registered by the controller after this task lands, and a test that
404s until an unrelated file is edited is a test that will be deleted instead
of read.
"""

import inspect
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from fastapi import Depends, FastAPI, params
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.models import Manufacturer, Message, Part, PartListing, Sponsor, User
from app.routes import account_dashboard
from app.routes.account_dashboard import _money
from app.services.account_scope import account_scope
from app.services.auth_service import create_token


# ── Fixture ─────────────────────────────────────────────────────────────────
@pytest.fixture
def world(db, seeded_db):
    """seeded_db plus a second customer with a full set of rows of their own.

    Parts, as a Venn diagram over (carried by Kennedy, made by Nordic):

      part1        — carried by Kennedy AND Avnet, made by nobody tracked
      part_both    — carried by Kennedy, made by Nordic       → the overlap
      part_made    — made by Nordic, carried by nobody
      part_other   — made by Renesas, carried by Avnet
      part2        — neither (from seeded_db)

    So Kennedy sees 2, Nordic sees 2, an account holding BOTH links sees 3
    (not 4 — the overlap is one part), Avnet sees 2, unlinked sees 0, and the
    catalog holds 5. Every one of those is a different number.
    """
    kennedy = seeded_db["supplier2"]
    avnet = seeded_db["supplier1"]

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

    part_made = Part(
        id=uuid.uuid4(),
        sku="NRF52840-QIAA-R7",
        description="Bluetooth 5.4 SoC",
        manufacturer_name="Nordic Semiconductor",
        manufacturer_id=nordic.id,
        category_id=seeded_db["child"].id,
        lifecycle_status="active",
    )
    part_both = Part(
        id=uuid.uuid4(),
        sku="NRF52833-QIAA",
        description="Bluetooth 5.4 SoC that Kennedy carries",
        manufacturer_name="Nordic Semiconductor",
        manufacturer_id=nordic.id,
        category_id=seeded_db["child"].id,
        lifecycle_status="active",
    )
    part_other = Part(
        id=uuid.uuid4(),
        sku="R5F5210",
        description="Somebody else's chip",
        manufacturer_name="Renesas Electronics",
        manufacturer_id=renesas.id,
        category_id=seeded_db["child"].id,
        lifecycle_status="active",
    )
    db.add_all([part_made, part_both, part_other])
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
    # seeded_db's Kennedy Gold row has status NULL — the legacy shape that
    # `status != 'Expired'` silently drops. It carries money so that dropping
    # it changes monthly_spend, not just a count.
    kennedy_gold = seeded_db["sponsor"]
    kennedy_gold.amount = Decimal("1500.00")

    kennedy_keyword = Sponsor(
        id=uuid.uuid4(),
        supplier_id=kennedy.id,
        keyword="capacitors",
        description="Kennedy's keyword placement",
        tier="Platinum",  # TitleCase from the admin; the DB has both casings
        status="Active",
        amount=Decimal("2500.00"),
    )
    kennedy_expired = Sponsor(
        id=uuid.uuid4(),
        supplier_id=kennedy.id,
        category_id=seeded_db["parent"].id,
        description="Kennedy's lapsed placement",
        tier="silver",  # lowercase from the legacy seed
        status="Expired",
        amount=Decimal("250.00"),
    )
    # Customer B's placement — a big number, so any leak is unmistakable.
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
    company_user = seeded_db["company_user"]  # Kennedy — customer A
    company_user.activated_at = datetime.now(UTC)

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

    avnet_user = _customer("avnet_user", supplier_id=avnet.id)  # customer B
    maker_user = _customer("maker_user", manufacturer_id=nordic.id)
    free_user = _customer("free_user")
    both_user = _customer("both_user", supplier_id=kennedy.id, manufacturer_id=nordic.id)
    unactivated = _customer("pending_user", supplier_id=kennedy.id)
    unactivated.activated_at = None
    db.flush()

    # ── Inboxes ─────────────────────────────────────────────────────────────
    def _msg(seq, user_id, status):
        return Message(
            id=str(uuid.uuid4()),
            type="contact",
            seq=seq,
            status=status,
            payload={"body": f"message {seq}"},
            user_id=user_id,
        )

    db.add_all(
        [
            _msg(9001, company_user.id, "new"),
            _msg(9002, company_user.id, "new"),
            _msg(9003, company_user.id, "read"),  # opened — not unread
            _msg(9004, avnet_user.id, "new"),  # customer B's
            _msg(9005, None, "new"),  # the shared STAFF inbox
        ]
    )
    db.commit()

    return {
        **seeded_db,
        "kennedy": kennedy,
        "avnet": avnet,
        "nordic": nordic,
        "part_made": part_made,
        "part_both": part_both,
        "part_other": part_other,
        "kennedy_gold": kennedy_gold,
        "kennedy_keyword": kennedy_keyword,
        "kennedy_expired": kennedy_expired,
        "avnet_sponsor": avnet_sponsor,
        "customer_a": company_user,
        "customer_b": avnet_user,
        "maker_user": maker_user,
        "free_user": free_user,
        "both_user": both_user,
        "unactivated": unactivated,
    }


@pytest.fixture
def api(db):
    """The router on a throwaway app — see the module docstring."""
    app = FastAPI()
    app.include_router(account_dashboard.router)
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def as_(user):
    return {"Authorization": f"Bearer {create_token(str(user.id), user.role)}"}


def tiles(api, user):
    resp = api.get("/api/account/dashboard", headers=as_(user))
    assert resp.status_code == 200, resp.text
    return resp.json()


def sponsors(api, user):
    resp = api.get("/api/account/sponsors", headers=as_(user))
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── The fixture itself ──────────────────────────────────────────────────────
class TestTheFixtureHasSomethingToLeak:
    """Guards every 'sees only N' assertion below from passing vacuously."""

    def test_the_catalog_is_bigger_than_any_one_customer(self, world, db):
        assert db.query(Part).count() == 5

    def test_there_are_other_peoples_sponsorships_and_messages(self, world, db):
        assert db.query(Sponsor).count() == 4
        assert db.query(Message).count() == 5


# ── GET /dashboard ──────────────────────────────────────────────────────────
class TestDashboardTiles:
    def test_a_supplier_customer_sees_only_its_own_rows(self, api, world):
        body = tiles(api, world["customer_a"])
        # Kennedy carries part1 and part_both. The catalog holds 5.
        assert body["total_parts"] == 2
        # The NULL-status Gold and the Active keyword Platinum; the Expired
        # row and Avnet's are not counted.
        assert body["active_sponsorships"] == 2
        assert body["monthly_spend"] == 1500.0 + 2500.0
        assert body["unread_messages"] == 2
        assert body["tier"] == "platinum"

    def test_customer_a_never_counts_customer_b(self, api, world):
        a = tiles(api, world["customer_a"])
        b = tiles(api, world["customer_b"])
        # Different people, different numbers — and the sum of the two is not
        # what either of them is shown.
        assert b["total_parts"] == 2  # part1 + part_other
        assert b["active_sponsorships"] == 1
        assert b["monthly_spend"] == 9999.0
        assert b["unread_messages"] == 1
        assert a["monthly_spend"] != b["monthly_spend"]
        assert a["monthly_spend"] + b["monthly_spend"] != a["monthly_spend"]

    def test_an_unlinked_customer_gets_zeroes_and_a_200(self, api, world):
        """The single most important assertion in this file. Signup sets
        neither link, so this is the COMMON state — and the natural way to
        write scoping by hand hands this account the company-wide totals."""
        body = tiles(api, world["free_user"])
        assert body["total_parts"] == 0
        assert body["active_sponsorships"] == 0
        assert body["monthly_spend"] == 0
        assert body["unread_messages"] == 0
        assert body["tier"] == "free"

    def test_a_null_status_sponsorship_counts_as_active(self, api, world, db):
        """`status != 'Expired'` is UNKNOWN for NULL, which silently drops the
        legacy seed rows. Expire the only non-NULL active row and the NULL one
        must still be there, with its money."""
        world["kennedy_keyword"].status = "Expired"
        db.commit()
        body = tiles(api, world["customer_a"])
        assert body["active_sponsorships"] == 1
        assert body["monthly_spend"] == 1500.0

    def test_a_manufacturer_only_customer_sees_the_parts_it_makes(self, api, world):
        body = tiles(api, world["maker_user"])
        assert body["total_parts"] == 2  # part_made + part_both
        # sponsors.supplier_id is NOT NULL, so a maker holds none today.
        assert body["active_sponsorships"] == 0
        assert body["monthly_spend"] == 0
        assert body["tier"] == "free"

    def test_both_links_are_a_union_counted_once(self, api, world):
        """Avnet distributes AND manufactures. part_both is carried by Kennedy
        and made by Nordic; a JOIN-shaped implementation counts it twice."""
        assert tiles(api, world["both_user"])["total_parts"] == 3

    def test_unread_means_new_and_mine(self, api, world, db):
        """Three rows are not this customer's unread count: their own opened
        message, customer B's, and the shared staff inbox (user_id NULL)."""
        assert tiles(api, world["customer_a"])["unread_messages"] == 2
        assert db.query(Message).filter(Message.status == "new").count() == 4

    def test_monthly_spend_reaches_the_wire_as_a_number(self, api, world):
        """The CONTRACT, not the proof of the coercion.

        FastAPI's jsonable_encoder happens to map Decimal to float, so this
        assertion cannot tell `_money` from a raw Decimal on this return path
        (verified — the mutation stays green). It is kept because the contract
        is real: the moment someone adds a `response_model` with a Decimal
        field, Pydantic serializes it as a STRING and the console starts
        sorting "9999.00" before "2500.00". The coercion itself is proven in
        TestMoneyCoercion below.
        """
        body = tiles(api, world["customer_a"])
        assert isinstance(body["monthly_spend"], int | float)
        assert not isinstance(body["monthly_spend"], str)
        assert '"monthly_spend":4000.0' in api.get(
            "/api/account/dashboard", headers=as_(world["customer_a"])
        ).text.replace(" ", "")

    def test_staff_are_refused(self, api, world):
        assert api.get("/api/account/dashboard", headers=as_(world["admin_user"])).status_code == 403

    def test_an_unactivated_customer_is_refused(self, api, world):
        resp = api.get("/api/account/dashboard", headers=as_(world["unactivated"]))
        assert resp.status_code == 403
        assert resp.json()["detail"] == "account_not_activated"

    def test_anonymous_is_refused(self, api, world):
        assert api.get("/api/account/dashboard").status_code in (401, 403)


# ── GET /sponsors ───────────────────────────────────────────────────────────
class TestSponsorList:
    def test_only_my_placements_are_listed(self, api, world):
        rows = sponsors(api, world["customer_a"])
        assert {r["id"] for r in rows} == {
            str(world["kennedy_gold"].id),
            str(world["kennedy_keyword"].id),
            str(world["kennedy_expired"].id),
        }

    def test_another_customers_placement_is_never_listed(self, api, world):
        rows = sponsors(api, world["customer_a"])
        assert str(world["avnet_sponsor"].id) not in {r["id"] for r in rows}
        assert all("Avnet" not in (r["description"] or "") for r in rows)
        # And B sees theirs, so this is scoping rather than an empty route.
        assert {r["id"] for r in sponsors(api, world["customer_b"])} == {
            str(world["avnet_sponsor"].id)
        }

    def test_tier_casing_is_normalized(self, api, world):
        by_id = {r["id"]: r for r in sponsors(api, world["customer_a"])}
        assert by_id[str(world["kennedy_keyword"].id)]["tier"] == "platinum"  # was TitleCase
        assert by_id[str(world["kennedy_expired"].id)]["tier"] == "silver"  # was lowercase
        assert by_id[str(world["kennedy_gold"].id)]["tier"] == "gold"

    def test_placement_is_the_category_name_or_the_keyword(self, api, world):
        by_id = {r["id"]: r for r in sponsors(api, world["customer_a"])}
        gold = by_id[str(world["kennedy_gold"].id)]
        assert gold["placement"] == world["child"].name
        assert gold["placement_type"] == "category"
        keyword = by_id[str(world["kennedy_keyword"].id)]
        assert keyword["placement"] == "capacitors"
        assert keyword["placement_type"] == "keyword"

    def test_a_lapsed_placement_is_listed_with_its_status(self, api, world):
        by_id = {r["id"]: r for r in sponsors(api, world["customer_a"])}
        assert by_id[str(world["kennedy_expired"].id)]["status"] == "Expired"
        assert by_id[str(world["kennedy_expired"].id)]["is_active"] is False

    def test_a_null_status_reads_as_active(self, api, world):
        by_id = {r["id"]: r for r in sponsors(api, world["customer_a"])}
        assert by_id[str(world["kennedy_gold"].id)]["status"] == "Active"
        # The derived flag lives here so the console never re-implements the
        # NULL-means-Active rule and gets it wrong.
        assert by_id[str(world["kennedy_gold"].id)]["is_active"] is True

    def test_amount_reaches_the_wire_as_a_number(self, api, world):
        # Same caveat as monthly_spend: the contract, not the proof. See
        # TestMoneyCoercion.
        by_id = {r["id"]: r for r in sponsors(api, world["customer_a"])}
        amount = by_id[str(world["kennedy_keyword"].id)]["amount"]
        assert isinstance(amount, int | float)
        assert amount == 2500.0

    def test_an_amountless_placement_says_none_not_zero(self, api, world, db):
        """A sponsorship with no amount recorded has no price, which is not
        the same as being free."""
        world["kennedy_keyword"].amount = None
        db.commit()
        by_id = {r["id"]: r for r in sponsors(api, world["customer_a"])}
        assert by_id[str(world["kennedy_keyword"].id)]["amount"] is None

    def test_a_manufacturer_only_customer_gets_an_empty_list(self, api, world):
        """sponsors.supplier_id is NOT NULL — a maker cannot hold one today.
        Empty list, 200, no 500."""
        assert sponsors(api, world["maker_user"]) == []

    def test_an_unlinked_customer_gets_an_empty_list(self, api, world):
        assert sponsors(api, world["free_user"]) == []

    def test_staff_are_refused(self, api, world):
        assert api.get("/api/account/sponsors", headers=as_(world["admin_user"])).status_code == 403

    def test_anonymous_is_refused(self, api, world):
        assert api.get("/api/account/sponsors").status_code in (401, 403)


# ── Wiring ──────────────────────────────────────────────────────────────────
class TestEveryRouteIsScoped:
    def test_the_prefix_is_the_account_namespace(self):
        assert account_dashboard.router.prefix == "/api/account"

    def test_there_are_routes_to_check(self):
        assert len(account_dashboard.router.routes) == 2

    def test_every_route_takes_the_scope_dependency(self):
        """The gate is the dependency. A route added here without it is an
        unscoped, company-wide read behind a customer URL."""
        for route in account_dashboard.router.routes:
            deps = [
                p.default.dependency
                for p in inspect.signature(route.endpoint).parameters.values()
                if isinstance(p.default, params.Depends)
            ]
            assert account_scope in deps, f"{route.path} is not scoped"

    def test_the_scope_dependency_is_the_real_one(self):
        """Guards against the scope being re-derived locally from
        user.supplier_id, which is the whole thing account_scope exists to
        stop."""
        sig = inspect.signature(account_scope)
        assert isinstance(sig.parameters["user"].default, params.Depends)
        assert isinstance(Depends(account_scope), params.Depends)


# ── The money coercion ──────────────────────────────────────────────────────
class TestMoneyCoercion:
    """`sponsors.amount` is a NUMERIC and arrives as a Decimal. Tested
    directly because the route's serializer hides the difference — see
    test_monthly_spend_reaches_the_wire_as_a_number."""

    def test_a_decimal_becomes_a_float(self):
        assert _money(Decimal("1500.00")) == 1500.0
        assert isinstance(_money(Decimal("1500.00")), float)
        assert not isinstance(_money(Decimal("1500.00")), Decimal)

    def test_nothing_spent_is_zero_not_none(self):
        """SUM over no rows is NULL, and the tile has to render a figure."""
        assert _money(None) == 0.0
        assert isinstance(_money(None), float)

    def test_it_rounds_to_the_scale_the_column_stores(self):
        assert _money(Decimal("0.1") + Decimal("0.2")) == 0.3
        assert _money(Decimal("1234.567")) == 1234.57
