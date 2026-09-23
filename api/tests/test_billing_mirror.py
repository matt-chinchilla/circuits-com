"""The billing mirror helpers (spec §6/§8): audit, sponsor_billing upsert, the
invoice → sponsor_payments mirror and lazy sponsor attachment. None commits."""

import uuid

import pytest

from app.models import BillingAudit, SponsorBilling, SponsorPayment
from app.services import billing_mirror as bm

SUB = "sub_1Qdahlia0000000000000"


def dahlia_invoice(**kw) -> dict:
    """A 2026-07-29.dahlia invoice: the subscription sits under
    parent.subscription_details, and there is NO payment_intent / charge key."""
    base = {
        "id": "in_1Qdahlia0000000000001",
        "object": "invoice",
        "status": "paid",
        "attempted": True,
        "amount_due": 210000,
        "amount_paid": 210000,
        "amount_remaining": 0,
        "created": 1_790_000_000,
        "hosted_invoice_url": "https://invoice.stripe.com/i/acct_x/test_1",
        "status_transitions": {"paid_at": 1_790_000_100},
        "parent": {
            "type": "subscription_details",
            "subscription_details": {"subscription": SUB, "metadata": {}},
        },
    }
    base.update(kw)
    return base


# ── audit ────────────────────────────────────────────────────────────────────


def test_audit_inserts_a_row(db):
    sponsor_id = uuid.uuid4()
    bm.audit(db, "Daniel", "refund", sponsor_id=sponsor_id, amount_cents=5000, detail="half")
    db.commit()
    row = db.query(BillingAudit).one()
    assert (row.actor, row.action, row.sponsor_id, row.amount_cents, row.detail) == (
        "Daniel",
        "refund",
        sponsor_id,
        5000,
        "half",
    )
    assert row.created_at is not None


def test_audit_does_not_commit(db):
    bm.audit(db, "system:sweep", "dunning_cancelled")
    db.rollback()
    assert db.query(BillingAudit).count() == 0


def test_audit_knows_every_spec_action():
    assert bm.AUDIT_ACTIONS == {
        "code_created",
        "code_updated",
        "checkout_started",
        "hold_released",
        "sale_activated",
        "sale_conflict",
        "conflict_resolved",
        "cancel_period_end",
        "cancel_resumed",
        "cancel_now",
        "refund",
        "discount_changed",
        "payment_retried",
        "card_link_created",
        "card_updated",
        "dunning_cancelled",
        "quote_created",
    }


def test_audit_refuses_an_unknown_action(db):
    with pytest.raises(ValueError):
        bm.audit(db, "Daniel", "refunded")


def test_audit_clips_long_detail(db):
    bm.audit(db, "Daniel", "code_updated", detail="x" * 900)
    db.commit()
    assert len(db.query(BillingAudit).one().detail) == 500


# ── sponsor_billing ──────────────────────────────────────────────────────────


def test_upsert_billing_creates_then_updates(db, seeded_db):
    sponsor_id = seeded_db["sponsor"].id
    row = bm.upsert_billing(
        db,
        sponsor_id,
        channel="rep_code",
        list_usd=2500,
        founder_usd=2100,
        price_usd=1850,
        stripe_subscription_id=SUB,
    )
    db.commit()
    assert row.sponsor_id == sponsor_id and row.price_usd == 1850

    again = bm.upsert_billing(db, sponsor_id, stripe_customer_id="cus_1", price_usd=1750)
    db.commit()
    assert again is row
    assert db.query(SponsorBilling).count() == 1
    assert (row.stripe_customer_id, row.price_usd, row.channel) == ("cus_1", 1750, "rep_code")


def test_upsert_billing_twice_before_a_flush_is_still_one_row(db, seeded_db):
    sponsor_id = seeded_db["sponsor"].id
    bm.upsert_billing(db, sponsor_id, channel="self_serve", list_usd=250, price_usd=210)
    bm.upsert_billing(db, sponsor_id, failing_since=None, card_link_version=1)
    db.commit()
    assert db.query(SponsorBilling).count() == 1


def test_upsert_billing_refuses_an_unknown_field(db, seeded_db):
    with pytest.raises(TypeError):
        bm.upsert_billing(db, seeded_db["sponsor"].id, pirce_usd=1)


def test_upsert_billing_does_not_commit(db, seeded_db):
    bm.upsert_billing(db, seeded_db["sponsor"].id, channel="quote", list_usd=1, price_usd=1)
    db.rollback()
    assert db.query(SponsorBilling).count() == 0


# ── the invoice mirror ───────────────────────────────────────────────────────


def test_a_dahlia_paid_invoice_creates_a_payment_row(db):
    row = bm.upsert_payment_from_invoice(db, dahlia_invoice())
    db.commit()
    assert row.stripe_invoice_id == "in_1Qdahlia0000000000001"
    assert row.stripe_subscription_id == SUB
    assert row.status == "paid"
    assert (row.amount_due_cents, row.amount_paid_cents, row.amount_refunded_cents) == (
        210000,
        210000,
        0,
    )
    assert row.stripe_payment_intent_id is None  # dahlia carries none; filled on demand
    assert row.sponsor_id is None  # resolved lazily
    assert row.hosted_invoice_url.startswith("https://invoice.stripe.com/")
    assert row.invoice_created_at is not None and row.paid_at is not None


def test_the_same_invoice_updates_in_place(db):
    first = bm.upsert_payment_from_invoice(
        db, dahlia_invoice(status="open", amount_paid=0, attempted=True)
    )
    db.commit()
    assert first.status == "failed"
    second = bm.upsert_payment_from_invoice(db, dahlia_invoice())
    db.commit()
    assert second is first
    assert db.query(SponsorPayment).count() == 1
    assert first.status == "paid" and first.amount_paid_cents == 210000


def test_an_unattempted_open_invoice_is_open_not_failed(db):
    row = bm.upsert_payment_from_invoice(
        db, dahlia_invoice(status="open", amount_paid=0, attempted=False)
    )
    assert row.status == "open"


def test_a_late_failure_never_downgrades_a_paid_invoice(db):
    row = bm.upsert_payment_from_invoice(db, dahlia_invoice())
    db.commit()
    bm.upsert_payment_from_invoice(db, dahlia_invoice(status="open", amount_paid=0))
    db.commit()
    assert row.status == "paid" and row.amount_paid_cents == 210000


def test_refunded_amounts_survive_a_redelivered_paid_invoice(db):
    row = bm.upsert_payment_from_invoice(db, dahlia_invoice())
    row.amount_refunded_cents = 50000
    row.status = "partially_refunded"
    db.commit()
    bm.upsert_payment_from_invoice(db, dahlia_invoice())
    db.commit()
    assert row.amount_refunded_cents == 50000 and row.status == "partially_refunded"
    row.amount_refunded_cents = 210000
    bm.upsert_payment_from_invoice(db, dahlia_invoice())
    assert row.status == "refunded"


def test_no_subscription_id_is_none(db):
    invoice = dahlia_invoice(parent=None)
    assert bm.upsert_payment_from_invoice(db, invoice) is None
    assert bm.upsert_payment_from_invoice(db, dahlia_invoice(parent={})) is None
    assert db.query(SponsorPayment).count() == 0


def test_no_invoice_id_is_none(db):
    assert bm.upsert_payment_from_invoice(db, dahlia_invoice(id=None)) is None
    assert bm.upsert_payment_from_invoice(db, {}) is None


def test_the_legacy_shape_still_reads(db):
    """Webhook payloads follow the ENDPOINT's version; parsers stay dual-shape (§5)."""
    legacy = dahlia_invoice(parent=None, subscription=SUB, payment_intent="pi_legacy_1")
    row = bm.upsert_payment_from_invoice(db, legacy)
    assert row.stripe_subscription_id == SUB and row.stripe_payment_intent_id == "pi_legacy_1"


def test_an_expanded_subscription_object_reads(db):
    invoice = dahlia_invoice(
        parent={"subscription_details": {"subscription": {"id": SUB, "object": "subscription"}}}
    )
    assert bm.upsert_payment_from_invoice(db, invoice).stripe_subscription_id == SUB


def test_a_known_subscription_attaches_its_sponsor_at_once(db, seeded_db):
    sponsor_id = seeded_db["sponsor"].id
    bm.upsert_billing(
        db,
        sponsor_id,
        channel="self_serve",
        list_usd=2500,
        price_usd=2100,
        stripe_subscription_id=SUB,
    )
    db.commit()
    row = bm.upsert_payment_from_invoice(db, dahlia_invoice())
    assert row.sponsor_id == sponsor_id


def test_upsert_payment_does_not_commit(db):
    bm.upsert_payment_from_invoice(db, dahlia_invoice())
    db.rollback()
    assert db.query(SponsorPayment).count() == 0


# ── lazy attachment ──────────────────────────────────────────────────────────


def test_attach_payments_fills_sponsor_id(db):
    bm.upsert_payment_from_invoice(db, dahlia_invoice())
    bm.upsert_payment_from_invoice(db, dahlia_invoice(id="in_2"))
    bm.upsert_payment_from_invoice(
        db,
        dahlia_invoice(id="in_other", parent={"subscription_details": {"subscription": "sub_x"}}),
    )
    db.commit()
    sponsor_id = uuid.uuid4()
    assert bm.attach_payments(db, SUB, sponsor_id) == 2
    db.commit()
    by_invoice = {p.stripe_invoice_id: p.sponsor_id for p in db.query(SponsorPayment).all()}
    assert by_invoice == {
        "in_1Qdahlia0000000000001": sponsor_id,
        "in_2": sponsor_id,
        "in_other": None,
    }


def test_attach_payments_never_moves_a_payment_to_another_sponsor(db):
    row = bm.upsert_payment_from_invoice(db, dahlia_invoice())
    owner = uuid.uuid4()
    row.sponsor_id = owner
    db.commit()
    assert bm.attach_payments(db, SUB, uuid.uuid4()) == 0
    db.commit()
    assert row.sponsor_id == owner
