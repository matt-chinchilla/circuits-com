"""The webhook's Gold/Platinum sales paths (spec §8, T5).

* Mirroring runs BEFORE the status gates: every invoice event with a
  subscription upserts ``sponsor_payments`` (keyed by invoice), resolves the
  sponsor lazily, keeps ``sponsor_billing`` and ``failing_since`` true — and
  none of it writes the sponsor row, so the stale-event gate stays meaningful.
* ``checkout.session.completed`` carrying ``intent_id`` activates the sale from
  the intent; every paid-but-refused outcome becomes a ``conflict`` intent the
  follow-ups refund.
* The legacy Silver path keeps working, with a missing total now refused.

Called through ``apply_stripe_event`` directly, plus signed end-to-end passes
through the route for the follow-up scheduling.
"""

import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.exc import InternalError

from app.config import settings
from app.models import Category, Sponsor, Supplier
from app.models.calendar_event import as_utc
from app.models.sales import (
    BillingAudit,
    CheckoutIntent,
    SalesCode,
    SponsorBilling,
    SponsorPayment,
)
from app.routes import stripe_webhooks as webhook_route
from app.services import category_cache
from app.services.stripe_webhook import apply_stripe_event, followup_for

SECRET = "whsec_sales_test"


def _later(seconds: int = 60) -> int:
    return int(time.time()) + seconds


@pytest.fixture
def cache_spy(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(category_cache, "clear", lambda: calls.append(1))
    return calls


@pytest.fixture
def gold_child(db, seeded_db):
    """A child category with NO occupant (seeded_db's child already holds a
    NULL-status Gold, which R16 counts as taken)."""
    cat = Category(
        id=uuid.uuid4(),
        name="Oscillators",
        slug="oscillators-sales",
        icon="wave-sine",
        parent_id=seeded_db["parent"].id,
    )
    db.add(cat)
    db.commit()
    return cat


def _intent(
    db,
    *,
    category,
    tier="gold",
    price=2100,
    status="open",
    code: SalesCode | None = None,
    supplier_id=None,
    channel="self_serve",
    sold_by="Daniel",
    session_id=None,
    keyword=None,
) -> CheckoutIntent:
    list_usd = {"silver": 250, "gold": 2500, "platinum": 10000}[tier]
    founder = {"silver": 210, "gold": 2100, "platinum": 8500}[tier]
    row = CheckoutIntent(
        tier=tier,
        category_id=category.id if category is not None else None,
        keyword=keyword,
        sales_code_id=code.id if code else None,
        supplier_id=supplier_id,
        list_usd=list_usd,
        founder_usd=founder,
        price_usd=price,
        channel=channel,
        sold_by=sold_by,
        company_name="Acme Oscillators",
        email="ap@acme.example",
        website="https://acme.example",
        status=status,
        stripe_session_id=session_id,
        expires_at=datetime.now(UTC) + timedelta(minutes=45),
    )
    db.add(row)
    db.commit()
    return row


def _completed(
    intent: CheckoutIntent,
    *,
    sub="sub_A",
    amount: int | None = -1,
    session="cs_test_sales0001",
    payment_status="paid",
    customer="cus_buyer0001",
) -> dict:
    obj = {
        "id": session,
        "object": "checkout.session",
        "subscription": sub,
        "customer": customer,
        "payment_status": payment_status,
        "customer_details": {"email": "someone-else@example.com"},
        "metadata": {
            "managed_by": "circuits-com",
            "intent_id": str(intent.id),
            "tier": intent.tier,
        },
    }
    if amount == -1:
        obj["amount_total"] = intent.price_usd * 100
    elif amount is not None:
        obj["amount_total"] = amount
    return {"type": "checkout.session.completed", "created": _later(), "data": {"object": obj}}


def _invoice(
    event_type="invoice.paid",
    *,
    invoice="in_first0001",
    sub="sub_A",
    amount=210000,
    metadata=None,
    created=None,
    paid=True,
) -> dict:
    obj = {
        "id": invoice,
        "object": "invoice",
        "customer": "cus_buyer0001",
        "collection_method": "charge_automatically",
        "status": "paid" if paid else "open",
        "attempted": True,
        "amount_due": amount,
        "amount_paid": amount if paid else 0,
        "created": 1_800_000_000,
        "hosted_invoice_url": f"https://invoice.stripe.com/i/{invoice}",
        "status_transitions": {"paid_at": 1_800_000_060 if paid else None},
        "parent": {
            "type": "subscription_details",
            "subscription_details": {"subscription": sub, "metadata": metadata or {}},
        },
    }
    return {
        "type": event_type,
        "created": created if created is not None else _later(),
        "data": {"object": obj},
    }


def _sub_deleted(sub="sub_A", metadata=None) -> dict:
    return {
        "type": "customer.subscription.deleted",
        "created": _later(),
        "data": {"object": {"id": sub, "object": "subscription", "metadata": metadata or {}}},
    }


def _code(db, *, points=10, rep="anthony", tier="gold", supplier_id=None) -> SalesCode:
    row = SalesCode(
        code=f"TEST{uuid.uuid4().hex[:4].upper()}",
        code_points=points,
        tier=tier,
        supplier_id=supplier_id,
        email_lock="ap@acme.example" if supplier_id else None,
        rep=rep,
        created_by=rep,
    )
    db.add(row)
    db.commit()
    return row


def _audits(db, action):
    return db.query(BillingAudit).filter(BillingAudit.action == action).all()


# ── mirror before gates ─────────────────────────────────────────────────────


def test_first_invoice_paid_before_completion_is_attached(db, gold_child, cache_spy):
    """Review focus #2: Stripe pays the first invoice inside the session, so
    its invoice.paid can beat checkout.session.completed. The payment must be
    recorded anyway and handed to the sponsor at activation."""
    intent = _intent(db, category=gold_child)
    early = _invoice(metadata={"intent_id": str(intent.id)})
    assert apply_stripe_event(db, early) == "no_sponsor_id"
    row = db.query(SponsorPayment).one()
    assert (row.stripe_invoice_id, row.sponsor_id, row.status) == ("in_first0001", None, "paid")

    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    db.refresh(row)
    assert row.sponsor_id == sponsor.id


def test_renewal_on_an_active_sponsor_mirrors_and_clears_failing(db, gold_child):
    intent = _intent(db, category=gold_child)
    apply_stripe_event(db, _completed(intent))
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    billing = db.get(SponsorBilling, sponsor.id)
    billing.failing_since = datetime.now(UTC) - timedelta(days=3)
    db.commit()

    outcome = apply_stripe_event(db, _invoice(invoice="in_renew0001"))
    assert outcome == "unchanged"
    payment = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_renew0001").one()
    assert payment.sponsor_id == sponsor.id
    db.refresh(billing)
    assert billing.failing_since is None


def test_payment_failed_stamps_failing_since_once(db, gold_child):
    intent = _intent(db, category=gold_child)
    apply_stripe_event(db, _completed(intent))
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()

    first = _invoice("invoice.payment_failed", invoice="in_fail0001", paid=False)
    first["created"] = 1_900_000_000
    assert apply_stripe_event(db, first) == "logged_payment_failed"
    billing = db.get(SponsorBilling, sponsor.id)
    stamped = as_utc(billing.failing_since)
    assert stamped == datetime.fromtimestamp(1_900_000_000, UTC)

    second = _invoice("invoice.payment_failed", invoice="in_fail0001", paid=False)
    second["created"] = 1_900_500_000
    assert apply_stripe_event(db, second) == "logged_payment_failed"
    db.refresh(billing)
    assert as_utc(billing.failing_since) == stamped
    db.refresh(sponsor)
    assert sponsor.status == "Active"
    assert db.query(SponsorPayment).filter_by(stripe_invoice_id="in_fail0001").one().status == (
        "failed"
    )


def test_mirroring_never_writes_the_sponsor_row(db, gold_child):
    """R3: billing state lives beside the sponsor, so a mirrored renewal must
    not move updated_at (the stale-event gate reads it)."""
    intent = _intent(db, category=gold_child)
    apply_stripe_event(db, _completed(intent))
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    before = sponsor.updated_at
    apply_stripe_event(db, _invoice(invoice="in_renew0002"))
    db.refresh(sponsor)
    assert sponsor.updated_at == before


def test_a_rep_row_gets_its_billing_row_captured(db, seeded_db):
    """F4/F9: a rep-quoted row (Active, no stored id) must get a billing row
    from its first invoice event, or dunning can never see it."""
    rep_row = Sponsor(
        supplier_id=seeded_db["supplier1"].id,
        keyword="rep-captured",
        tier="Gold",
        status="Active",
        amount=Decimal("1850"),
    )
    db.add(rep_row)
    db.commit()
    event = _invoice(sub="sub_rep0001", metadata={"sponsor_id": str(rep_row.id)})
    event["data"]["object"]["collection_method"] = "send_invoice"
    assert apply_stripe_event(db, event) == "unchanged"
    billing = db.get(SponsorBilling, rep_row.id)
    assert billing.stripe_subscription_id == "sub_rep0001"
    assert billing.collection_method == "send_invoice"
    assert (billing.channel, billing.list_usd, billing.price_usd) == ("quote", 2500, 1850)
    payment = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_first0001").one()
    assert payment.sponsor_id == rep_row.id


# ── the new activation path ─────────────────────────────────────────────────


def test_self_serve_gold_activates(db, gold_child, cache_spy):
    intent = _intent(db, category=gold_child)
    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"

    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    assert (sponsor.status, sponsor.tier) == ("Active", "Gold")
    assert Decimal(str(sponsor.amount)) == Decimal("2100")
    assert sponsor.sold_by == settings.SELF_SERVE_ONBOARDING_REP
    assert sponsor.category_id == gold_child.id
    supplier = db.get(Supplier, sponsor.supplier_id)
    assert (supplier.name, supplier.email) == ("Acme Oscillators", "ap@acme.example")

    billing = db.get(SponsorBilling, sponsor.id)
    assert billing.channel == "self_serve"
    assert (billing.list_usd, billing.founder_usd, billing.price_usd) == (2500, 2100, 2100)
    assert billing.stripe_customer_id == "cus_buyer0001"
    assert billing.stripe_subscription_id == "sub_A"
    assert billing.collection_method == "charge_automatically"

    db.refresh(intent)
    assert intent.status == "completed"
    assert intent.stripe_session_id == "cs_test_sales0001"
    audit = _audits(db, "sale_activated")
    assert len(audit) == 1 and audit[0].actor == "system:webhook"
    assert audit[0].sponsor_id == sponsor.id and audit[0].intent_id == intent.id
    assert cache_spy, "a webhook-created sponsor must clear the category cache"


def test_code_sale_credits_the_rep_and_counts_the_use(db, gold_child):
    code = _code(db, points=10, rep="anthony")
    intent = _intent(
        db, category=gold_child, price=1850, code=code, channel="rep_code", sold_by="anthony"
    )
    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    assert sponsor.sold_by == "anthony"
    assert Decimal(str(sponsor.amount)) == Decimal("1850")
    billing = db.get(SponsorBilling, sponsor.id)
    assert (billing.channel, billing.sales_code_id, billing.price_usd) == (
        "rep_code",
        code.id,
        1850,
    )
    db.refresh(code)
    assert code.uses == 1


def test_platinum_on_a_top_level_category_activates(db, seeded_db):
    intent = _intent(db, category=seeded_db["parent"], tier="platinum", price=8500)
    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    assert sponsor.tier == "Platinum"


def test_followup_for_names_the_sponsor_after_activation(db, gold_child):
    intent = _intent(db, category=gold_child)
    event = _completed(intent)
    outcome = apply_stripe_event(db, event)
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    assert followup_for(event, outcome) == ("post_activation", str(sponsor.id))
    assert followup_for(event, "unchanged") is None


@pytest.mark.parametrize("amount", [None, 250000, 0])
def test_amount_missing_or_wrong_queues_a_conflict(db, gold_child, amount):
    intent = _intent(db, category=gold_child)
    event = _completed(intent, amount=amount)
    outcome = apply_stripe_event(db, event)
    assert outcome == "checkout_conflict_refunding"
    db.refresh(intent)
    assert (intent.status, intent.conflict_reason) == ("conflict", "amount_mismatch")
    assert intent.resolved_at is None
    assert db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").count() == 0
    assert len(_audits(db, "sale_conflict")) == 1
    assert followup_for(event, outcome) == ("conflict", str(intent.id))


@pytest.mark.parametrize("status", ["Active", None, "Paused"])
def test_an_occupied_slot_queues_slot_taken(db, gold_child, seeded_db, status):
    """R16: Active, NULL and Paused all occupy — a paused sponsor still pays."""
    db.add(
        Sponsor(
            supplier_id=seeded_db["supplier1"].id,
            category_id=gold_child.id,
            tier="gold",
            status=status,
        )
    )
    db.commit()
    intent = _intent(db, category=gold_child)
    assert apply_stripe_event(db, _completed(intent)) == "checkout_conflict_refunding"
    db.refresh(intent)
    assert intent.conflict_reason == "slot_taken"


def test_an_expired_occupant_does_not_take_the_slot(db, gold_child, seeded_db):
    db.add(
        Sponsor(
            supplier_id=seeded_db["supplier1"].id,
            category_id=gold_child.id,
            tier="Gold",
            status="Expired",
        )
    )
    db.commit()
    intent = _intent(db, category=gold_child)
    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"


def test_a_deleted_category_queues_category_missing(db, gold_child):
    intent = _intent(db, category=gold_child)
    db.delete(gold_child)
    db.commit()
    assert apply_stripe_event(db, _completed(intent)) == "checkout_conflict_refunding"
    db.refresh(intent)
    assert intent.conflict_reason == "category_missing"


def test_a_tier_matrix_violation_queues_matrix(db, seeded_db):
    """Gold on a TOP-LEVEL category is illegal; pre-checked so the Postgres
    trigger never fires."""
    intent = _intent(db, category=seeded_db["parent"], tier="gold")
    assert apply_stripe_event(db, _completed(intent)) == "checkout_conflict_refunding"
    db.refresh(intent)
    assert intent.conflict_reason == "matrix"


def test_a_trigger_error_at_commit_rolls_back_and_still_acks(client, db, gold_child, monkeypatch):
    """The tier-matrix trigger raises InternalError, not IntegrityError. It
    must be caught — through the real route, a 500 means Stripe retry-storms."""
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", SECRET)
    monkeypatch.setattr(webhook_route, "run_followup", _noop_followup)
    intent = _intent(db, category=gold_child)
    real_commit = db.commit
    raised: list[int] = []

    def commit_once_fails():
        if not raised:
            raised.append(1)
            raise InternalError("INSERT INTO sponsors", {}, Exception("tier placement"))
        return real_commit()

    monkeypatch.setattr(db, "commit", commit_once_fails)
    resp = _signed(client, _completed(intent))
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "checkout_conflict_refunding"
    db.refresh(intent)
    assert (intent.status, intent.conflict_reason) == ("conflict", "matrix")
    assert db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").count() == 0


def test_redelivery_of_a_completed_intent_is_a_duplicate(db, gold_child):
    intent = _intent(db, category=gold_child)
    event = _completed(intent)
    assert apply_stripe_event(db, event) == "checkout_activated"
    assert apply_stripe_event(db, event) == "duplicate_checkout"
    assert db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").count() == 1


def test_redelivery_of_a_conflict_intent_is_not_requeued(db, gold_child):
    intent = _intent(db, category=gold_child)
    event = _completed(intent, amount=1)
    assert apply_stripe_event(db, event) == "checkout_conflict_refunding"
    assert apply_stripe_event(db, event) == "conflict_already_queued"
    assert len(_audits(db, "sale_conflict")) == 1


def test_an_expired_hold_still_activates_when_the_slot_is_free(db, gold_child):
    """A deploy's 502 window can push Stripe's retry past the hold (LU-F5c)."""
    intent = _intent(db, category=gold_child, status="expired")
    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"


def test_a_session_that_is_not_the_intents_is_refused(db, gold_child):
    intent = _intent(db, category=gold_child, session_id="cs_test_theoriginal1")
    outcome = apply_stripe_event(db, _completed(intent, session="cs_test_someoneelse"))
    assert outcome == "intent_session_mismatch"
    db.refresh(intent)
    assert intent.status == "open"


def test_an_unpaid_completion_leaves_the_hold_alone(db, gold_child):
    intent = _intent(db, category=gold_child)
    outcome = apply_stripe_event(db, _completed(intent, payment_status="unpaid"))
    assert outcome == "checkout_unpaid"
    db.refresh(intent)
    assert intent.status == "open"


def test_an_unknown_intent_acks(db, gold_child):
    intent = _intent(db, category=gold_child)
    event = _completed(intent)
    event["data"]["object"]["metadata"]["intent_id"] = str(uuid.uuid4())
    assert apply_stripe_event(db, event) == "unknown_intent"
    event["data"]["object"]["metadata"]["intent_id"] = "not-a-uuid"
    assert apply_stripe_event(db, event) == "bad_checkout_metadata"


# ── R13 foreign subscriptions ──────────────────────────────────────────────


def test_a_second_subscription_naming_the_sponsor_is_foreign(db, gold_child):
    intent = _intent(db, category=gold_child)
    apply_stripe_event(db, _completed(intent))
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    sponsor.status = "Expired"
    db.commit()

    foreign = _invoice(
        invoice="in_foreign001",
        sub="sub_B",
        metadata={"sponsor_id": str(sponsor.id)},
        created=_later(600),
    )
    assert apply_stripe_event(db, foreign) == "foreign_subscription"
    db.refresh(sponsor)
    assert sponsor.status == "Expired"
    payment = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_foreign001").one()
    assert payment.sponsor_id is None

    deleted = _sub_deleted(sub="sub_B", metadata={"sponsor_id": str(sponsor.id)})
    sponsor.status = "Active"
    db.commit()
    deleted["created"] = _later(900)
    assert apply_stripe_event(db, deleted) == "foreign_subscription"
    db.refresh(sponsor)
    assert sponsor.status == "Active"


# ── R7 bound codes ─────────────────────────────────────────────────────────


def test_a_bound_code_reuses_the_companys_expired_row(db, gold_child, seeded_db):
    company = seeded_db["supplier1"]
    before = (company.name, company.website, company.email)
    old = Sponsor(
        supplier_id=company.id,
        category_id=gold_child.id,
        tier="Silver",
        status="Expired",
        amount=Decimal("250"),
        stripe_subscription_id="sub_old0001",
    )
    db.add(old)
    db.commit()
    code = _code(db, points=5, supplier_id=company.id)
    intent = _intent(
        db,
        category=gold_child,
        price=1975,
        code=code,
        supplier_id=company.id,
        channel="rep_code",
        sold_by="anthony",
    )
    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"
    db.refresh(old)
    assert (old.tier, old.status, old.stripe_subscription_id) == ("Gold", "Active", "sub_A")
    assert Decimal(str(old.amount)) == Decimal("1975")
    on_slot = db.query(Sponsor).filter(
        Sponsor.supplier_id == company.id, Sponsor.category_id == gold_child.id
    )
    assert on_slot.count() == 1
    assert db.query(Supplier).filter(Supplier.name == "Acme Oscillators").count() == 0
    db.refresh(company)
    assert (company.name, company.website, company.email) == before

    # The old subscription can no longer act on the reused row.
    stale = _sub_deleted(sub="sub_old0001")
    assert apply_stripe_event(db, stale) == "no_sponsor_id"
    db.refresh(old)
    assert old.status == "Active"


def test_a_bound_company_already_on_the_category_is_a_conflict(db, gold_child, seeded_db):
    company = seeded_db["supplier1"]
    db.add(
        Sponsor(
            supplier_id=company.id,
            category_id=gold_child.id,
            tier="Silver",
            status="Active",
        )
    )
    db.commit()
    code = _code(db, supplier_id=company.id)
    intent = _intent(db, category=gold_child, price=1850, code=code, supplier_id=company.id)
    assert apply_stripe_event(db, _completed(intent)) == "checkout_conflict_refunding"
    db.refresh(intent)
    assert intent.conflict_reason == "already_sponsor"


def test_a_bound_code_without_an_old_row_attaches_to_the_company(db, gold_child, seeded_db):
    company = seeded_db["supplier1"]
    code = _code(db, supplier_id=company.id)
    intent = _intent(db, category=gold_child, price=1850, code=code, supplier_id=company.id)
    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    assert sponsor.supplier_id == company.id


# ── Silver on the intent path ──────────────────────────────────────────────


def test_a_silver_intent_activates_at_the_founders_deal(db, seeded_db):
    intent = _intent(db, category=seeded_db["child"], tier="silver", price=210)
    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    assert sponsor.tier == "Silver"
    assert Decimal(str(sponsor.amount)) == Decimal("210")


def test_a_silver_keyword_intent_activates(db, seeded_db):
    intent = _intent(db, category=None, keyword="crystals", tier="silver", price=210)
    assert apply_stripe_event(db, _completed(intent)) == "checkout_activated"
    sponsor = db.query(Sponsor).filter(Sponsor.keyword == "crystals").one()
    assert sponsor.category_id is None


# ── the legacy Silver path ─────────────────────────────────────────────────


def _legacy(amount: int | None = 25000, sub="sub_legacy01") -> dict:
    obj = {
        "id": "cs_test_legacy0001",
        "subscription": sub,
        "customer": "cus_legacy0001",
        "payment_status": "paid",
        "customer_details": {"email": "ap@legacy.example"},
        "metadata": {
            "managed_by": "circuits-com",
            "self_serve": "silver",
            "company_name": "Legacy Co",
            "keyword": "legacy-kw",
        },
    }
    if amount is not None:
        obj["amount_total"] = amount
    return {"type": "checkout.session.completed", "created": _later(), "data": {"object": obj}}


def test_legacy_silver_still_activates_and_gets_billing(db, seeded_db, cache_spy):
    event = _legacy()
    outcome = apply_stripe_event(db, event)
    assert outcome == "checkout_activated"
    sponsor = db.query(Sponsor).filter(Sponsor.keyword == "legacy-kw").one()
    assert Decimal(str(sponsor.amount)) == Decimal("250")
    billing = db.get(SponsorBilling, sponsor.id)
    assert (billing.stripe_subscription_id, billing.price_usd) == ("sub_legacy01", 250)
    assert cache_spy
    assert followup_for(event, outcome) == ("post_activation", str(sponsor.id))


def test_legacy_silver_missing_total_is_refused(db, seeded_db):
    assert apply_stripe_event(db, _legacy(amount=None)) == "amount_mismatch"
    assert db.query(Sponsor).filter(Sponsor.keyword == "legacy-kw").count() == 0


# ── cancellation ───────────────────────────────────────────────────────────


def test_subscription_deleted_expires_clears_cache_and_queues_the_void(db, gold_child, cache_spy):
    intent = _intent(db, category=gold_child)
    apply_stripe_event(db, _completed(intent))
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    cache_spy.clear()

    event = _sub_deleted()
    event["created"] = _later(600)
    outcome = apply_stripe_event(db, event)
    assert outcome == "status_expired"
    db.refresh(sponsor)
    assert sponsor.status == "Expired"
    assert db.get(SponsorBilling, sponsor.id).void_pending is True
    assert cache_spy
    assert followup_for(event, outcome) == ("void", str(sponsor.id))


# ── the route schedules the follow-ups ─────────────────────────────────────


async def _noop_followup(kind: str, ref: str) -> None:
    return None


def _signed(client, event: dict):
    payload = json.dumps(event).encode()
    t = int(time.time())
    mac = hmac.new(SECRET.encode(), f"{t}.".encode() + payload, hashlib.sha256).hexdigest()
    return client.post(
        "/api/stripe/webhook", content=payload, headers={"stripe-signature": f"t={t},v1={mac}"}
    )


def test_route_schedules_post_activation(client, db, gold_child, monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", SECRET)
    scheduled: list[tuple[str, str]] = []

    async def spy(kind: str, ref: str) -> None:
        scheduled.append((kind, ref))

    monkeypatch.setattr(webhook_route, "run_followup", spy)
    intent = _intent(db, category=gold_child)
    resp = _signed(client, _completed(intent))
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "checkout_activated"
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == "sub_A").one()
    assert scheduled == [("post_activation", str(sponsor.id))]


def test_route_schedules_nothing_for_plain_outcomes(client, db, seeded_db, monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", SECRET)
    scheduled: list[tuple[str, str]] = []

    async def spy(kind: str, ref: str) -> None:
        scheduled.append((kind, ref))

    monkeypatch.setattr(webhook_route, "run_followup", spy)
    resp = _signed(client, {"type": "charge.refunded", "data": {"object": {}}})
    assert resp.json()["outcome"] == "ignored_event_type"
    assert scheduled == []
