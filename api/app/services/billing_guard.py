"""R15 (spec §9, LU-F14e): a billed sponsor cannot be deleted or expired around
its subscription.

Sponsor DELETE, supplier DELETE and a sponsor PATCH to ``status=Expired``
answer 409 ``billing_active`` while the sponsor has a stored subscription (its
``sponsor_billing`` row, or the self-serve owner key on the sponsor row itself)
and is not ``Expired``. Deleting it would cascade the billing row away while
Stripe keeps charging, with no console page left to stop it; "Expired" typed
into the form would hide the board while the customer keeps paying. The way
out is Billing → Cancel (the console, the sweep and the webhook's
``customer.subscription.deleted`` all set ``Expired``), which lifts the guard.
Paused stays allowed — "hide the board, keep billing" is exactly what it
means. No Stripe call is made here.
"""

from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models import Sponsor
from app.models.sales import SponsorBilling

BILLING_ACTIVE = "billing_active"


def _billed(db: Session):
    # Canonical comparison (F3): admin writes are canonicalised now, but a row
    # written before that may say "expired" / " Expired " and is just as
    # expired — it must not stay guarded.
    return (
        db.query(Sponsor.id)
        .outerjoin(SponsorBilling, SponsorBilling.sponsor_id == Sponsor.id)
        .filter(
            or_(Sponsor.status.is_(None), func.lower(func.trim(Sponsor.status)) != "expired"),
            or_(
                SponsorBilling.stripe_subscription_id.isnot(None),
                Sponsor.stripe_subscription_id.isnot(None),
            ),
        )
    )


def refuse_if_billing_active(
    db: Session,
    *,
    sponsor_id: uuid.UUID | None = None,
    supplier_id: uuid.UUID | None = None,
) -> None:
    """409 ``billing_active`` when the sponsor (or any sponsor of the supplier)
    still has a live subscription stored beside it."""
    query = _billed(db)
    if sponsor_id is not None:
        query = query.filter(Sponsor.id == sponsor_id)
    if supplier_id is not None:
        query = query.filter(Sponsor.supplier_id == supplier_id)
    if query.first() is not None:
        raise HTTPException(status_code=409, detail=BILLING_ACTIVE)
