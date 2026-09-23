"""Stripe follow-ups the webhook cannot do inline (spec §8.5, §10).

The webhook answers Stripe fast and never calls it back; what a delivery
leaves runs here, first as a FastAPI background task right after the 200, then
from the hourly sweep for anything that did not finish:

* ``post_activation`` — after a sale activates: R14 card move (the card
  Checkout saved on the SUBSCRIPTION goes to the customer, or a portal card
  update would never be charged), ``metadata[supplier_id]`` stamped on the
  Stripe customer, and the subscription's ``latest_invoice`` mirrored (the
  first invoice's ``invoice.paid`` can arrive before the sponsor existed).
  Done once: ``sponsor_billing.post_activation_done_at``.
* ``resolve_conflict`` — a paid checkout the sale refused (spec §10.3, LU-F5b):
  cancel the subscription FIRST (``invoice_now=false``, ``prorate=false``) so it
  can never bill again, void its open invoices, refund EVERY paid invoice,
  then ``resolved_at`` + audit ``conflict_resolved``. Any failure returns
  False with ``resolved_at`` still NULL, so the row stays in Needs attention
  and the next run tries again. "Already canceled" and
  ``charge_already_refunded`` count as done (Stripe prunes idempotency keys
  after 24 h; the retries can outlive them).
* ``void_pending`` — a deleted subscription's open invoices (a canceled
  subscription's open invoice can still be paid and resurrect the sponsor).

Each body takes the session and a Stripe client, records its own completion,
commits, and returns whether it is done. Stripe errors are logged and turned
into ``False``; ``run_followup`` also swallows anything else, because it runs
after the response where an exception reaches nobody.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import SessionLocal
from app.models import Sponsor
from app.models.sales import CheckoutIntent, SponsorBilling, SponsorPayment
from app.services import stripe_billing, stripe_quotes
from app.services.billing_mirror import (
    PARTIALLY_REFUNDED,
    REFUNDED,
    audit,
    upsert_payment_from_invoice,
)
from app.services.checkout_intents import CONFLICT
from app.services.stripe_quotes import StripeApiError, _call, _object_id

logger = logging.getLogger(__name__)

# Seam for tests (the suite binds its own engine), like category_cache's.
session_factory = SessionLocal


def _now() -> datetime:
    return datetime.now(UTC)


async def post_activation(db: Session, client, sponsor_id: uuid.UUID) -> bool:
    billing = db.get(SponsorBilling, sponsor_id)
    sponsor = db.get(Sponsor, sponsor_id)
    if billing is None or sponsor is None:
        return False
    if billing.post_activation_done_at is not None:
        return True
    sub_id = billing.stripe_subscription_id or sponsor.stripe_subscription_id
    if not sub_id:
        return False
    try:
        await stripe_billing.move_card_to_customer(client, sub_id)
        sub = await stripe_billing.get_subscription(client, sub_id)
        customer = billing.stripe_customer_id or _object_id(sub.get("customer"))
        if customer:
            await stripe_billing.stamp_customer_supplier(client, customer, str(sponsor.supplier_id))
            billing.stripe_customer_id = customer
        latest = _object_id(sub.get("latest_invoice"))
        if latest:
            invoice = await _call(
                client, "GET", f"/v1/invoices/{stripe_billing.checked_id('in', latest)}"
            )
            payment = upsert_payment_from_invoice(db, invoice)
            if payment is not None and payment.sponsor_id is None:
                payment.sponsor_id = sponsor.id
    except StripeApiError as exc:
        db.rollback()
        logger.warning("post-activation for sponsor %s failed: %s", sponsor_id, exc.message)
        return False
    billing.post_activation_done_at = _now()
    db.commit()
    return True


def _mirror_refund(db: Session, invoice_id: str, refunded_cents: int) -> None:
    row = db.query(SponsorPayment).filter_by(stripe_invoice_id=invoice_id).first()
    if row is None:
        return
    row.amount_refunded_cents = max(row.amount_refunded_cents or 0, refunded_cents)
    paid = row.amount_paid_cents or 0
    row.status = REFUNDED if row.amount_refunded_cents >= paid else PARTIALLY_REFUNDED


async def resolve_conflict(
    db: Session, client, intent_id: uuid.UUID, actor: str = "system:sweep"
) -> bool:
    intent = db.get(CheckoutIntent, intent_id)
    if intent is None or intent.status != CONFLICT:
        return False
    if intent.resolved_at is not None:
        return True
    if not intent.stripe_session_id:
        logger.error("conflict intent %s has no session id — needs a human", intent_id)
        return False
    try:
        session = await _call(
            client,
            "GET",
            f"/v1/checkout/sessions/{stripe_billing.checked_id('cs', intent.stripe_session_id)}",
        )
        sub_id = _object_id(session.get("subscription"))
        if not sub_id:
            logger.error(
                "conflict intent %s: session %s has no subscription — needs a human",
                intent_id,
                intent.stripe_session_id,
            )
            return False
        # Cancel FIRST: a refund that fails must never leave a live
        # subscription behind to bill month two.
        await stripe_billing.cancel_now(client, sub_id, f"conflict-cancel:{intent.id}")
        await stripe_billing.void_open_invoices(client, sub_id)
        paid = await stripe_billing.list_invoices(client, sub_id, status="paid", limit=100)
        refunded_cents = 0
        count = 0
        for invoice in paid:
            amount_paid = invoice.get("amount_paid") or 0
            if not isinstance(amount_paid, int) or amount_paid <= 0:
                continue
            invoice_id = invoice.get("id")
            refund = await stripe_billing.refund_invoice(
                client, invoice_id, None, f"conflict-refund:{intent.id}:{invoice_id}"
            )
            if refund is not None:
                refunded_cents += refund.get("amount") or 0
            count += 1
            _mirror_refund(db, invoice_id, amount_paid)
    except StripeApiError as exc:
        db.rollback()
        logger.warning("conflict intent %s not resolved yet: %s", intent_id, exc.message)
        return False

    intent.resolved_at = _now()
    audit(
        db,
        actor,
        "conflict_resolved",
        intent_id=intent.id,
        sales_code_id=intent.sales_code_id,
        amount_cents=refunded_cents,
        detail=(f"{intent.conflict_reason}; canceled {sub_id}; {count} paid invoice(s) refunded"),
    )
    db.commit()
    return True


async def void_pending(db: Session, client, sponsor_id: uuid.UUID) -> bool:
    billing = db.get(SponsorBilling, sponsor_id)
    if billing is None:
        return False
    if not billing.void_pending:
        return True
    if billing.stripe_subscription_id:
        try:
            await stripe_billing.void_open_invoices(client, billing.stripe_subscription_id)
        except StripeApiError as exc:
            db.rollback()
            logger.warning("voiding for sponsor %s failed: %s", sponsor_id, exc.message)
            return False
    billing.void_pending = False
    db.commit()
    return True


_KINDS = {
    "post_activation": post_activation,
    "conflict": resolve_conflict,
    "void": void_pending,
}


async def run_followup(kind: str, ref: str) -> None:
    """Run one follow-up with its own session and Stripe client. Never raises:
    it runs after the response, where an exception reaches nobody — the
    sweep is the retry."""
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    body = _KINDS.get(kind)
    if not key or body is None:
        return
    try:
        target = uuid.UUID(str(ref))
    except ValueError:
        logger.warning("billing follow-up %s got a malformed ref %r", kind, ref)
        return
    db = session_factory()
    try:
        async with stripe_quotes.make_client(key) as client:
            if body is resolve_conflict:
                await body(db, client, target, actor="system:webhook")
            else:
                await body(db, client, target)
    except Exception:  # noqa: BLE001 - after the response nobody else would see it
        db.rollback()
        logger.exception("billing follow-up %s for %s failed — the sweep will retry", kind, ref)
    finally:
        db.close()
