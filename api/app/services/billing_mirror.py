"""Our mirror of Stripe billing state (spec §6/§8). No commits inside — the
caller (webhook, console route, sweep) owns the transaction.

* ``audit`` — one staff-only ``billing_audit`` row per action.
* ``upsert_billing`` — the 1:1 ``sponsor_billing`` row beside a sponsor.
* ``upsert_payment_from_invoice`` — an invoice → ``sponsor_payments``, keyed by
  invoice id. Reads BOTH invoice shapes: ``2026-07-29.dahlia`` puts the
  subscription under ``parent.subscription_details.subscription`` and carries no
  ``payment_intent``/``charge``; older payloads (a webhook endpoint follows its
  own API version) carry a top-level ``subscription``/``payment_intent``.
* ``recompute_failing_since`` — ``sponsor_billing.failing_since`` DERIVED from
  the mirror (the oldest still-failed invoice), run after every invoice
  upsert by the webhook and the sweep.
* ``attach_payments`` — gives rows mirrored before their sponsor existed (the
  first ``invoice.paid`` can beat ``checkout.session.completed``) their sponsor.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.sales import BillingAudit, SponsorBilling, SponsorPayment

# Spec §6, verbatim. A typo'd action would write an audit row no reader
# recognises, so an unknown one is a programming error.
AUDIT_ACTIONS: frozenset[str] = frozenset(
    {
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
)

# sponsor_payments.status
PAID, FAILED, OPEN = "paid", "failed", "open"
REFUNDED, PARTIALLY_REFUNDED = "refunded", "partially_refunded"
_SETTLED = frozenset({PAID, REFUNDED, PARTIALLY_REFUNDED})

_BILLING_FIELDS = frozenset(SponsorBilling.__table__.c.keys()) - {"sponsor_id"}


def audit(
    db: Session,
    actor: str,
    action: str,
    *,
    sponsor_id: uuid.UUID | None = None,
    sales_code_id: uuid.UUID | None = None,
    intent_id: uuid.UUID | None = None,
    amount_cents: int | None = None,
    detail: str = "",
) -> None:
    if action not in AUDIT_ACTIONS:
        raise ValueError(f"unknown billing audit action {action!r}")
    db.add(
        BillingAudit(
            actor=actor[:120],
            action=action,
            sponsor_id=sponsor_id,
            sales_code_id=sales_code_id,
            intent_id=intent_id,
            amount_cents=amount_cents,
            detail=(detail or "")[:500],
        )
    )


def upsert_billing(db: Session, sponsor_id: uuid.UUID, **fields: Any) -> SponsorBilling:
    """Create or update the sponsor's billing row with ``fields`` (column names).
    A new row is flushed at once so a second call in the same transaction finds
    it rather than inserting a twin."""
    unknown = set(fields) - _BILLING_FIELDS
    if unknown:
        raise TypeError(f"sponsor_billing has no column(s) {sorted(unknown)}")
    row = db.get(SponsorBilling, sponsor_id)
    if row is None:
        row = SponsorBilling(sponsor_id=sponsor_id, **fields)
        db.add(row)
        db.flush()
        return row
    for name, value in fields.items():
        setattr(row, name, value)
    return row


def _stripe_id(value: Any) -> str | None:
    """A Stripe reference that may arrive as an id string or an expanded object."""
    if isinstance(value, dict):
        value = value.get("id")
    return value if isinstance(value, str) and value else None


def invoice_subscription_id(invoice: dict) -> str | None:
    parent = invoice.get("parent")
    if isinstance(parent, dict):
        details = parent.get("subscription_details")
        if isinstance(details, dict):
            found = _stripe_id(details.get("subscription"))
            if found:
                return found
    return _stripe_id(invoice.get("subscription"))


def _epoch(value: Any) -> datetime | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return datetime.fromtimestamp(value, UTC)


def _cents(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _invoice_status(invoice: dict, amount_paid: int) -> str:
    if invoice.get("status") == "paid":
        return PAID
    if amount_paid == 0 and invoice.get("attempted"):
        return FAILED
    return OPEN


def _refund_status(paid_cents: int, refunded_cents: int) -> str:
    if refunded_cents <= 0:
        return PAID
    return REFUNDED if refunded_cents >= paid_cents else PARTIALLY_REFUNDED


def upsert_payment_from_invoice(db: Session, invoice: dict) -> SponsorPayment | None:
    """Mirror one invoice. ``None`` when it has no id or no subscription (a
    one-off invoice is not a sponsorship). Refund columns belong to the console
    (it writes them after ``POST /v1/refunds``) and are kept; a settled row is
    never downgraded by a late or redelivered failure event."""
    invoice_id = _stripe_id(invoice.get("id")) if isinstance(invoice, dict) else None
    subscription_id = invoice_subscription_id(invoice) if invoice_id else None
    if not invoice_id or not subscription_id:
        return None

    amount_due = _cents(invoice.get("amount_due"))
    amount_paid = _cents(invoice.get("amount_paid"))
    status = _invoice_status(invoice, amount_paid)

    row = db.query(SponsorPayment).filter(SponsorPayment.stripe_invoice_id == invoice_id).first()
    if row is None:
        row = SponsorPayment(
            stripe_invoice_id=invoice_id,
            stripe_subscription_id=subscription_id,
            amount_refunded_cents=0,
        )
        db.add(row)

    if not (row.status in _SETTLED and status != PAID):
        row.amount_due_cents = amount_due
        row.amount_paid_cents = amount_paid
        row.status = (
            _refund_status(amount_paid, row.amount_refunded_cents or 0)
            if status == PAID
            else status
        )
        paid_at = _epoch((invoice.get("status_transitions") or {}).get("paid_at"))
        if paid_at is not None:
            row.paid_at = paid_at

    row.invoice_created_at = _epoch(invoice.get("created")) or row.invoice_created_at
    row.hosted_invoice_url = invoice.get("hosted_invoice_url") or row.hosted_invoice_url
    legacy_pi = _stripe_id(invoice.get("payment_intent"))
    if legacy_pi and not row.stripe_payment_intent_id:
        row.stripe_payment_intent_id = legacy_pi

    if row.sponsor_id is None:
        known = (
            db.query(SponsorBilling.sponsor_id)
            .filter(SponsorBilling.stripe_subscription_id == subscription_id)
            .first()
        )
        if known is not None:
            row.sponsor_id = known[0]

    db.flush()
    return row


def recompute_failing_since(db: Session, subscription_id: str) -> datetime | None:
    """Derive ``sponsor_billing.failing_since`` for every billing row naming
    ``subscription_id`` from the mirror: the ``invoice_created_at`` of the
    OLDEST still-``failed`` invoice of that subscription, else NULL.

    Never toggled by event type (F2): a replayed ``invoice.paid`` for an older
    invoice cannot clear a newer failure, a failed invoice that is later paid
    flips to ``paid`` here and drops out, and a new failure after a recovery
    starts a fresh clock. Returns the value written."""
    if not subscription_id:
        return None
    db.flush()
    failed = (
        db.query(SponsorPayment.invoice_created_at, SponsorPayment.updated_at)
        .filter(
            SponsorPayment.stripe_subscription_id == subscription_id,
            SponsorPayment.status == FAILED,
        )
        .all()
    )
    # A failed invoice mirrored without a ``created`` still counts — from when
    # we first recorded it — rather than silently reading as "not failing".
    dates = [_aware(created or seen) for created, seen in failed if created or seen]
    since = min(dates) if dates else None
    for billing in db.query(SponsorBilling).filter(
        SponsorBilling.stripe_subscription_id == subscription_id
    ):
        billing.failing_since = since
    return since


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def attach_payments(db: Session, subscription_id: str, sponsor_id: uuid.UUID) -> int:
    """Give this subscription's unattached payment rows their sponsor; returns
    how many. A row already naming a sponsor is never moved (R13)."""
    rows = (
        db.query(SponsorPayment)
        .filter(
            SponsorPayment.stripe_subscription_id == subscription_id,
            SponsorPayment.sponsor_id.is_(None),
        )
        .all()
    )
    for row in rows:
        row.sponsor_id = sponsor_id
    return len(rows)
