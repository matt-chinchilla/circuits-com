"""The rep billing console — /api/admin/sponsors/{id}/billing (spec §9).

Every route is driven through the real app against the shared FakeStripe
(``tests/fake_stripe.py``, dahlia shapes, filters on query params) put
behind ``stripe_quotes.make_client``. What Stripe RECEIVED is read off the
tape; what we mirrored is read off the DB.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl

import httpx
import pytest

from app.config import settings
from app.models import Sponsor
from app.models.sales import BillingAudit, SalesCode, SponsorBilling, SponsorPayment
from app.services import category_cache, stripe_quotes
from tests.fake_stripe import FakeStripe, Req

SUB = "sub_000000000001"
CUS = "cus_000000000001"
KEY = {"Idempotency-Key": "3f1c0a52-9f1e-4b8e-9d0a-7c2b6f1e0a11"}


class IdempotentFakeStripe(FakeStripe):
    """FakeStripe plus Stripe's idempotency replay: a POST repeating an
    ``Idempotency-Key`` with the same path and body is answered with the
    FIRST response and never reaches the handler's state; the same key with
    different parameters is Stripe's 400 ``idempotency_error``."""

    def __init__(self) -> None:
        super().__init__()
        self._replays: dict[str, tuple[str, str, httpx.Response]] = {}
        self.replayed: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        key = request.headers.get("Idempotency-Key")
        if request.method != "POST" or not key:
            return super().handler(request)
        body = request.content.decode()
        seen = self._replays.get(key)
        if seen is not None:
            path, form, response = seen
            if (path, form) != (request.url.path, body):
                return httpx.Response(
                    400,
                    json={
                        "error": {
                            "type": "idempotency_error",
                            "message": "Keys for idempotent requests can only be used "
                            "with the same parameters they were first used with.",
                        }
                    },
                )
            self.replayed.append(key)
            form_seen = dict(parse_qsl(body, keep_blank_values=True))
            self.tape.append(
                Req("POST", request.url.path, form_seen, {}, httpx.Headers(request.headers))
            )
            return httpx.Response(response.status_code, content=response.content)
        response = super().handler(request)
        response.read()
        self._replays[key] = (request.url.path, body, response)
        return response


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_console")
    stripe = IdempotentFakeStripe()
    monkeypatch.setattr(stripe_quotes, "make_client", stripe.make_client)
    return stripe


@pytest.fixture
def billed(db, seeded_db, fake):
    """The seeded Gold sponsor (Kennedy on the child), sold at the Founder's
    Deal through checkout: an active Stripe subscription on GOLD-AT-2100."""
    sponsor = db.get(Sponsor, seeded_db["sponsor"].id)
    sponsor.status = "Active"
    sponsor.stripe_subscription_id = SUB
    db.add(
        SponsorBilling(
            sponsor_id=sponsor.id,
            stripe_customer_id=CUS,
            stripe_subscription_id=SUB,
            channel="self_serve",
            list_usd=2500,
            founder_usd=2100,
            price_usd=2100,
        )
    )
    db.commit()
    fake.add_coupon("GOLD-AT-2100", amount_off=40000, products=fake.product_ids("gold"))
    fake.add_payment_method("pm_card_visa1", brand="visa", last4="4242")
    fake.add_customer(CUS, email="info@kennedy.com", default_payment_method="pm_card_visa1")
    fake.add_subscription(
        SUB,
        customer=CUS,
        tier="gold",
        coupons=["GOLD-AT-2100"],
        period_ends=[1_900_000_000, 1_900_000_500],
        metadata={"managed_by": "circuits-com"},
    )
    return sponsor


def _url(sponsor, action: str = "") -> str:
    return f"/api/admin/sponsors/{sponsor.id}/billing{('/' + action) if action else ''}"


# ── GET ─────────────────────────────────────────────────────────────────────


def test_get_composes_the_live_subscription(client, db, billed, fake, auth_header):
    fake.add_paid_invoice("in_000000000001", sub=SUB, pi="pi_000000000001", amount=210000)
    fake.add_open_invoice("in_000000000002", sub=SUB, amount=210000)
    resp = client.get(_url(billed), headers=auth_header())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["configured"] is True
    assert body["subscription_id"] == SUB
    assert body["status"] == "active"
    assert body["collection_method"] == "charge_automatically"
    assert body["cancel_scheduled"] is False and body["cancel_at"] is None
    # period end = the LATEST item's current_period_end (dahlia)
    assert body["period_end"] == datetime.fromtimestamp(1_900_000_500, UTC).isoformat()
    # next charge from create_preview: 2,500 list − 400 coupon
    assert body["next_charge"]["amount_cents"] == 210000
    assert body["card"] == {"brand": "visa", "last4": "4242", "exp_month": 12, "exp_year": 2030}
    assert (body["list_usd"], body["founder_usd"], body["price_usd"]) == (2500, 2100, 2100)
    assert body["code_points"] == 0
    assert body["channel"] == "self_serve"
    assert body["legacy_price"] is False
    assert body["needs_resolution"] is None
    ids = [i["id"] for i in body["invoices"]]
    assert set(ids) == {"in_000000000001", "in_000000000002"}
    paid = next(i for i in body["invoices"] if i["id"] == "in_000000000001")
    assert paid["amount_paid_cents"] == 210000 and paid["status"] == "paid"
    assert paid["pdf_url"].endswith("/pdf") and paid["hosted_url"]
    assert fake.last("POST", "/v1/invoices/create_preview").form == {"subscription": SUB}


def test_get_reads_a_scheduled_cancel_from_cancel_at_alone(client, db, billed, fake, auth_header):
    """Flexible billing mode can schedule a cancel with cancel_at set and
    cancel_at_period_end false."""
    fake.subscriptions[SUB]["cancel_at"] = 1_900_000_500
    body = client.get(_url(billed), headers=auth_header()).json()
    assert body["cancel_scheduled"] is True
    assert body["cancel_at"] == datetime.fromtimestamp(1_900_000_500, UTC).isoformat()
    assert body["next_charge"] is None  # nothing renews


def test_get_names_the_code_and_its_points(client, db, billed, fake, auth_header):
    code = SalesCode(code="AB1CD2EF", code_points=10, rep="Daniel", created_by="Daniel")
    db.add(code)
    db.flush()
    db.get(SponsorBilling, billed.id).sales_code_id = code.id
    db.commit()
    fake.add_coupon("GOLD-AT-1850", amount_off=65000, products=fake.product_ids("gold"))
    fake.subscriptions[SUB]["discounts"] = [fake._attach_discount(SUB, "GOLD-AT-1850")]
    body = client.get(_url(billed), headers=auth_header()).json()
    assert body["code"] == "AB1C-D2EF"
    assert body["price_usd"] == 1850
    assert body["code_points"] == 10


def test_get_flags_a_legacy_price(client, db, billed, fake, auth_header):
    """Items on an archived price (not the tier's current lookup-key prices)."""
    fake.add_price(
        "gold_advertising_monthly_old",
        product="prod_goldadv",
        unit_amount=90000,
        price_id="price_old_gold_adv",
    )
    fake.subscriptions[SUB]["items"]["data"][0]["price"] = {"id": "price_old_gold_adv"}
    body = client.get(_url(billed), headers=auth_header()).json()
    assert body["legacy_price"] is True


def test_get_failing_since_and_the_cancel_date(client, db, billed, fake, auth_header, monkeypatch):
    monkeypatch.setattr(settings, "BILLING_GRACE_DAYS", 14)
    started = datetime(2026, 9, 1, tzinfo=UTC)
    db.get(SponsorBilling, billed.id).failing_since = started
    db.commit()
    body = client.get(_url(billed), headers=auth_header()).json()
    assert datetime.fromisoformat(body["failing_since"]) == started
    assert datetime.fromisoformat(body["cancels_on"]) == started + timedelta(days=14)


def test_get_send_invoice_clock_starts_at_the_overdue_due_date(
    client, db, billed, fake, auth_header
):
    fake.subscriptions[SUB]["collection_method"] = "send_invoice"
    due = int((datetime.now(UTC) - timedelta(days=3)).timestamp())
    fake.add_open_invoice(
        "in_000000000009", sub=SUB, amount=210000, due_date=due, collection_method="send_invoice"
    )
    body = client.get(_url(billed), headers=auth_header()).json()
    assert body["collection_method"] == "send_invoice"
    assert body["card"] is None
    assert datetime.fromisoformat(body["failing_since"]).timestamp() == due
    assert datetime.fromisoformat(body["cancels_on"]).timestamp() == due + 14 * 86400


def test_rep_quoted_row_with_one_match_is_resolved_and_stored(
    client, db, seeded_db, fake, auth_header
):
    """R13: no stored id → Search on metadata.sponsor_id; exactly one live
    match is stored in sponsor_billing, never on the sponsor row (R3)."""
    sponsor = db.get(Sponsor, seeded_db["sponsor"].id)
    sponsor.amount = 2100
    db.commit()
    before = sponsor.updated_at
    fake.add_subscription(
        "sub_000000000077",
        customer=CUS,
        tier="gold",
        collection_method="send_invoice",
        metadata={"sponsor_id": str(sponsor.id)},
    )
    body = client.get(_url(sponsor), headers=auth_header()).json()
    assert body["subscription_id"] == "sub_000000000077"
    assert body["needs_resolution"] is None
    db.expire_all()
    billing = db.get(SponsorBilling, sponsor.id)
    assert billing.stripe_subscription_id == "sub_000000000077"
    assert billing.channel == "quote"
    assert billing.collection_method == "send_invoice"
    assert db.get(Sponsor, sponsor.id).stripe_subscription_id is None
    assert db.get(Sponsor, sponsor.id).updated_at == before
    query = fake.last("GET", "/v1/subscriptions/search").params["query"]
    assert query == f"metadata['sponsor_id']:'{sponsor.id}' AND -status:'canceled'"


def test_two_matches_are_ambiguous_and_nothing_is_stored(client, db, seeded_db, fake, auth_header):
    sponsor = seeded_db["sponsor"]
    for sub in ("sub_000000000071", "sub_000000000072"):
        fake.add_subscription(sub, customer=CUS, metadata={"sponsor_id": str(sponsor.id)})
    body = client.get(_url(sponsor), headers=auth_header()).json()
    assert body["needs_resolution"] == "ambiguous_subscription"
    assert body["subscription_id"] is None and body["invoices"] == []
    assert db.get(SponsorBilling, sponsor.id) is None
    # …and an action on it says why it cannot act.
    resp = client.post(_url(sponsor, "retry-payment"), headers={**auth_header(), **KEY})
    assert resp.status_code == 409
    assert resp.json()["detail"] == "ambiguous_subscription"


def test_no_match_is_no_subscription(client, seeded_db, fake, auth_header):
    body = client.get(_url(seeded_db["sponsor"]), headers=auth_header()).json()
    assert body["needs_resolution"] == "no_subscription"


def test_every_route_404s_without_stripe(client, seeded_db, auth_header, monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", None)
    sponsor = seeded_db["sponsor"]
    h = auth_header()
    assert client.get(_url(sponsor), headers=h).status_code == 404
    for action, body in (
        ("cancel", {"when": "now"}),
        ("refund", {"invoice_id": "in_000000000001"}),
        ("discount", {"code_points": 1}),
        ("retry-payment", {}),
        ("card-link", {}),
    ):
        assert client.post(_url(sponsor, action), json=body, headers=h).status_code == 404


def test_unknown_sponsor_is_404(client, seeded_db, fake, auth_header):
    assert (
        client.get(f"/api/admin/sponsors/{uuid.uuid4()}/billing", headers=auth_header()).status_code
        == 404
    )
    assert client.get("/api/admin/sponsors/nope/billing", headers=auth_header()).status_code == 404


# ── the Idempotency-Key rule ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "action, body",
    [
        ("cancel", {"when": "period_end"}),
        ("refund", {"invoice_id": "in_000000000001"}),
        ("discount", {"code_points": 5}),
        ("retry-payment", {}),
    ],
)
def test_money_actions_require_an_idempotency_key(client, billed, fake, auth_header, action, body):
    resp = client.post(_url(billed, action), json=body, headers=auth_header())
    assert resp.status_code == 422
    assert resp.json()["detail"] == "idempotency_key_required"
    assert fake.posts() == []


# ── cancel ──────────────────────────────────────────────────────────────────


def test_cancel_at_period_end_then_resume(client, db, billed, fake, auth_header):
    h = {**auth_header(), **KEY}
    resp = client.post(_url(billed, "cancel"), json={"when": "period_end"}, headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json()["cancel_scheduled"] is True
    sent = fake.last("POST", f"/v1/subscriptions/{SUB}")
    assert sent.form == {"cancel_at_period_end": "true"}
    assert sent.headers["Idempotency-Key"] == KEY["Idempotency-Key"]

    # Flexible mode: a bare cancel_at survives the flag — resume clears it too.
    fake.subscriptions[SUB]["cancel_at_period_end"] = False
    fake.subscriptions[SUB]["cancel_at"] = 1_900_000_500
    resume_key = {"Idempotency-Key": "a8e0d7c1-0000-4000-8000-000000000002"}
    resp = client.post(
        _url(billed, "cancel"), json={"when": "resume"}, headers={**auth_header(), **resume_key}
    )
    assert resp.status_code == 200
    assert resp.json()["cancel_scheduled"] is False
    assert fake.last("POST", f"/v1/subscriptions/{SUB}").form == {"cancel_at": ""}
    actions = [a.action for a in db.query(BillingAudit).order_by(BillingAudit.created_at)]
    assert actions == ["cancel_period_end", "cancel_resumed"]
    assert db.get(Sponsor, billed.id).status == "Active"


def test_cancel_now_cancels_voids_expires_and_clears_the_cache(
    client, db, billed, fake, auth_header, monkeypatch
):
    cleared = []
    monkeypatch.setattr(category_cache, "clear", lambda: cleared.append(True))
    fake.add_open_invoice("in_000000000005", sub=SUB, amount=210000)
    resp = client.post(
        _url(billed, "cancel"), json={"when": "now"}, headers={**auth_header(), **KEY}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["subscription_status"] == "canceled"
    assert body["sponsor_status"] == "Expired"
    assert body["voided_invoices"] == 1
    assert fake.last("DELETE", f"/v1/subscriptions/{SUB}").params == {
        "invoice_now": "false",
        "prorate": "false",
    }
    assert fake.invoices["in_000000000005"]["status"] == "void"
    db.expire_all()
    assert db.get(Sponsor, billed.id).status == "Expired"
    assert cleared == [True]
    audit = db.query(BillingAudit).filter(BillingAudit.action == "cancel_now").one()
    assert audit.actor == "admin" and audit.sponsor_id == billed.id


def test_cancel_now_on_an_already_canceled_subscription_is_success(
    client, db, billed, fake, auth_header
):
    fake.subscriptions[SUB]["status"] = "canceled"
    resp = client.post(
        _url(billed, "cancel"), json={"when": "now"}, headers={**auth_header(), **KEY}
    )
    assert resp.status_code == 200
    assert db.get(Sponsor, billed.id).status == "Expired"


def test_cancel_rejects_an_unknown_when(client, billed, fake, auth_header):
    resp = client.post(
        _url(billed, "cancel"), json={"when": "later"}, headers={**auth_header(), **KEY}
    )
    assert resp.status_code == 422


# ── refund ──────────────────────────────────────────────────────────────────


def _paid(fake, invoice="in_000000000001", pi="pi_000000000001", amount=210000, sub=SUB):
    fake.add_paid_invoice(invoice, sub=sub, pi=pi, amount=amount)


def test_full_refund_mirrors_and_audits(client, db, billed, fake, auth_header):
    _paid(fake)
    resp = client.post(
        _url(billed, "refund"),
        json={"invoice_id": "in_000000000001"},
        headers={**auth_header(), **KEY},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["amount_cents"] == 210000
    assert body["invoice"]["status"] == "refunded"
    sent = fake.last("POST", "/v1/refunds")
    assert sent.form == {"payment_intent": "pi_000000000001"}  # no amount = the rest
    assert fake.last("GET", "/v1/invoice_payments").params == {
        "invoice": "in_000000000001",
        "status": "paid",
    }
    row = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_000000000001").one()
    assert row.amount_refunded_cents == 210000
    assert row.status == "refunded"
    assert row.sponsor_id == billed.id
    assert row.stripe_payment_intent_id == "pi_000000000001"
    audit = db.query(BillingAudit).filter(BillingAudit.action == "refund").one()
    assert audit.amount_cents == 210000


def test_partial_refunds_add_up_and_the_remainder_is_enforced(
    client, db, billed, fake, auth_header
):
    _paid(fake)
    h = auth_header()
    k1 = {"Idempotency-Key": "partial-refund-key-0001"}
    r1 = client.post(
        _url(billed, "refund"),
        json={"invoice_id": "in_000000000001", "amount_cents": 50000},
        headers={**h, **k1},
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["invoice"]["status"] == "partially_refunded"
    assert fake.last("POST", "/v1/refunds").form["amount"] == "50000"

    too_much = {"Idempotency-Key": "partial-refund-key-0002"}
    r2 = client.post(
        _url(billed, "refund"),
        json={"invoice_id": "in_000000000001", "amount_cents": 170000},
        headers={**h, **too_much},
    )
    assert r2.status_code == 422
    assert "$1,600.00" in r2.json()["detail"]
    assert len(fake.refunds) == 1

    k3 = {"Idempotency-Key": "partial-refund-key-0003"}
    r3 = client.post(
        _url(billed, "refund"),
        json={"invoice_id": "in_000000000001", "amount_cents": 160000},
        headers={**h, **k3},
    )
    assert r3.status_code == 200
    row = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_000000000001").one()
    db.refresh(row)
    assert row.amount_refunded_cents == 210000 and row.status == "refunded"


def test_refund_idempotency_key_forwarded_and_reused(client, db, billed, fake, auth_header):
    """Review Focus 4: a rep clicks Refund twice / the network retries. The
    route forwards the dialog's key verbatim; the second POST reaches Stripe
    under the SAME key and is answered from Stripe's record — ONE refund, one
    mirror update, one audit row."""
    _paid(fake)
    h = {**auth_header(), **KEY}
    body = {"invoice_id": "in_000000000001", "amount_cents": 50000}
    first = client.post(_url(billed, "refund"), json=body, headers=h)
    second = client.post(_url(billed, "refund"), json=body, headers=h)
    assert first.status_code == 200 and second.status_code == 200, second.text
    assert first.json()["refund_id"] == second.json()["refund_id"]

    refund_posts = fake.calls("POST", "/v1/refunds")
    assert len(refund_posts) == 2
    assert {r.headers["Idempotency-Key"] for r in refund_posts} == {KEY["Idempotency-Key"]}
    assert fake.replayed == [KEY["Idempotency-Key"]]
    assert len(fake.refunds) == 1  # Stripe acted once
    row = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_000000000001").one()
    assert row.amount_refunded_cents == 50000
    assert db.query(BillingAudit).filter(BillingAudit.action == "refund").count() == 1


def test_refund_of_another_subscriptions_invoice_is_404(client, db, billed, fake, auth_header):
    fake.add_subscription("sub_000000000099", customer="cus_000000000099")
    _paid(fake, invoice="in_000000000099", pi="pi_000000000099", sub="sub_000000000099")
    resp = client.post(
        _url(billed, "refund"),
        json={"invoice_id": "in_000000000099"},
        headers={**auth_header(), **KEY},
    )
    assert resp.status_code == 404
    assert fake.calls("POST", "/v1/refunds") == []


def test_refund_of_an_unknown_or_malformed_invoice(client, billed, fake, auth_header):
    h = {**auth_header(), **KEY}
    assert (
        client.post(
            _url(billed, "refund"), json={"invoice_id": "in_000000000404"}, headers=h
        ).status_code
        == 404
    )
    assert (
        client.post(_url(billed, "refund"), json={"invoice_id": "in_../x"}, headers=h).status_code
        == 422
    )


def test_refund_of_an_already_refunded_charge_is_success(client, db, billed, fake, auth_header):
    fake.add_paid_invoice(
        "in_000000000001", sub=SUB, pi="pi_000000000001", amount=210000, refunded=True
    )
    resp = client.post(
        _url(billed, "refund"),
        json={"invoice_id": "in_000000000001"},
        headers={**auth_header(), **KEY},
    )
    assert resp.status_code == 200
    assert resp.json()["already_refunded"] is True
    assert resp.json()["invoice"]["status"] == "refunded"


def test_refund_of_a_non_payment_intent_payment_is_409(client, billed, fake, auth_header):
    fake.add_paid_invoice(
        "in_000000000001", sub=SUB, pi="ch_000000000001", amount=210000, payment_type="charge"
    )
    resp = client.post(
        _url(billed, "refund"),
        json={"invoice_id": "in_000000000001"},
        headers={**auth_header(), **KEY},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "unsupported_payment"


# ── discount ────────────────────────────────────────────────────────────────


def test_discount_moves_the_subscription_to_the_rules_price(client, db, billed, fake, auth_header):
    resp = client.post(
        _url(billed, "discount"), json={"code_points": 10}, headers={**auth_header(), **KEY}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "price_usd": 1850,
        "code_points": 10,
        "coupon_id": "GOLD-AT-1850",
        "applies_from": "next_invoice",
    }
    coupon = fake.last("POST", "/v1/coupons").form
    assert coupon["id"] == "GOLD-AT-1850" and coupon["amount_off"] == "65000"
    assert coupon["name"] == "Gold Founder's Deal — $1,850/mo"
    sent = fake.last("POST", f"/v1/subscriptions/{SUB}")
    assert sent.form == {"discounts[0][coupon]": "GOLD-AT-1850"}
    assert sent.headers["Idempotency-Key"] == KEY["Idempotency-Key"]
    # verified by a re-read with the discounts expanded
    assert fake.last("GET", f"/v1/subscriptions/{SUB}").params == {"expand[]": ["discounts"]}
    db.expire_all()
    assert db.get(SponsorBilling, billed.id).price_usd == 1850
    audit = db.query(BillingAudit).filter(BillingAudit.action == "discount_changed").one()
    assert audit.amount_cents == 185000


def test_zero_points_is_the_founders_deal_not_list(client, db, billed, fake, auth_header):
    fake.subscriptions[SUB]["discounts"] = []
    resp = client.post(
        _url(billed, "discount"), json={"code_points": 0}, headers={**auth_header(), **KEY}
    )
    assert resp.status_code == 200
    assert resp.json()["coupon_id"] == "GOLD-AT-2100"
    assert fake.last("POST", f"/v1/subscriptions/{SUB}").form == {
        "discounts[0][coupon]": "GOLD-AT-2100"
    }


@pytest.mark.parametrize("pts", [-1, 16])
def test_discount_points_outside_the_rule(client, billed, fake, auth_header, pts):
    resp = client.post(
        _url(billed, "discount"), json={"code_points": pts}, headers={**auth_header(), **KEY}
    )
    assert resp.status_code == 422
    assert fake.posts() == []


def test_discount_on_a_legacy_price_is_409(client, db, billed, fake, auth_header):
    fake.subscriptions[SUB]["items"]["data"][1]["price"] = {"id": "price_archived_plat"}
    resp = client.post(
        _url(billed, "discount"), json={"code_points": 5}, headers={**auth_header(), **KEY}
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "legacy_price"
    assert fake.calls("POST", f"/v1/subscriptions/{SUB}") == []


def test_a_discount_stripe_did_not_apply_is_a_502(client, db, billed, fake, auth_header):
    fake.update_ignores_discounts = True
    resp = client.post(
        _url(billed, "discount"), json={"code_points": 10}, headers={**auth_header(), **KEY}
    )
    assert resp.status_code == 502
    db.expire_all()
    assert db.get(SponsorBilling, billed.id).price_usd == 2100
    assert db.query(BillingAudit).filter(BillingAudit.action == "discount_changed").count() == 0


# ── retry payment ───────────────────────────────────────────────────────────


def test_retry_pays_the_oldest_open_invoice(client, db, billed, fake, auth_header):
    fake.add_open_invoice("in_000000000011", sub=SUB, amount=210000, created=1_800_000_100)
    fake.add_open_invoice("in_000000000010", sub=SUB, amount=210000, created=1_800_000_000)
    resp = client.post(_url(billed, "retry-payment"), headers={**auth_header(), **KEY})
    assert resp.status_code == 200, resp.text
    assert resp.json()["invoice_id"] == "in_000000000010"
    assert resp.json()["status"] == "paid"
    sent = fake.last("POST", "/v1/invoices/in_000000000010/pay")
    assert sent.headers["Idempotency-Key"] == KEY["Idempotency-Key"]
    assert fake.invoices["in_000000000011"]["status"] == "open"
    row = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_000000000010").one()
    assert row.status == "paid" and row.sponsor_id == billed.id
    assert db.query(BillingAudit).filter(BillingAudit.action == "payment_retried").count() == 1


def test_retry_with_nothing_open_is_409(client, billed, fake, auth_header):
    resp = client.post(_url(billed, "retry-payment"), headers={**auth_header(), **KEY})
    assert resp.status_code == 409


def test_retry_decline_is_a_string_422(client, billed, fake, auth_header):
    fake.add_open_invoice("in_000000000010", sub=SUB, amount=210000)
    fake.pay_fails = True
    resp = client.post(_url(billed, "retry-payment"), headers={**auth_header(), **KEY})
    assert resp.status_code == 422
    assert "declined" in resp.json()["detail"]


# ── walls ───────────────────────────────────────────────────────────────────


def test_a_viewer_cannot_act(client, db, billed, fake, viewer_header):
    viewer = {**viewer_header(), **KEY}
    for action, body in (
        ("cancel", {"when": "now"}),
        ("refund", {"invoice_id": "in_000000000001"}),
        ("discount", {"code_points": 1}),
        ("retry-payment", {}),
        ("card-link", {}),
    ):
        resp = client.post(_url(billed, action), json=body, headers=viewer)
        assert resp.status_code == 403, action
        assert resp.json()["detail"] == "read_only"
    assert fake.tape == []
