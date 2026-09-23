"""The Stripe follow-ups the webhook schedules and the sweep retries (T6).

* ``resolve_conflict`` — a paid checkout the sale refused: cancel the
  subscription FIRST (so it can never bill again), then refund EVERY paid
  invoice, then mark the intent resolved. Any failure leaves it unresolved for
  the next run; "already canceled" / "already refunded" count as done.
* ``post_activation`` — R14 card move, the supplier stamped on the Stripe
  customer, the first invoice mirrored; recorded once, then a no-op.
* ``void_pending`` — a deleted subscription's open invoices voided.

Driven through the shared FakeStripe, so what is asserted is what Stripe
received.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.config import settings
from app.models import Sponsor
from app.models.sales import BillingAudit, CheckoutIntent, SponsorBilling, SponsorPayment
from app.services import billing_followups as bf
from app.services import stripe_billing, stripe_quotes
from app.services.stripe_quotes import StripeApiError
from tests.conftest import TestingSessionLocal
from tests.fake_stripe import FakeStripe

SUB = "sub_loser000001"
CS = "cs_test_conflict000001"


@pytest.fixture
def fake():
    return FakeStripe()


def run(fake: FakeStripe, factory):
    async def go():
        async with fake.client() as client:
            return await factory(client)

    return asyncio.run(go())


def _conflict(db, *, session=CS) -> CheckoutIntent:
    row = CheckoutIntent(
        tier="gold",
        category_id=uuid.uuid4(),
        list_usd=2500,
        founder_usd=2100,
        price_usd=2100,
        channel="self_serve",
        sold_by="Daniel",
        company_name="Loser Co",
        email="ap@loser.example",
        status="conflict",
        conflict_reason="slot_taken",
        stripe_session_id=session,
        expires_at=datetime.now(UTC) + timedelta(minutes=10),
    )
    db.add(row)
    db.commit()
    return row


def _seed_loser(fake: FakeStripe, *, status="active", refunded=(False, False)):
    fake.add_subscription(SUB, customer="cus_loser000001", status=status)
    fake.add_session(CS, status="complete")
    fake.sessions[CS]["subscription"] = SUB
    fake.add_paid_invoice(
        "in_loser000001", sub=SUB, pi="pi_loser000001", amount=210000, refunded=refunded[0]
    )
    fake.add_paid_invoice(
        "in_loser000002", sub=SUB, pi="pi_loser000002", amount=210000, refunded=refunded[1]
    )


def _idem(req) -> str | None:
    return req.headers.get("Idempotency-Key")


# ── resolve_conflict ───────────────────────────────────────────────────────


def test_conflict_cancels_first_then_refunds_every_paid_invoice(db, fake):
    intent = _conflict(db)
    _seed_loser(fake)
    ok = run(fake, lambda c: bf.resolve_conflict(db, c, intent.id))
    assert ok is True

    methods = [(r.method, r.path) for r in fake.tape]
    cancel_at = methods.index(("DELETE", f"/v1/subscriptions/{SUB}"))
    refund_at = [i for i, m in enumerate(methods) if m == ("POST", "/v1/refunds")]
    assert len(refund_at) == 2
    assert cancel_at < min(refund_at), "cancel must come first, or month two still bills"
    assert fake.subscriptions[SUB]["status"] == "canceled"

    keys = {_idem(r) for r in fake.calls("POST", "/v1/refunds")}
    assert keys == {
        f"conflict-refund:{intent.id}:in_loser000001",
        f"conflict-refund:{intent.id}:in_loser000002",
    }
    db.refresh(intent)
    assert intent.resolved_at is not None
    audit = db.query(BillingAudit).filter_by(action="conflict_resolved").one()
    assert audit.intent_id == intent.id and audit.amount_cents == 420000


def test_a_failed_refund_leaves_it_unresolved_and_the_next_run_finishes(db, fake, monkeypatch):
    intent = _conflict(db)
    _seed_loser(fake)
    real = stripe_billing.refund_invoice
    failures = [1]

    async def flaky(client, invoice_id, amount_cents, idempotency_key):
        if failures:
            failures.pop()
            raise StripeApiError("Stripe is having a moment.", status=502)
        return await real(client, invoice_id, amount_cents, idempotency_key)

    monkeypatch.setattr(stripe_billing, "refund_invoice", flaky)
    assert run(fake, lambda c: bf.resolve_conflict(db, c, intent.id)) is False
    db.refresh(intent)
    assert intent.resolved_at is None
    assert db.query(BillingAudit).filter_by(action="conflict_resolved").count() == 0

    assert run(fake, lambda c: bf.resolve_conflict(db, c, intent.id)) is True
    db.refresh(intent)
    assert intent.resolved_at is not None
    assert len(fake.refunds) == 2


def test_already_canceled_and_already_refunded_count_as_done(db, fake):
    intent = _conflict(db)
    _seed_loser(fake, status="canceled", refunded=(True, False))
    assert run(fake, lambda c: bf.resolve_conflict(db, c, intent.id)) is True
    db.refresh(intent)
    assert intent.resolved_at is not None
    assert len(fake.refunds) == 1


def test_refunds_are_mirrored_onto_payment_rows(db, fake):
    intent = _conflict(db)
    _seed_loser(fake)
    db.add(
        SponsorPayment(
            stripe_invoice_id="in_loser000001",
            stripe_subscription_id=SUB,
            amount_due_cents=210000,
            amount_paid_cents=210000,
            status="paid",
        )
    )
    db.commit()
    run(fake, lambda c: bf.resolve_conflict(db, c, intent.id))
    row = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_loser000001").one()
    assert (row.amount_refunded_cents, row.status) == (210000, "refunded")


def test_a_resolved_or_unknown_intent_makes_no_calls(db, fake):
    intent = _conflict(db)
    intent.resolved_at = datetime.now(UTC)
    db.commit()
    assert run(fake, lambda c: bf.resolve_conflict(db, c, intent.id)) is True
    assert run(fake, lambda c: bf.resolve_conflict(db, c, uuid.uuid4())) is False
    assert fake.tape == []


def test_a_session_without_a_subscription_stays_for_a_human(db, fake):
    intent = _conflict(db)
    fake.add_session(CS, status="complete")
    assert run(fake, lambda c: bf.resolve_conflict(db, c, intent.id)) is False
    db.refresh(intent)
    assert intent.resolved_at is None


# ── post_activation ────────────────────────────────────────────────────────


def _billed_sponsor(db, seeded_db, *, sub="sub_live0000001", customer="cus_buyer000001"):
    sponsor = Sponsor(
        supplier_id=seeded_db["supplier1"].id,
        keyword="post-activation",
        tier="Silver",
        status="Active",
        amount=Decimal("210"),
        stripe_subscription_id=sub,
    )
    db.add(sponsor)
    db.flush()
    db.add(
        SponsorBilling(
            sponsor_id=sponsor.id,
            stripe_subscription_id=sub,
            stripe_customer_id=customer,
            channel="self_serve",
            list_usd=250,
            founder_usd=210,
            price_usd=210,
        )
    )
    db.commit()
    return sponsor


def test_post_activation_moves_the_card_stamps_the_customer_and_mirrors(db, seeded_db, fake):
    sponsor = _billed_sponsor(db, seeded_db)
    fake.add_customer("cus_buyer000001")
    fake.add_subscription(
        "sub_live0000001",
        customer="cus_buyer000001",
        tier="silver",
        default_payment_method="pm_card0000001",
        latest_invoice="in_first000001",
    )
    fake.add_paid_invoice("in_first000001", sub="sub_live0000001", pi="pi_1234567", amount=21000)

    assert run(fake, lambda c: bf.post_activation(db, c, sponsor.id)) is True

    customer_posts = fake.calls("POST", "/v1/customers/cus_buyer000001")
    forms = [r.form for r in customer_posts]
    assert {"invoice_settings[default_payment_method]": "pm_card0000001"}.items() <= (
        forms[0].items()
    )
    assert any(f.get("metadata[supplier_id]") == str(sponsor.supplier_id) for f in forms)
    sub_post = fake.last("POST", "/v1/subscriptions/sub_live0000001")
    assert sub_post.form == {"default_payment_method": ""}

    payment = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_first000001").one()
    assert payment.sponsor_id == sponsor.id
    billing = db.get(SponsorBilling, sponsor.id)
    assert billing.post_activation_done_at is not None

    before = len(fake.tape)
    assert run(fake, lambda c: bf.post_activation(db, c, sponsor.id)) is True
    assert len(fake.tape) == before, "a done follow-up must not call Stripe again"


def test_post_activation_failure_is_left_pending(db, seeded_db, fake):
    sponsor = _billed_sponsor(db, seeded_db)
    # No such subscription on the fake → Stripe 404.
    assert run(fake, lambda c: bf.post_activation(db, c, sponsor.id)) is False
    assert db.get(SponsorBilling, sponsor.id).post_activation_done_at is None


# ── void_pending ───────────────────────────────────────────────────────────


def test_void_pending_voids_open_invoices_and_clears_the_flag(db, seeded_db, fake):
    sponsor = _billed_sponsor(db, seeded_db)
    billing = db.get(SponsorBilling, sponsor.id)
    billing.void_pending = True
    db.commit()
    fake.add_subscription("sub_live0000001", customer="cus_buyer000001", status="canceled")
    fake.add_open_invoice("in_open0000001", sub="sub_live0000001", amount=21000)

    assert run(fake, lambda c: bf.void_pending(db, c, sponsor.id)) is True
    assert fake.invoices["in_open0000001"]["status"] == "void"
    db.refresh(billing)
    assert billing.void_pending is False


# ── run_followup (the background-task entry) ───────────────────────────────


def test_run_followup_opens_its_own_session_and_client(db, seeded_db, fake, monkeypatch):
    sponsor = _billed_sponsor(db, seeded_db)
    billing = db.get(SponsorBilling, sponsor.id)
    billing.void_pending = True
    db.commit()
    fake.add_subscription("sub_live0000001", customer="cus_buyer000001", status="canceled")
    fake.add_open_invoice("in_open0000001", sub="sub_live0000001", amount=21000)
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_followups")
    monkeypatch.setattr(bf, "session_factory", TestingSessionLocal)
    monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)

    asyncio.run(bf.run_followup("void", str(sponsor.id)))
    db.expire_all()
    assert db.get(SponsorBilling, sponsor.id).void_pending is False


def test_run_followup_never_raises(monkeypatch, fake):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_followups")
    monkeypatch.setattr(bf, "session_factory", TestingSessionLocal)
    monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)

    async def boom(db, client, ref):
        raise RuntimeError("nobody would see this")

    monkeypatch.setitem(bf._KINDS, "void", boom)
    asyncio.run(bf.run_followup("void", str(uuid.uuid4())))
    asyncio.run(bf.run_followup("unknown-kind", "x"))
    asyncio.run(bf.run_followup("void", "not-a-uuid"))


def test_run_followup_is_inert_without_a_key(monkeypatch):
    called = []
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", None)
    monkeypatch.setattr(bf, "session_factory", lambda: called.append(1))
    asyncio.run(bf.run_followup("void", str(uuid.uuid4())))
    assert called == []
