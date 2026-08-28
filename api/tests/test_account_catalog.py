"""The customer's CATALOG endpoints — app/routes/account_catalog.py.

Every route here answers a question about the caller's OWN company rows, and
the whole value of the router is the word "own". So these tests are built the
way test_account_scope.py is: the fixture contains a second, fully-populated
customer, and every visibility assertion names BOTH the rows that must come
back AND the rows that must not. A scoping test that passes against unscoped
code is measuring nothing — which is why the load-bearing test in this file is
:class:`TestOneCustomerNeverSeesAnother`, and why every filter here has been
mutation-checked (break it, watch this file redden). See the report.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.models import Category, Manufacturer, Part, PartListing, User
from app.routes import account_catalog
from app.routes.parts import part_to_dict
from app.services.auth_service import create_token

ROUTES = [
    "/api/account/parts",
    "/api/account/categories",
    "/api/account/manufacturers",
    "/api/account/suppliers",
    "/api/account/my-supply",
    "/api/account/my-manufacturing",
]


# ── Fixture ─────────────────────────────────────────────────────────────────
# Two linked DISTRIBUTORS with disjoint shelves, one MAKER, one account holding
# both links, and one free account. Every route below has a different correct
# answer for each of them, so an if/elif union, an intersection, a missing
# filter, or a filter keyed on the wrong link each produce a detectable result.
@pytest.fixture
def world(db, seeded_db):
    kennedy = seeded_db["supplier2"]  # company_user's distributor
    avnet = seeded_db["supplier1"]  # the OTHER customer's distributor

    nordic = Manufacturer(
        id=uuid.uuid4(),
        name="Nordic Semiconductor",
        slug="nordic-semiconductor",
        canonical_key="nordicsemiconductor",
        website="nordicsemi.com",
    )
    renesas = Manufacturer(
        id=uuid.uuid4(),
        name="Renesas Electronics",
        slug="renesas-electronics",
        canonical_key="renesaselectronics",
    )
    db.add_all([nordic, renesas])
    db.flush()

    # A second category, so "a category my parts are not in" is a real row.
    power = Category(
        id=uuid.uuid4(),
        name="Power Management",
        slug="power-management",
        icon="battery-charging",
        sort_order=1,
    )
    db.add(power)
    db.flush()

    child = seeded_db["child"]

    def _part(sku, cat, mfr, desc="chip"):
        p = Part(
            id=uuid.uuid4(),
            sku=sku,
            description=desc,
            manufacturer_name=mfr.name if mfr else "Unknown",
            manufacturer_id=mfr.id if mfr else None,
            category_id=cat.id,
            lifecycle_status="active",
        )
        db.add(p)
        return p

    part_ken_nordic = _part("NRF52840-QIAA-R7", child, nordic, "Bluetooth 5.4 SoC")
    part_ken_renesas = _part("R5F5210", child, renesas, "Renesas MCU")
    part_avnet_secret = _part("AVNET-ONLY-01", power, renesas, "Only Avnet lists this")
    part_made_only = _part("NRF9160-SICA", power, nordic, "Nobody stocks it yet")
    part_nordic_at_avnet = _part("NRF52833-QIAA", power, nordic, "Avnet stocks it")
    db.flush()

    def _listing(part, supplier, sku, price="1.0000"):
        li = PartListing(
            id=uuid.uuid4(),
            part_id=part.id,
            supplier_id=supplier.id,
            sku=sku,
            stock_quantity=10,
            unit_price=Decimal(price),
        )
        db.add(li)
        return li

    _listing(part_ken_nordic, kennedy, "KEN-NRF52840")
    _listing(part_ken_renesas, kennedy, "KEN-R5F5210")
    _listing(part_avnet_secret, avnet, "AVN-ONLY-01")
    _listing(part_nordic_at_avnet, avnet, "AVN-NRF52833")
    db.flush()

    pw = seeded_db["company_user"].password_hash

    def _user(username, email, supplier_id=None, manufacturer_id=None, activated=True):
        u = User(
            id=uuid.uuid4(),
            username=username,
            password_hash=pw,
            role="user",
            email=email,
            email_verified_at=datetime.now(UTC),
            activated_at=datetime.now(UTC) if activated else None,
            supplier_id=supplier_id,
            manufacturer_id=manufacturer_id,
        )
        db.add(u)
        return u

    # company_user is the Kennedy distributor; it just needs activating.
    kennedy_user = seeded_db["company_user"]
    kennedy_user.activated_at = datetime.now(UTC)

    avnet_user = _user("avnet_user", "avnet_user@test.example", supplier_id=avnet.id)
    maker_user = _user("maker_user", "maker_user@test.example", manufacturer_id=nordic.id)
    both_user = _user(
        "both_user",
        "both_user@test.example",
        supplier_id=kennedy.id,
        manufacturer_id=nordic.id,
    )
    free_user = _user("free_user", "free_user@test.example")
    pending_user = _user(
        "pending_user", "pending@test.example", supplier_id=kennedy.id, activated=False
    )
    db.commit()

    return {
        **seeded_db,
        "kennedy": kennedy,
        "avnet": avnet,
        "nordic": nordic,
        "renesas": renesas,
        "power": power,
        "part_ken_nordic": part_ken_nordic,
        "part_ken_renesas": part_ken_renesas,
        "part_avnet_secret": part_avnet_secret,
        "part_made_only": part_made_only,
        "part_nordic_at_avnet": part_nordic_at_avnet,
        "kennedy_user": kennedy_user,
        "avnet_user": avnet_user,
        "maker_user": maker_user,
        "both_user": both_user,
        "free_user": free_user,
        "pending_user": pending_user,
    }


@pytest.fixture
def api(db):
    """The router on its own app.

    main.py is registered by the controller after this task lands, and this
    file must not depend on that ordering; the router carries its own gate, so
    mounting it alone tests exactly what ships.
    """
    test_app = FastAPI()
    test_app.include_router(account_catalog.router)
    test_app.dependency_overrides[get_db] = lambda: db
    return TestClient(test_app)


def hdr(user):
    return {"Authorization": f"Bearer {create_token(str(user.id), 'user')}"}


def get(api, user, path, **params):
    resp = api.get(path, headers=hdr(user), params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def skus(payload):
    return {item["sku"] for item in payload["items"]}


# ── The gate ────────────────────────────────────────────────────────────────
class TestEveryRouteIsGated:
    @pytest.mark.parametrize("path", ROUTES)
    def test_anonymous_is_refused(self, api, world, path):
        assert api.get(path).status_code in (401, 403)

    @pytest.mark.parametrize("path", ROUTES)
    def test_unactivated_customer_is_refused(self, api, world, path):
        resp = api.get(path, headers=hdr(world["pending_user"]))
        assert resp.status_code == 403
        assert resp.json()["detail"] == "account_not_activated"

    @pytest.mark.parametrize("path", ROUTES)
    def test_staff_are_refused(self, api, world, path):
        """These are the CUSTOMER's rows. An admin has the admin console; a
        staff token here would resolve to a scope with no links anyway, so the
        wall must refuse it rather than silently return an empty page."""
        admin = world["admin_user"]
        token = create_token(str(admin.id), "admin")
        resp = api.get(path, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 403


# ── GET /parts ──────────────────────────────────────────────────────────────
class TestParts:
    def test_the_catalog_is_not_empty(self, world, db):
        """Guards every 'sees nothing' assertion below from passing vacuously."""
        assert db.query(Part).count() == 7

    def test_distributor_sees_only_the_parts_it_carries(self, api, world):
        body = get(api, world["kennedy_user"], "/api/account/parts")
        assert skus(body) == {"LM7805CT", "NRF52840-QIAA-R7", "R5F5210"}
        assert body["total"] == 3

    def test_manufacturer_sees_only_the_parts_it_makes(self, api, world):
        body = get(api, world["maker_user"], "/api/account/parts")
        assert skus(body) == {"NRF52840-QIAA-R7", "NRF9160-SICA", "NRF52833-QIAA"}

    def test_both_links_see_the_union_with_the_overlap_once(self, api, world):
        body = get(api, world["both_user"], "/api/account/parts")
        assert skus(body) == {
            "LM7805CT",
            "NRF52840-QIAA-R7",
            "R5F5210",
            "NRF9160-SICA",
            "NRF52833-QIAA",
        }
        assert body["total"] == 5
        assert len(body["items"]) == 5  # NRF52840 is carried AND made — once

    def test_unlinked_gets_an_empty_page_not_the_catalog(self, api, world):
        body = get(api, world["free_user"], "/api/account/parts")
        assert body["items"] == []
        assert body["total"] == 0

    def test_the_part_shape_is_the_one_the_site_already_uses(self, api, world, db):
        body = get(api, world["kennedy_user"], "/api/account/parts")
        item = next(i for i in body["items"] if i["sku"] == "LM7805CT")
        assert set(item) == set(part_to_dict(world["part1"], db))

    def test_search_narrows_within_the_scope(self, api, world):
        body = get(api, world["kennedy_user"], "/api/account/parts", search="NRF")
        assert skus(body) == {"NRF52840-QIAA-R7"}

    def test_search_cannot_reach_outside_the_scope(self, api, world):
        """The other customer's part matches the term and must still be absent."""
        body = get(api, world["kennedy_user"], "/api/account/parts", search="NRF52833")
        assert body["items"] == []

    def test_category_filter_cannot_widen_the_scope(self, api, world):
        """Handing in the id of a category holding only the OTHER customer's
        parts narrows to nothing — it never re-opens the catalog."""
        body = get(
            api,
            world["kennedy_user"],
            "/api/account/parts",
            category_id=str(world["power"].id),
        )
        assert body["items"] == []

    def test_a_garbage_category_id_is_a_404_not_a_500(self, api, world):
        resp = api.get(
            "/api/account/parts",
            headers=hdr(world["kennedy_user"]),
            params={"category_id": "not-a-uuid"},
        )
        assert resp.status_code == 404

    def test_pagination_walks_the_scope_and_never_past_it(self, api, world):
        first = get(api, world["kennedy_user"], "/api/account/parts", per_page=2, page=1)
        second = get(api, world["kennedy_user"], "/api/account/parts", per_page=2, page=2)
        assert first["total"] == second["total"] == 3
        assert first["pages"] == 2
        assert len(first["items"]) == 2
        assert len(second["items"]) == 1
        assert skus(first) | skus(second) == {"LM7805CT", "NRF52840-QIAA-R7", "R5F5210"}


# ── GET /categories ─────────────────────────────────────────────────────────
class TestCategories:
    def test_distributor_sees_only_categories_its_own_parts_are_in(self, api, world):
        body = get(api, world["kennedy_user"], "/api/account/categories")
        assert [c["slug"] for c in body["categories"]] == ["clock-and-timing"]
        assert body["categories"][0]["parts_count"] == 3

    def test_the_other_customers_category_is_absent(self, api, world):
        body = get(api, world["kennedy_user"], "/api/account/categories")
        assert "power-management" not in {c["slug"] for c in body["categories"]}

    def test_counts_are_scoped_not_global(self, api, world):
        """clock-and-timing holds FOUR parts; Kennedy carries three of them.
        A count taken over the whole category rather than the caller's slice
        reads 4 here."""
        body = get(api, world["maker_user"], "/api/account/categories")
        counts = {c["slug"]: c["parts_count"] for c in body["categories"]}
        assert counts == {"clock-and-timing": 1, "power-management": 2}

    def test_the_parent_is_named_so_a_subcategory_can_be_placed(self, api, world):
        body = get(api, world["kennedy_user"], "/api/account/categories")
        row = body["categories"][0]
        assert row["parent_name"] == "Integrated Circuits"
        assert row["parent_slug"] == "integrated-circuits"

    def test_the_parents_icon_travels_so_the_console_can_draw_the_tree(self, api, world):
        """The customer console rebuilds the staff page's two-level tree out of
        these flat rows. A parent holding none of the caller's own parts is
        never a row in its own right, so this field is the ONLY place its icon
        can come from — without it every parent head draws with a hole."""
        body = get(api, world["kennedy_user"], "/api/account/categories")
        row = body["categories"][0]
        assert row["parent_icon"] == "\u26a1"

    def test_unlinked_sees_none(self, api, world):
        assert get(api, world["free_user"], "/api/account/categories")["categories"] == []


# ── GET /manufacturers ──────────────────────────────────────────────────────
class TestManufacturers:
    def test_distributor_sees_the_makers_whose_parts_it_sells(self, api, world):
        body = get(api, world["kennedy_user"], "/api/account/manufacturers")
        assert {m["name"] for m in body["manufacturers"]} == {
            "Nordic Semiconductor",
            "Renesas Electronics",
        }
        assert all(m["parts_count"] == 1 for m in body["manufacturers"])

    def test_a_maker_the_other_distributor_sells_is_counted_only_there(self, api, world):
        """Renesas is carried by BOTH customers, on DIFFERENT parts. Each one's
        count must be their own — a global count reads 2."""
        ken = get(api, world["kennedy_user"], "/api/account/manufacturers")
        avn = get(api, world["avnet_user"], "/api/account/manufacturers")
        assert {m["name"]: m["parts_count"] for m in ken["manufacturers"]}[
            "Renesas Electronics"
        ] == 1
        assert {m["name"]: m["parts_count"] for m in avn["manufacturers"]}[
            "Renesas Electronics"
        ] == 1

    def test_a_maker_only_account_gets_nothing(self, api, world):
        """This route answers a DISTRIBUTOR's question. A maker's own linked
        manufacturer row is /my-manufacturing, and must not appear here."""
        assert get(api, world["maker_user"], "/api/account/manufacturers")["manufacturers"] == []

    def test_both_links_still_only_report_the_distributor_half(self, api, world):
        body = get(api, world["both_user"], "/api/account/manufacturers")
        assert {m["name"] for m in body["manufacturers"]} == {
            "Nordic Semiconductor",
            "Renesas Electronics",
        }
        assert {m["name"]: m["parts_count"] for m in body["manufacturers"]} == {
            "Nordic Semiconductor": 1,
            "Renesas Electronics": 1,
        }

    def test_a_part_with_no_resolved_maker_produces_no_row(self, api, world):
        """LM7805CT (Kennedy carries it) has manufacturer_id NULL — the legacy
        state of 3,229 production rows. It must be skipped, never surface as a
        null-named maker."""
        body = get(api, world["kennedy_user"], "/api/account/manufacturers")
        assert all(m["name"] for m in body["manufacturers"])
        assert len(body["manufacturers"]) == 2

    def test_unlinked_sees_none(self, api, world):
        assert get(api, world["free_user"], "/api/account/manufacturers")["manufacturers"] == []

    def test_no_crm_columns_ride_along(self, api, world):
        """The manufacturers table is the Leads CRM's universe. A customer gets
        the public facts about a maker they carry and nothing else."""
        body = get(api, world["kennedy_user"], "/api/account/manufacturers")
        leaked = set(body["manufacturers"][0]) - {
            "id",
            "name",
            "slug",
            "website",
            "logo_url",
            "parts_count",
        }
        assert not leaked


# ── GET /suppliers ──────────────────────────────────────────────────────────
class TestSuppliers:
    def test_maker_sees_the_distributors_stocking_its_parts(self, api, world):
        body = get(api, world["maker_user"], "/api/account/suppliers")
        assert {s["name"] for s in body["suppliers"]} == {"Kennedy Electronics", "Avnet"}
        assert {s["name"]: s["parts_count"] for s in body["suppliers"]} == {
            "Kennedy Electronics": 1,
            "Avnet": 1,
        }

    def test_a_distributor_only_account_gets_nothing(self, api, world):
        """This route answers a MAKER's question. Kennedy carries plenty and
        still gets an empty list — the answer must key on manufacturer_id."""
        assert get(api, world["kennedy_user"], "/api/account/suppliers")["suppliers"] == []

    def test_both_links_still_only_report_the_maker_half(self, api, world):
        body = get(api, world["both_user"], "/api/account/suppliers")
        assert {s["name"] for s in body["suppliers"]} == {"Kennedy Electronics", "Avnet"}

    def test_counts_are_my_parts_not_their_whole_shelf(self, api, world):
        """Avnet lists two parts; only one of them is Nordic's."""
        body = get(api, world["maker_user"], "/api/account/suppliers")
        assert {s["name"]: s["parts_count"] for s in body["suppliers"]}["Avnet"] == 1

    def test_unlinked_sees_none(self, api, world):
        assert get(api, world["free_user"], "/api/account/suppliers")["suppliers"] == []


# ── GET /my-supply and /my-manufacturing ────────────────────────────────────
class TestMyCompanyRows:
    def test_my_supply_is_my_own_supplier(self, api, world):
        body = get(api, world["kennedy_user"], "/api/account/my-supply")
        assert body["id"] == str(world["kennedy"].id)
        assert body["name"] == "Kennedy Electronics"

    def test_my_supply_is_404_without_the_link(self, api, world):
        resp = api.get("/api/account/my-supply", headers=hdr(world["maker_user"]))
        assert resp.status_code == 404

    def test_my_supply_never_leaks_the_crm_bridge(self, api, world):
        body = get(api, world["kennedy_user"], "/api/account/my-supply")
        assert "manufacturer_id" not in body

    def test_my_manufacturing_is_my_own_maker(self, api, world):
        body = get(api, world["maker_user"], "/api/account/my-manufacturing")
        assert body["id"] == str(world["nordic"].id)
        assert body["name"] == "Nordic Semiconductor"

    def test_my_manufacturing_is_404_without_the_link(self, api, world):
        resp = api.get("/api/account/my-manufacturing", headers=hdr(world["kennedy_user"]))
        assert resp.status_code == 404

    def test_an_account_holding_both_gets_both(self, api, world):
        """Avnet distributes AND manufactures — neither route may be an elif."""
        assert get(api, world["both_user"], "/api/account/my-supply")["name"] == (
            "Kennedy Electronics"
        )
        assert get(api, world["both_user"], "/api/account/my-manufacturing")["name"] == (
            "Nordic Semiconductor"
        )

    def test_a_free_account_has_neither(self, api, world):
        for path in ("/api/account/my-supply", "/api/account/my-manufacturing"):
            assert api.get(path, headers=hdr(world["free_user"])).status_code == 404


# ── The load-bearing one ────────────────────────────────────────────────────
class TestOneCustomerNeverSeesAnother:
    """Two real, linked, populated customers. Neither may reach the other's
    rows through ANY route on this router."""

    def test_kennedy_never_sees_avnets_exclusive_part(self, api, world):
        body = get(api, world["kennedy_user"], "/api/account/parts")
        assert "AVNET-ONLY-01" not in skus(body)

    def test_avnet_never_sees_kennedys_exclusive_parts(self, api, world):
        body = get(api, world["avnet_user"], "/api/account/parts")
        assert skus(body) == {"LM7805CT", "AVNET-ONLY-01", "NRF52833-QIAA"}
        assert "R5F5210" not in skus(body)
        assert "NRF52840-QIAA-R7" not in skus(body)

    def test_neither_sees_the_others_category(self, api, world):
        ken = get(api, world["kennedy_user"], "/api/account/categories")
        avn = get(api, world["avnet_user"], "/api/account/categories")
        assert {c["slug"] for c in ken["categories"]} == {"clock-and-timing"}
        assert {c["slug"] for c in avn["categories"]} == {
            "clock-and-timing",
            "power-management",
        }

    def test_my_supply_is_never_the_other_customers_company(self, api, world):
        ken = get(api, world["kennedy_user"], "/api/account/my-supply")
        avn = get(api, world["avnet_user"], "/api/account/my-supply")
        assert ken["id"] != avn["id"]
        assert avn["name"] == "Avnet"

    def test_the_other_customers_supplier_row_is_not_reachable(self, api, world):
        """Kennedy's console never names Avnet, on any route, in any field."""
        for path in ROUTES:
            resp = api.get(path, headers=hdr(world["kennedy_user"]))
            if resp.status_code == 404:
                continue
            assert str(world["avnet"].id) not in resp.text, path
