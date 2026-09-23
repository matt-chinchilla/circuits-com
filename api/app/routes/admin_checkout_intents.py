"""Needs attention — /api/admin/checkout-intents (spec §9, LU-F14a/b).

What billing needs a human for, and the two actions that keep reps out of the
Stripe dashboard (D1):

* ``GET /attention`` → ``{"conflicts", "holds", "failing"}``: paid checkouts the
  sale refused whose cancel + refund has not completed (``status='conflict'``,
  ``resolved_at`` NULL — THE conflict queue), live exclusive holds, and billed
  sponsors whose payments are failing (with the date the sweep will release
  them).
* ``POST /{id}/resolve`` → ``{"resolved": bool}``: run the conflict's cancel +
  refund now (the same ``billing_followups.resolve_conflict`` the webhook's
  background task and the sweep run). ``false`` = still failing; the row stays.
* ``POST /{id}/release`` → ``{"released": bool}``: expire a live hold's Stripe
  session and free the slot (a buyer whose release token was lost, a
  squatter). The session is READ first: one the buyer already paid
  (``complete``, or ``payment_status`` paid) is 409 ``already_paid`` and the
  hold stays, because the webhook is about to activate it; only an ``open``
  session is expired, and an already-``expired`` one is simply released.

STAFF-only (the router wall: viewers are read-only, customers 403). Every
route 404s when ``STRIPE_SECRET_KEY`` is unset — an unconfigured billing back
office does not exist. Every action writes ``billing_audit`` with the rep's
username.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Category, Sponsor, Supplier, User
from app.models.sales import CheckoutIntent, SponsorBilling
from app.services import stripe_billing, stripe_quotes
from app.services.auth_service import get_current_user, require_billing_reader, require_staff
from app.services.billing_followups import resolve_conflict
from app.services.billing_mirror import audit
from app.services.checkout_intents import CONFLICT, OPEN, RELEASED
from app.services.sales_pricing import EXCLUSIVE_TIERS
from app.services.stripe_quotes import StripeApiError

# Staff Release on a hold whose buyer has already paid (F1).
ALREADY_PAID = "already_paid"

router = APIRouter(
    prefix="/api/admin/checkout-intents",
    tags=["admin-checkout-intents"],
    dependencies=[Depends(require_staff)],
)


def _secret_key() -> str:
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    if not key:
        raise HTTPException(status_code=404, detail="Not found")
    return key


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()


def _category_names(db: Session, ids: set) -> dict:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    return {
        row[0]: row[1] for row in db.query(Category.id, Category.name).filter(Category.id.in_(ids))
    }


def _intent_row(intent: CheckoutIntent, names: dict) -> dict:
    return {
        "id": str(intent.id),
        "tier": intent.tier,
        "category_id": str(intent.category_id) if intent.category_id else None,
        "category_name": names.get(intent.category_id),
        "keyword": intent.keyword,
        "company_name": intent.company_name,
        "email": intent.email,
        "price_usd": intent.price_usd,
        "channel": intent.channel,
        "sold_by": intent.sold_by,
        "status": intent.status,
        "conflict_reason": intent.conflict_reason,
        "created_at": _iso(intent.created_at),
        "expires_at": _iso(intent.expires_at),
    }


def _load_intent(db: Session, intent_id: str) -> CheckoutIntent:
    try:
        key = uuid.UUID(intent_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Not found") from None
    intent = db.get(CheckoutIntent, key)
    if intent is None:
        raise HTTPException(status_code=404, detail="Not found")
    return intent


@router.get("/attention")
def attention(
    db: Session = Depends(get_db),
    _: User = Depends(require_billing_reader),
) -> dict:
    _secret_key()
    now = datetime.now(UTC)

    conflicts = (
        db.query(CheckoutIntent)
        .filter(CheckoutIntent.status == CONFLICT, CheckoutIntent.resolved_at.is_(None))
        .order_by(CheckoutIntent.created_at)
        .all()
    )
    holds = (
        db.query(CheckoutIntent)
        .filter(
            CheckoutIntent.status == OPEN,
            CheckoutIntent.tier.in_(EXCLUSIVE_TIERS),
            CheckoutIntent.expires_at > now,
        )
        .order_by(CheckoutIntent.expires_at)
        .all()
    )
    names = _category_names(db, {i.category_id for i in conflicts + holds})

    grace = timedelta(days=settings.BILLING_GRACE_DAYS)
    failing = []
    rows = (
        db.query(SponsorBilling, Sponsor, Supplier.name)
        .join(Sponsor, Sponsor.id == SponsorBilling.sponsor_id)
        .outerjoin(Supplier, Supplier.id == Sponsor.supplier_id)
        .filter(
            SponsorBilling.failing_since.isnot(None),
            or_(Sponsor.status.is_(None), Sponsor.status != "Expired"),
        )
        .order_by(SponsorBilling.failing_since)
        .all()
    )
    sponsor_names = _category_names(db, {sponsor.category_id for _, sponsor, _ in rows})
    for billing, sponsor, supplier_name in rows:
        since = billing.failing_since
        since = since if since.tzinfo else since.replace(tzinfo=UTC)
        failing.append(
            {
                "sponsor_id": str(sponsor.id),
                "supplier_name": supplier_name,
                "tier": sponsor.tier,
                "category_name": sponsor_names.get(sponsor.category_id),
                "keyword": sponsor.keyword,
                "price_usd": billing.price_usd,
                "collection_method": billing.collection_method,
                "failing_since": since.isoformat(),
                "cancels_on": (since + grace).isoformat(),
            }
        )

    return {
        "conflicts": [_intent_row(i, names) for i in conflicts],
        "holds": [_intent_row(i, names) for i in holds],
        "failing": failing,
    }


@router.post("/{intent_id}/resolve")
async def resolve(
    intent_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    key = _secret_key()
    intent = _load_intent(db, intent_id)
    if intent.status != CONFLICT:
        raise HTTPException(status_code=409, detail="not_a_conflict")
    if intent.resolved_at is not None:
        return {"resolved": True}
    async with stripe_quotes.make_client(key) as client:
        done = await resolve_conflict(db, client, intent.id, actor=user.username)
    return {"resolved": done}


@router.post("/{intent_id}/release")
async def release(
    intent_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    key = _secret_key()
    intent = _load_intent(db, intent_id)
    if intent.status != OPEN:
        return {"released": False}
    if intent.stripe_session_id:
        try:
            async with stripe_quotes.make_client(key) as client:
                session = await stripe_billing.get_checkout_session(
                    client, intent.stripe_session_id
                )
                if session.get("status") == "complete" or session.get("payment_status") == "paid":
                    # The buyer paid; the webhook that turns the hold into a
                    # sponsorship just has not landed. Freeing the slot now
                    # would hand it to someone else and turn this sale into a
                    # refunded conflict.
                    raise HTTPException(status_code=409, detail=ALREADY_PAID)
                if session.get("status") == "open":
                    await stripe_billing.expire_checkout_session(client, intent.stripe_session_id)
        except StripeApiError as exc:
            raise HTTPException(status_code=502, detail=f"stripe: {exc.message}") from None
    intent.status = RELEASED
    audit(
        db,
        user.username,
        "hold_released",
        intent_id=intent.id,
        sales_code_id=intent.sales_code_id,
        detail=f"staff release of the {intent.tier} hold for {intent.company_name}"[:500],
    )
    db.commit()
    return {"released": True}
