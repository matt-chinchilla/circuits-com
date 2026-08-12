"""Self-serve Silver checkout — Stripe Checkout Sessions for open board slots.

The buying moment happens ON the slot (the Silver board's "Advertise here"
rows), so this service's job is small: turn a chosen placement plus a company
name into a Stripe-hosted Checkout Session and hand back its URL. Payment,
card data, address collection and tax all happen on Stripe's page — the SPA
never grows a payment surface.

Only MULTI-OCCUPANT placements are sold this way (Silver on a subcategory;
keyword later). Platinum and Gold are single-slot — two buyers racing for one
slot means a refund and an apology — so their boards keep routing to the
partners desk and the rep-driven quote flow (services/stripe_quotes.py).

The sponsor row is created by the WEBHOOK when `checkout.session.completed`
arrives (services/stripe_webhook.py) — not here. A session that never
completes must leave nothing behind, and the webhook is already the single
place billing events become board state.

Reuses the quote service's Stripe plumbing (client, form encoding, error
shape, price resolution) — one HTTP dialect for the whole billing surface.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.config import settings

from .stripe_quotes import (
    QUOTE_LADDER,
    StripeApiError,
    _call,
    _resolve_prices,
)

SILVER_TIER = "silver"

# What the confirm panel shows and what the session must total. Single home is
# the quote ladder's list price — the panel, the ladder and Stripe's page can
# not drift apart.
def silver_monthly_usd() -> int:
    return QUOTE_LADDER[SILVER_TIER][0]


async def create_silver_checkout_session(
    client: httpx.AsyncClient,
    *,
    category_id: str | None,
    keyword: str | None,
    placement_label: str,
    company_name: str,
    website: str | None,
    return_path: str,
) -> dict:
    """Create + return a hosted Checkout Session for one Silver placement.

    ``return_path`` is the site-relative page the buyer left (the category
    page); success and cancel both land back on it — success with a
    ``?welcome=silver`` flag so the board can greet them. The origin comes
    from settings.APP_BASE_URL, NEVER from the request (the reset-link
    poisoning rule).
    """
    price_ids = await _resolve_prices(client, SILVER_TIER)
    base = settings.APP_BASE_URL.rstrip("/")

    # The webhook rebuilds the sponsor row from this metadata alone, so it
    # carries the placement AND the company identity. sponsor_id does not
    # exist yet — the webhook stamps it onto the subscription after creating
    # the row, closing the loop for renewals and cancellations.
    metadata: dict[str, str] = {
        "managed_by": "circuits-com",
        "self_serve": "silver",
        "company_name": company_name,
        "placement_label": placement_label,
    }
    if category_id:
        metadata["category_id"] = category_id
    if keyword:
        metadata["keyword"] = keyword
    if website:
        metadata["website"] = website

    body: dict[str, Any] = {
        "mode": "subscription",
        "line_items": [{"price": pid, "quantity": 1} for pid in price_ids],
        "automatic_tax": {"enabled": True},
        "billing_address_collection": "required",
        "metadata": metadata,
        "subscription_data": {"metadata": metadata},
        "success_url": f"{base}{return_path}?welcome=silver",
        "cancel_url": f"{base}{return_path}",
    }
    session = await _call(client, "POST", "/v1/checkout/sessions", body)
    url = session.get("url")
    if not url:
        raise StripeApiError("Stripe returned a session without a URL", status=502)
    return {"session_id": session.get("id"), "url": url}
