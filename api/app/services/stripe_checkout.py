"""Self-serve checkout — Stripe Checkout Sessions for Silver, Gold and Platinum.

The buyer's job on our side is small: choose a placement (and maybe type a
rep's code); the server prices it (``sales_pricing``, the one rule), records
the attempt as a ``checkout_intents`` row, and hands back a Stripe-hosted
Checkout Session URL. Payment, card data, address collection and tax all
happen on Stripe's page — the SPA never grows a payment surface.

For Gold and Platinum the intent IS the slot hold (``checkout_intents``); for
Silver it is a record only (the board holds five and the route checks
capacity). Either way the sponsor row is created by the WEBHOOK when
``checkout.session.completed`` arrives (services/stripe_webhook.py), which finds
the intent through ``metadata.intent_id`` — a session that never completes
leaves nothing on a board.

The session contract (spec §7, all tiers): ``mode=subscription``, the tier's
two prices, ONE ``amount_off`` coupon when the price is under list (never
promotion codes, never two discounts), card only (R10), automatic tax,
required billing address, ``customer_email`` (or the bound company's
``customer`` for an R7 code), Stripe ``expires_at`` ten minutes before the
hold lapses, and ``managed_by``/``intent_id``/``tier`` metadata on the session
AND the subscription. Minted under ``Idempotency-Key: checkout:{intent_id}``.

Reuses the quote service's Stripe plumbing (client, form encoding, error
shape, price resolution, coupon fence) — one HTTP dialect for billing.
"""

from __future__ import annotations

from datetime import UTC, timedelta
from typing import Any

import httpx

from app.config import settings
from app.models.sales import CheckoutIntent

from . import sales_pricing
from .checkout_intents import HOLD_GRACE_MINUTES, as_utc
from .stripe_billing import MANAGED_BY
from .stripe_quotes import (
    QUOTE_LADDER,
    StripeApiError,
    _call,
    ensure_price_coupon,
    resolve_tier_prices,
)

SILVER_TIER = "silver"


def silver_monthly_usd() -> int:
    """Silver's LIST price — what ``monthly_total`` has always meant. The
    legacy webhook gate and cached pre-Founder bundles read it; the CHARGED
    price is ``sales_pricing.price_usd("silver")`` (the Founder's Deal)."""
    return QUOTE_LADDER[SILVER_TIER][0]


async def create_tier_checkout_session(
    client: httpx.AsyncClient,
    *,
    intent: CheckoutIntent,
    customer_id: str | None,
    success_path: str,
    cancel_path: str,
    extra_metadata: dict[str, str] | None = None,
) -> dict:
    """Mint the hosted Checkout Session for ``intent``; ``{"session_id", "url"}``.

    ``success_path`` / ``cancel_path`` are site-relative (query included); the
    origin is ``settings.APP_BASE_URL``, NEVER the request (the reset-link
    poisoning rule). ``customer_id`` is an R7 bound company's existing Stripe
    customer; without one the session creates a customer from the intent's
    email. ``extra_metadata`` rides beside the contract keys (Silver's
    placement label, for a readable Stripe dashboard); it can never override
    them."""
    tier = intent.tier
    prices = await resolve_tier_prices(client, tier)
    base = settings.APP_BASE_URL.rstrip("/")

    metadata: dict[str, str] = dict(extra_metadata or {})
    metadata.update({"managed_by": MANAGED_BY, "intent_id": str(intent.id), "tier": tier})

    # Stripe's own expiry lands HOLD_GRACE_MINUTES before the hold lapses
    # (SA-F14), so a hold can never lapse under a still-payable session.
    stripe_expiry = as_utc(intent.expires_at) - timedelta(minutes=HOLD_GRACE_MINUTES)

    body: dict[str, Any] = {
        "mode": "subscription",
        "line_items": [{"price": p["id"], "quantity": 1} for p in prices],
        "payment_method_types": ["card"],
        "automatic_tax": {"enabled": True},
        "billing_address_collection": "required",
        "expires_at": int(stripe_expiry.astimezone(UTC).timestamp()),
        "metadata": metadata,
        "subscription_data": {"metadata": metadata},
        "success_url": f"{base}{success_path}",
        "cancel_url": f"{base}{cancel_path}",
    }
    list_price = sales_pricing.list_usd(tier)
    if intent.price_usd < list_price:
        coupon = await ensure_price_coupon(
            client,
            tier,
            int(intent.price_usd),
            [p["product"] for p in prices],
            name=sales_pricing.coupon_name(tier, int(intent.price_usd)),
        )
        body["discounts"] = [{"coupon": coupon}]
    if customer_id:
        body["customer"] = customer_id
        body["customer_update"] = {"address": "auto", "name": "auto"}
    elif intent.email:
        # Rides the form body (``_flatten`` → httpx ``data=``), so a ``+`` in a
        # plus-addressed AP inbox is percent-encoded, never a space.
        body["customer_email"] = intent.email

    session = await _call(
        client,
        "POST",
        "/v1/checkout/sessions",
        body,
        idempotency_key=f"checkout:{intent.id}",
    )
    url = session.get("url")
    if not url:
        raise StripeApiError("Stripe returned a session without a URL", status=502)
    return {"session_id": session.get("id"), "url": url}


async def create_silver_checkout_session(
    client: httpx.AsyncClient,
    *,
    intent: CheckoutIntent,
    placement_label: str,
    return_path: str,
) -> dict:
    """The Silver session: the board the buyer stood on is both return pages —
    success with ``?welcome=silver`` so the board can greet them. Keeps the
    legacy placement metadata (``self_serve``, company, placement) beside the
    contract keys so a Silver sale still reads plainly in Stripe; the webhook
    routes on ``intent_id`` first."""
    extra: dict[str, str] = {
        "self_serve": SILVER_TIER,
        "company_name": intent.company_name,
        "placement_label": placement_label,
    }
    if intent.category_id is not None:
        extra["category_id"] = str(intent.category_id)
    if intent.keyword:
        extra["keyword"] = intent.keyword
    if intent.website:
        extra["website"] = intent.website
    return await create_tier_checkout_session(
        client,
        intent=intent,
        customer_id=None,
        success_path=f"{return_path}?welcome=silver",
        cancel_path=return_path,
        extra_metadata=extra,
    )
