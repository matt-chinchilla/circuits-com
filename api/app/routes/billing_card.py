"""The customer's card-update link — /api/billing/card/{token} (spec §9, R14).

PUBLIC by design: the customer has no login; the signed, versioned,
expiring token (``services/card_links``) is the whole credential.

* ``GET /card/{token}`` — verify the token and that its version is the
  CURRENT one (a newer link revokes it) → move the card Checkout saved on the
  SUBSCRIPTION to the customer (R14, idempotent; covers legacy
  subscriptions, whose own card would otherwise outrank the one the portal
  saves) → ensure the app's card-only portal configuration → mint a portal
  session opened straight on "update your card" → 302 to it.
* ``GET /card/{token}/done`` — the portal's return: try the oldest open
  invoice ONCE per link version and card (the key names the customer's
  current default card, so a reload never pays twice but a new card after a
  decline is not refused by Stripe's stored 402),
  audit ``card_updated`` once per version, 302 to ``/join?card=updated``.

A dead link (bad signature, expired, superseded) is 410 with a sentence the
customer can act on. ``STRIPE_SECRET_KEY`` unset → 404, like every billing
route. Responses are ``no-store`` and send no referrer: the token rides in the
URL.
"""

from __future__ import annotations

import logging
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Sponsor
from app.models.sales import BillingAudit, SponsorBilling
from app.services import billing_mirror, card_links, stripe_billing, stripe_quotes
from app.services.stripe_quotes import StripeApiError, _call, _object_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/billing", tags=["billing-card"])

LINK_GONE = "This link has expired — ask your rep for a new one."
_NO_STORE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}


def _secret_key() -> str:
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    if not key:
        raise HTTPException(status_code=404, detail="Not found")
    return key


def _live_link(db: Session, token: str) -> tuple[Sponsor, SponsorBilling, str]:
    """(sponsor, billing row, subscription id) for a token that is genuine,
    unexpired and CURRENT — else 410."""
    read = card_links.read_token(token)
    if read is None:
        raise HTTPException(status_code=410, detail=LINK_GONE)
    sponsor_id, version = read
    billing = db.get(SponsorBilling, sponsor_id)
    if billing is None or (billing.card_link_version or 0) != version:
        raise HTTPException(status_code=410, detail=LINK_GONE)
    sponsor = db.get(Sponsor, sponsor_id)
    sub_id = billing.stripe_subscription_id or (sponsor.stripe_subscription_id if sponsor else None)
    if sponsor is None or not sub_id:
        raise HTTPException(status_code=410, detail=LINK_GONE)
    return sponsor, billing, sub_id


@router.get("/card/{token}")
async def open_card_link(token: str, db: Session = Depends(get_db)) -> RedirectResponse:
    key = _secret_key()
    _sponsor, billing, sub_id = _live_link(db, token)
    async with stripe_quotes.make_client(key) as client:
        try:
            try:
                await stripe_billing.move_card_to_customer(client, sub_id)
            except StripeApiError as exc:
                # The portal still saves the card; log the failed move so a
                # rep can see why a renewal kept charging the old one.
                logger.warning("card link: card move failed for %s: %s", sub_id, exc.message)
            customer = billing.stripe_customer_id
            if not customer:
                sub = await stripe_billing.get_subscription(client, sub_id)
                customer = sub.get("customer")
                customer = customer.get("id") if isinstance(customer, dict) else customer
            config = await stripe_billing.ensure_portal_configuration(client)
            url = await stripe_billing.card_update_session(
                client, customer, config, card_links.done_url(token)
            )
        except StripeApiError as exc:
            logger.error("card link: portal failed for %s: %s", sub_id, exc.message)
            raise HTTPException(
                status_code=502,
                detail="We couldn't open the card page right now — try again in a minute.",
            ) from exc
    if customer and not billing.stripe_customer_id:
        billing.stripe_customer_id = customer
        db.commit()
    return RedirectResponse(url, status_code=302, headers=_NO_STORE)


def _audited(db: Session, sponsor_id: uuid.UUID, version: int) -> bool:
    detail = f"card link v{version} used"
    return (
        db.query(BillingAudit.id)
        .filter(
            BillingAudit.sponsor_id == sponsor_id,
            BillingAudit.action == "card_updated",
            BillingAudit.detail == detail,
        )
        .first()
        is not None
    )


async def _customer_card_id(client: httpx.AsyncClient, billing: SponsorBilling, sub_id: str) -> str:
    """The customer's CURRENT default payment method id (what the portal just
    wrote), or ``"none"`` — read right before paying, so it names the card the
    attempt is for."""
    customer = billing.stripe_customer_id
    if not customer:
        customer = _object_id(
            (await stripe_billing.get_subscription(client, sub_id)).get("customer")
        )
    row = await _call(client, "GET", f"/v1/customers/{stripe_billing.checked_id('cus', customer)}")
    pm = _object_id((row.get("invoice_settings") or {}).get("default_payment_method"))
    return pm if isinstance(pm, str) and pm else "none"


@router.get("/card/{token}/done")
async def card_link_done(token: str, db: Session = Depends(get_db)) -> RedirectResponse:
    key = _secret_key()
    sponsor, billing, sub_id = _live_link(db, token)
    version = billing.card_link_version
    async with stripe_quotes.make_client(key) as client:
        try:
            # Keyed per link version AND card: a reload on the same card is
            # answered from Stripe's record of the first attempt (never a
            # second payment), while a customer who comes back with a NEW card
            # after a decline gets a fresh key — a version-only key would
            # replay the stored 402 for Stripe's 24 h key lifetime.
            card = await _customer_card_id(client, billing, sub_id)
            invoice = await stripe_billing.pay_oldest_open_invoice(
                client, sub_id, f"card-done:{sponsor.id}:{version}:{card}"
            )
        except StripeApiError as exc:
            # A decline on the new card (or a replayed decline) is Stripe's to
            # retry; the customer has done their part either way.
            logger.info("card link done: pay attempt for %s: %s", sub_id, exc.message)
            invoice = None
    if invoice is not None:
        row = billing_mirror.upsert_payment_from_invoice(db, invoice)
        if row is not None and row.sponsor_id is None:
            row.sponsor_id = sponsor.id
    if not _audited(db, sponsor.id, version):
        billing_mirror.audit(
            db,
            "system:card-link",
            "card_updated",
            sponsor_id=sponsor.id,
            amount_cents=(invoice or {}).get("amount_paid") if invoice else None,
            detail=f"card link v{version} used",
        )
    db.commit()
    return RedirectResponse(
        f"{settings.APP_BASE_URL.rstrip('/')}/join?card=updated",
        status_code=302,
        headers=_NO_STORE,
    )
