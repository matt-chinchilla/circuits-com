"""Self-serve Silver checkout — the public session-mint route and the webhook
handler that turns a completed session into a live sponsor row.

The money rules under test: the client chooses only a PLACEMENT (never a
price), only real subcategories or keywords are sellable, and the sponsor row
appears exactly once no matter how many times Stripe redelivers the event.
"""

import hashlib
import hmac
import json
import time
from decimal import Decimal

import httpx
import pytest

from app.config import settings
from app.models import Expense, Sponsor, Supplier  # noqa: F401 — Expense keeps fixtures importable
from app.services import stripe_checkout, stripe_quotes
from app.services.stripe_checkout import create_silver_checkout_session
from app.services.stripe_webhook import apply_stripe_event

SECRET = "whsec_checkout_test"
URL = "/api/checkout/silver"


@pytest.fixture
def stripe_key(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_checkout")


@pytest.fixture(autouse=True)
def fresh_rate_buckets():
    from app.routes import checkout as checkout_route

    checkout_route._rate_buckets.clear()
    yield
    checkout_route._rate_buckets.clear()


def _session_meta(category_id=None, keyword=None, company="Acme Components", website=None):
    meta = {
        "managed_by": "circuits-com",
        "self_serve": "silver",
        "company_name": company,
        "placement_label": "Clock and Timing",
    }
    if category_id:
        meta["category_id"] = str(category_id)
    if keyword:
        meta["keyword"] = keyword
    if website:
        meta["website"] = website
    return meta


def _completed_event(
    meta, email="ap@acme.example", subscription="sub_selfserve", payment_status="paid",
    amount_total=10000, session_id="cs_test_1",
):
    return {
        "type": "checkout.session.completed",
        "created": int(time.time()) + 60,
        "data": {
            "object": {
                "id": session_id,
                "subscription": subscription,
                "payment_status": payment_status,
                "amount_total": amount_total,
                "customer_details": {"email": email},
                "metadata": meta,
            }
        },
    }


# ── The route ───────────────────────────────────────────────────────────────


def test_routes_404_without_a_key(client):
    assert client.get(URL).status_code == 404
    assert client.post(URL, json={"company_name": "Acme", "keyword": "fets"}).status_code == 404


def test_info_serves_the_ladder_price(client, stripe_key):
    body = client.get(URL).json()
    assert body == {"monthly_total": 100, "tax_included": True}


def test_placement_xor_is_enforced(client, stripe_key, seeded_db):
    both = {"company_name": "Acme", "keyword": "fets", "category_id": str(seeded_db["child"].id)}
    assert client.post(URL, json=both).status_code == 422
    assert client.post(URL, json={"company_name": "Acme"}).status_code == 422


def test_top_level_category_is_not_sellable(client, stripe_key, seeded_db):
    """Silver is a SUBCATEGORY tier — a top-level id is refused before Stripe
    is ever contacted (the tier matrix would refuse the row later anyway)."""
    resp = client.post(
        URL, json={"company_name": "Acme", "category_id": str(seeded_db["parent"].id)}
    )
    assert resp.status_code == 404


def test_unknown_and_malformed_category_ids_are_404(client, stripe_key, seeded_db):
    import uuid as uuid_mod

    for bad in (str(uuid_mod.uuid4()), "not-a-uuid"):
        resp = client.post(URL, json={"company_name": "Acme", "category_id": bad})
        assert resp.status_code == 404, bad


def test_create_builds_the_session_from_the_placement(client, stripe_key, seeded_db, monkeypatch):
    seen = {}

    async def fake_create(client_, **kwargs):
        seen.update(kwargs)
        return {"session_id": "cs_x", "url": "https://checkout.stripe.com/c/pay/cs_x"}

    monkeypatch.setattr(stripe_checkout, "create_silver_checkout_session", fake_create)
    child, parent = seeded_db["child"], seeded_db["parent"]
    resp = client.post(
        URL,
        json={"company_name": "  Acme Components  ", "category_id": str(child.id),
              "website": "acme.example"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["url"].startswith("https://checkout.stripe.com/")
    assert seen["category_id"] == str(child.id)
    assert seen["keyword"] is None
    assert seen["company_name"] == "Acme Components"  # trimmed
    assert seen["placement_label"] == child.name
    assert seen["return_path"] == f"/category/{parent.slug}/{child.slug}"


def test_keyword_placement_builds_its_return_path(client, stripe_key, monkeypatch):
    seen = {}

    async def fake_create(client_, **kwargs):
        seen.update(kwargs)
        return {"session_id": "cs_x", "url": "https://checkout.stripe.com/c/pay/cs_x"}

    monkeypatch.setattr(stripe_checkout, "create_silver_checkout_session", fake_create)
    resp = client.post(URL, json={"company_name": "Acme", "keyword": "mosfets"})
    assert resp.status_code == 200
    assert seen["keyword"] == "mosfets"
    assert seen["return_path"] == "/keyword/mosfets"


def test_session_minting_is_rate_limited_per_ip(client, stripe_key, monkeypatch):
    async def fake_create(client_, **kwargs):
        return {"session_id": "cs_x", "url": "https://checkout.stripe.com/c/pay/cs_x"}

    monkeypatch.setattr(stripe_checkout, "create_silver_checkout_session", fake_create)
    payload = {"company_name": "Acme", "keyword": "fets"}
    codes = [client.post(URL, json=payload).status_code for _ in range(9)]
    assert codes[:8] == [200] * 8
    assert codes[8] == 429


# ── The session builder (real httpx, scripted Stripe) ───────────────────────


def test_session_carries_the_contract(monkeypatch):
    import asyncio

    tape = {}

    def handler(request: httpx.Request) -> httpx.Response:
        from urllib.parse import parse_qsl

        if request.url.path == "/v1/prices":
            keys = request.url.params.get_list("lookup_keys[]")
            return httpx.Response(
                200, json={"data": [{"id": f"price_{k}", "lookup_key": k} for k in keys]}
            )
        tape.update(dict(parse_qsl(request.content.decode())))
        return httpx.Response(200, json={"id": "cs_live", "url": "https://checkout.stripe.com/x"})

    monkeypatch.setattr(settings, "APP_BASE_URL", "https://circuitcenter.ai")

    async def go():
        async with stripe_quotes.make_client(
            "sk_test_x", transport=httpx.MockTransport(handler)
        ) as client:
            return await create_silver_checkout_session(
                client,
                category_id="cat-1",
                keyword=None,
                placement_label="Clock and Timing",
                company_name="Acme Components",
                website="acme.example",
                return_path="/category/ics/clock-and-timing",
            )

    result = asyncio.run(go())
    assert result["url"] == "https://checkout.stripe.com/x"
    assert tape["mode"] == "subscription"
    assert tape["automatic_tax[enabled]"] == "true"
    assert tape["billing_address_collection"] == "required"
    assert tape["line_items[0][price]"] == "price_silver_advertising_monthly"
    assert tape["line_items[1][price]"] == "price_silver_platform_monthly"
    assert tape["metadata[self_serve]"] == "silver"
    assert tape["metadata[company_name]"] == "Acme Components"
    # The subscription mirrors the metadata — later invoice events resolve
    # the sponsor row through it (no sponsor_id exists at mint time).
    assert tape["subscription_data[metadata][self_serve]"] == "silver"
    assert (
        tape["success_url"]
        == "https://circuitcenter.ai/category/ics/clock-and-timing?welcome=silver"
    )
    assert tape["cancel_url"] == "https://circuitcenter.ai/category/ics/clock-and-timing"


# ── The webhook handler ─────────────────────────────────────────────────────


class TestCheckoutCompleted:
    def test_creates_a_fresh_supplier_and_active_sponsor(self, db, seeded_db):
        child = seeded_db["child"]
        outcome = apply_stripe_event(db, _completed_event(_session_meta(category_id=child.id)))
        assert outcome == "checkout_activated"
        supplier = db.query(Supplier).filter(Supplier.name == "Acme Components").one()
        assert supplier.email == "ap@acme.example"
        sponsor = db.query(Sponsor).filter(Sponsor.supplier_id == supplier.id).one()
        assert (sponsor.tier, sponsor.status) == ("Silver", "Active")
        assert str(sponsor.category_id) == str(child.id)
        assert Decimal(str(sponsor.amount)) == Decimal("100")
        assert sponsor.sold_by == settings.SELF_SERVE_ONBOARDING_REP
        assert sponsor.stripe_subscription_id == "sub_selfserve"

    def test_a_buyer_typed_name_never_attaches_to_an_existing_supplier(self, db, seeded_db):
        """The impersonation fix: typing 'AVNET' must NOT publish the seeded
        Avnet distributor's identity — a fresh supplier row is minted, the
        catalog row is untouched, and Avnet's real placements are unaffected."""
        avnet = db.query(Supplier).filter(Supplier.name.ilike("avnet")).one()
        outcome = apply_stripe_event(
            db, _completed_event(_session_meta(category_id=seeded_db["child"].id, company="AVNET"))
        )
        assert outcome == "checkout_activated"
        assert db.query(Supplier).filter(Supplier.name.ilike("avnet")).count() == 2  # fresh row
        new_sponsor = (
            db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_selfserve").one()
        )
        assert new_sponsor.supplier_id != avnet.id

    def test_unpaid_session_does_not_activate(self, db, seeded_db):
        outcome = apply_stripe_event(
            db,
            _completed_event(_session_meta(keyword="fets"), payment_status="unpaid"),
        )
        assert outcome == "checkout_unpaid"
        assert db.query(Sponsor).filter(Sponsor.keyword == "fets").count() == 0

    def test_amount_mismatch_does_not_activate(self, db, seeded_db):
        outcome = apply_stripe_event(
            db, _completed_event(_session_meta(keyword="fets"), amount_total=13285)
        )
        assert outcome == "amount_mismatch"
        assert db.query(Sponsor).filter(Sponsor.keyword == "fets").count() == 0

    def test_no_subscription_id_is_refused(self, db, seeded_db):
        outcome = apply_stripe_event(
            db, _completed_event(_session_meta(keyword="fets"), subscription=None)
        )
        assert outcome == "bad_checkout_metadata"
        assert db.query(Sponsor).filter(Sponsor.keyword == "fets").count() == 0

    def test_redelivery_keyed_on_subscription_id_is_a_noop(self, db, seeded_db):
        event = _completed_event(_session_meta(category_id=seeded_db["child"].id))
        assert apply_stripe_event(db, event) == "checkout_activated"
        assert apply_stripe_event(db, event) == "duplicate_checkout"
        assert (
            db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_selfserve").count()
            == 1
        )

    def test_two_different_subscriptions_both_activate(self, db, seeded_db):
        """Silver is multi-occupant: two real buyers on the same board, two
        subscriptions, two rows — distinct owner ids, no false duplicate."""
        child = seeded_db["child"]
        a = _completed_event(
            _session_meta(category_id=child.id, company="Buyer A"),
            subscription="sub_a", session_id="cs_a",
        )
        b = _completed_event(
            _session_meta(category_id=child.id, company="Buyer B"),
            subscription="sub_b", session_id="cs_b",
        )
        assert apply_stripe_event(db, a) == "checkout_activated"
        assert apply_stripe_event(db, b) == "checkout_activated"
        assert (
            db.query(Sponsor)
            .filter(Sponsor.category_id == child.id, Sponsor.stripe_subscription_id.isnot(None))
            .count()
            == 2
        )

    def test_oversized_email_is_bounded_not_a_500(self, db, seeded_db):
        outcome = apply_stripe_event(
            db,
            _completed_event(_session_meta(keyword="fets"), email="x" * 500 + "@e.example"),
        )
        assert outcome == "checkout_activated"
        supplier = (
            db.query(Sponsor)
            .filter(Sponsor.keyword == "fets")
            .join(Supplier, Sponsor.supplier_id == Supplier.id)
            .with_entities(Supplier)
            .one()
        )
        assert len(supplier.email) <= 200

    def test_keyword_purchase_creates_a_keyword_sponsor(self, db, seeded_db):
        outcome = apply_stripe_event(db, _completed_event(_session_meta(keyword="mosfets")))
        assert outcome == "checkout_activated"
        sponsor = db.query(Sponsor).filter(Sponsor.keyword == "mosfets").one()
        assert sponsor.category_id is None

    def test_foreign_or_missing_metadata_is_ignored(self, db, seeded_db):
        assert apply_stripe_event(db, _completed_event({})) == "ignored_checkout"
        meta = _session_meta(keyword="fets")
        meta["managed_by"] = "someone-else"
        assert apply_stripe_event(db, _completed_event(meta)) == "ignored_checkout"

    def test_unusable_metadata_is_acked_not_raised(self, db, seeded_db):
        meta = _session_meta()  # neither placement
        assert apply_stripe_event(db, _completed_event(meta)) == "bad_checkout_metadata"
        both = _session_meta(category_id=seeded_db["child"].id, keyword="fets")
        assert apply_stripe_event(db, _completed_event(both)) == "bad_checkout_metadata"


class TestSelfServeLifecycle:
    """Later subscription events carry no sponsor_id (the row postdates the
    subscription) — they resolve STRICTLY by the subscription id, never by the
    forgeable company name."""

    def _buy(self, db, seeded_db, keyword="mosfets", subscription="sub_selfserve"):
        apply_stripe_event(
            db, _completed_event(_session_meta(keyword=keyword), subscription=subscription)
        )
        return db.query(Sponsor).filter(Sponsor.keyword == keyword).one()

    def test_invoice_paid_resolves_by_subscription_id(self, db, seeded_db):
        sponsor = self._buy(db, seeded_db)
        sponsor.status = "Expired"
        db.commit()
        event = {
            "type": "invoice.paid",
            "created": int(time.time()) + 120,
            "data": {"object": {"id": "in_9", "subscription": "sub_selfserve"}},
        }
        assert apply_stripe_event(db, event) == "status_active"
        db.refresh(sponsor)
        assert sponsor.status == "Active"

    def test_subscription_deleted_expires_the_self_serve_row(self, db, seeded_db):
        sponsor = self._buy(db, seeded_db)
        event = {
            "type": "customer.subscription.deleted",
            "created": int(time.time()) + 120,
            "data": {"object": {"id": "sub_selfserve"}},
        }
        assert apply_stripe_event(db, event) == "status_expired"
        db.refresh(sponsor)
        assert sponsor.status == "Expired"

    def test_a_strangers_cancellation_cannot_touch_another_row(self, db, seeded_db):
        """The critical fix: a cancellation for an UNKNOWN subscription id
        resolves to nothing, so it can never expire someone else's board."""
        victim = self._buy(db, seeded_db, keyword="mosfets", subscription="sub_victim")
        event = {
            "type": "customer.subscription.deleted",
            "created": int(time.time()) + 999,
            "data": {"object": {"id": "sub_attacker_unknown"}},
        }
        assert apply_stripe_event(db, event) == "no_sponsor_id"
        db.refresh(victim)
        assert victim.status == "Active"

    def test_self_serve_cancellation_cannot_expire_a_rep_sold_row(self, db, seeded_db):
        """A rep-quoted Gold row (no stripe_subscription_id) must never be
        matched by a self-serve subscription event."""
        from app.models import Sponsor as SponsorModel

        gold = SponsorModel(
            supplier_id=seeded_db["supplier2"].id,
            keyword="rep-gold",
            tier="Gold",
            status="Active",
        )
        db.add(gold)
        db.commit()
        event = {
            "type": "customer.subscription.deleted",
            "created": int(time.time()) + 120,
            "data": {"object": {"id": "sub_never_stamped"}},
        }
        assert apply_stripe_event(db, event) == "no_sponsor_id"
        db.refresh(gold)
        assert gold.status == "Active"


def test_route_end_to_end_signed_delivery(client, db, seeded_db, monkeypatch):
    """One signed pass through POST /api/stripe/webhook, no monkeypatched
    service — the transport is the only fake."""
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", SECRET)
    payload = json.dumps(_completed_event(_session_meta(keyword="igbts"))).encode()
    t = int(time.time())
    mac = hmac.new(SECRET.encode(), f"{t}.".encode() + payload, hashlib.sha256).hexdigest()
    resp = client.post(
        "/api/stripe/webhook", content=payload, headers={"stripe-signature": f"t={t},v1={mac}"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == "checkout_activated"
    assert db.query(Sponsor).filter(Sponsor.keyword == "igbts").count() == 1


class TestSilverBoards:
    """The /pricing placement picker's data — open slot counts per board."""

    def test_404_without_a_key(self, client, seeded_db):
        assert client.get("/api/checkout/silver/boards").status_code == 404

    def test_lists_subcategories_with_open_slots(self, client, stripe_key, seeded_db):
        body = client.get("/api/checkout/silver/boards").json()
        assert body["monthly_total"] == 100
        child = seeded_db["child"]
        board = next(b for b in body["boards"] if b["category_id"] == str(child.id))
        assert board["name"] == child.name
        assert board["parent_name"] == seeded_db["parent"].name
        assert board["path"] == f"/category/{seeded_db['parent'].slug}/{child.slug}"
        assert board["total_slots"] == 5
        # seeded_db plants a GOLD sponsor on this child — Gold must not
        # consume a Silver slot.
        assert board["open_slots"] == 5

    def test_top_level_categories_are_never_listed(self, client, stripe_key, seeded_db):
        body = client.get("/api/checkout/silver/boards").json()
        ids = {b["category_id"] for b in body["boards"]}
        assert str(seeded_db["parent"].id) not in ids

    def test_an_active_silver_sponsor_consumes_a_slot(self, client, stripe_key, db, seeded_db):
        child = seeded_db["child"]
        db.add(
            Sponsor(
                supplier_id=seeded_db["supplier1"].id,
                category_id=child.id,
                tier="Silver",
                status="Active",
            )
        )
        db.commit()
        body = client.get("/api/checkout/silver/boards").json()
        board = next(b for b in body["boards"] if b["category_id"] == str(child.id))
        assert board["open_slots"] == 4

    def test_a_null_status_silver_row_still_counts_as_taken(
        self, client, stripe_key, db, seeded_db
    ):
        """Legacy seed rows carry NULL status and ARE active — counting them
        as free would sell a slot that is visibly occupied."""
        child = seeded_db["child"]
        db.add(
            Sponsor(
                supplier_id=seeded_db["supplier1"].id,
                category_id=child.id,
                tier="silver",  # lowercase legacy casing too
                status=None,
            )
        )
        db.commit()
        body = client.get("/api/checkout/silver/boards").json()
        board = next(b for b in body["boards"] if b["category_id"] == str(child.id))
        assert board["open_slots"] == 4

    def test_an_expired_sponsor_frees_its_slot(self, client, stripe_key, db, seeded_db):
        child = seeded_db["child"]
        db.add(
            Sponsor(
                supplier_id=seeded_db["supplier1"].id,
                category_id=child.id,
                tier="Silver",
                status="Expired",
            )
        )
        db.commit()
        body = client.get("/api/checkout/silver/boards").json()
        board = next(b for b in body["boards"] if b["category_id"] == str(child.id))
        assert board["open_slots"] == 5


class TestBoardCapacity:
    """A full board cannot be sold a sixth slot.

    Nothing downstream enforces this — migration 016's partial unique indexes
    back only the single-slot tiers (Silver is deliberately multi-occupant)
    and the webhook's gates are about money, not occupancy. So the check at
    session-mint is the last moment before Stripe holds the customer's cash.
    """

    def _fill(self, db, seeded_db, count):
        for i in range(count):
            supplier = Supplier(name=f"Filler {i}")
            db.add(supplier)
            db.flush()
            db.add(
                Sponsor(
                    supplier_id=supplier.id,
                    category_id=seeded_db["child"].id,
                    tier="Silver",
                    status="Active",
                )
            )
        db.commit()

    def test_a_full_board_refuses_the_session(self, client, stripe_key, db, seeded_db):
        self._fill(db, seeded_db, 5)
        resp = client.post(
            URL,
            json={"company_name": "Latecomer", "category_id": str(seeded_db["child"].id)},
        )
        assert resp.status_code == 409
        assert "full" in resp.json()["detail"].lower()

    def test_the_last_slot_is_still_sellable(self, client, stripe_key, db, seeded_db, monkeypatch):
        async def fake_create(client_, **kwargs):
            return {"session_id": "cs_x", "url": "https://checkout.stripe.com/c/pay/cs_x"}

        monkeypatch.setattr(stripe_checkout, "create_silver_checkout_session", fake_create)
        self._fill(db, seeded_db, 4)
        resp = client.post(
            URL,
            json={"company_name": "Fifth", "category_id": str(seeded_db["child"].id)},
        )
        assert resp.status_code == 200

    def test_expired_rows_do_not_hold_capacity(self, client, stripe_key, db, seeded_db, monkeypatch):
        async def fake_create(client_, **kwargs):
            return {"session_id": "cs_x", "url": "https://checkout.stripe.com/c/pay/cs_x"}

        monkeypatch.setattr(stripe_checkout, "create_silver_checkout_session", fake_create)
        self._fill(db, seeded_db, 5)
        for row in db.query(Sponsor).filter(Sponsor.category_id == seeded_db["child"].id).all():
            if row.tier == "Silver":
                row.status = "Expired"
        db.commit()
        resp = client.post(
            URL,
            json={"company_name": "Returning", "category_id": str(seeded_db["child"].id)},
        )
        assert resp.status_code == 200

    def test_gold_does_not_consume_a_silver_slot(self, client, stripe_key, db, seeded_db, monkeypatch):
        async def fake_create(client_, **kwargs):
            return {"session_id": "cs_x", "url": "https://checkout.stripe.com/c/pay/cs_x"}

        monkeypatch.setattr(stripe_checkout, "create_silver_checkout_session", fake_create)
        # seeded_db already plants a GOLD sponsor on this child.
        self._fill(db, seeded_db, 4)
        resp = client.post(
            URL, json={"company_name": "Fifth", "category_id": str(seeded_db["child"].id)}
        )
        assert resp.status_code == 200

    def test_keyword_placements_are_not_capacity_checked(self, client, stripe_key, monkeypatch):
        """Keywords are multi-occupant with no five-slot board behind them."""

        async def fake_create(client_, **kwargs):
            return {"session_id": "cs_x", "url": "https://checkout.stripe.com/c/pay/cs_x"}

        monkeypatch.setattr(stripe_checkout, "create_silver_checkout_session", fake_create)
        resp = client.post(URL, json={"company_name": "Anyone", "keyword": "mosfets"})
        assert resp.status_code == 200
