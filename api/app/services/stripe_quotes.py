"""Sales quotes for sponsorship placements, built server-side over Stripe.

The rep never leaves /admin and never touches the Dashboard: they pick an
ALL-IN monthly price from a fixed ladder, we build the quote, and acceptance
creates the subscription with ``sponsor_id`` already stamped in its metadata —
the webhook's linkage is automatic instead of a thing a human must remember.

Money model (the part that must never drift):

* Every price is ``tax_behavior: inclusive`` — the sticker IS what the
  customer pays; Stripe backs NY tax out of the platform line internally.
* The ladder lists FINAL monthly totals in whole dollars. A discounted step
  becomes an ``amount_off`` coupon (list − target), which on inclusive prices
  lands the total on the target EXACTLY — the explicit requirement is that a
  quote saying $1,250 never collects $1,328.54. Percent coupons are not used
  here for the same reason: arbitrary targets need ugly fractions.
* After finalizing we CHECK ``amount_total`` against the target and cancel
  the quote on any mismatch — a wrong quote must die server-side, not reach
  a customer.

Coupons are minted lazily with deterministic ids (``GOLD-AT-450``) and fenced
to the tier's two products; a pre-existing id is reused only after verifying
its ``amount_off`` — a hand-made coupon wearing our name but the wrong amount
is an error, not a convenience.

Plain ``httpx`` against the REST API (form-encoded, bracket notation). No
Stripe SDK — the webhook consumer set that precedent, and the four calls here
don't justify a dependency the container would carry forever.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

STRIPE_API = "https://api.stripe.com"
STRIPE_FILES = "https://files.stripe.com"

# All-in monthly targets, in DOLLARS. First entry is the list price (quoted
# with no coupon); the floors are the sanctioned standard discounts. ONE home —
# the route validates against this and the UI renders it; add a step here and
# both sides learn it.
# Repriced 2026-08-22 (owner): 100/600/2400 -> 250/2500/10000. The Stripe
# prices behind the lookup keys were REPLACED to match (unit_amount is
# immutable, so new price objects took the keys and the old ones were
# archived) — this table and Stripe must move together or the webhook's
# amount gate rejects every real payment.
QUOTE_LADDER: dict[str, list[int]] = {
    "silver": [250, 225, 200, 175, 150, 125],
    "gold": [2500, 2250, 2000, 1750, 1500, 1250],
    "platinum": [10000, 9000, 8000, 7000, 6000, 5000],
}

_TIER_PRODUCTS = {
    "silver": ["prod_V2iufhsxXRZsKu", "prod_V2iuG4nXD5c4Dt"],
    "gold": ["prod_V3588YvzTwOBa5", "prod_V358Y0EQ7on2Qv"],
    "platinum": ["prod_V358MQ3Qi9JV26", "prod_V358iY5Odq6k5f"],
}


def lookup_keys_for(tier: str) -> list[str]:
    return [f"{tier}_advertising_monthly", f"{tier}_platform_monthly"]


class StripeApiError(Exception):
    """A Stripe call failed; ``message`` is safe to surface to the admin UI."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


def make_client(secret_key: str, transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    """One client for both api.stripe.com and files.stripe.com (absolute URLs
    override base_url). ``transport`` exists for tests — MockTransport plays
    Stripe without a network."""
    return httpx.AsyncClient(
        base_url=STRIPE_API,
        headers={"Authorization": f"Bearer {secret_key}"},
        timeout=20.0,
        transport=transport,
    )


def _flatten(data: dict[str, Any], prefix: str = "") -> dict[str, str]:
    """Stripe's form encoding: nested dicts/lists become bracket notation
    (``subscription_data[metadata][sponsor_id]``, ``line_items[0][price]``)."""
    flat: dict[str, str] = {}
    for key, value in data.items():
        name = f"{prefix}[{key}]" if prefix else str(key)
        if isinstance(value, dict):
            flat.update(_flatten(value, name))
        elif isinstance(value, list):
            for i, item in enumerate(value):
                if isinstance(item, dict):
                    flat.update(_flatten(item, f"{name}[{i}]"))
                else:
                    flat[f"{name}[{i}]"] = str(item)
        elif isinstance(value, bool):
            flat[name] = "true" if value else "false"
        elif value is not None:
            flat[name] = str(value)
    return flat


async def _call(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    data: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> dict:
    """``params`` is the ONLY way a query string gets built here — httpx then
    percent-encodes values. An f-string would ship ``+`` verbatim (Stripe
    decodes it as a SPACE, so ``billing+ap@acme.com`` never matches) and would
    let ``&``/``#`` in a stored value inject or truncate the query."""
    try:
        resp = await client.request(
            method, url, data=_flatten(data) if data else None, params=params
        )
    except httpx.HTTPError as exc:
        raise StripeApiError(f"could not reach Stripe ({type(exc).__name__})") from exc
    body: dict = {}
    try:
        body = resp.json()
    except ValueError:
        pass
    if resp.status_code >= 400:
        err = body.get("error", {}) if isinstance(body, dict) else {}
        raise StripeApiError(
            err.get("message") or f"Stripe returned {resp.status_code}",
            status=resp.status_code,
        )
    return body


async def _resolve_prices(client: httpx.AsyncClient, tier: str) -> list[str]:
    keys = lookup_keys_for(tier)
    listing = await _call(
        client, "GET", "/v1/prices", params={"lookup_keys[]": keys, "active": "true"}
    )
    by_key = {p.get("lookup_key"): p["id"] for p in listing.get("data", [])}
    missing = [k for k in keys if k not in by_key]
    if missing:
        raise StripeApiError(f"active price not found for {', '.join(missing)}", status=422)
    return [by_key[k] for k in keys]


async def _find_supplier_customer(
    client: httpx.AsyncClient, *, email: str, supplier_id: str
) -> str | None:
    """This SUPPLIER's customer under this email, or None.

    Matched on ``metadata.supplier_id``, never on email alone: two suppliers
    legitimately share a billing inbox (a parent company's AP address), and an
    email-only match would overwrite one company's name and identity with the
    other's on every quote. Each supplier gets its own Stripe customer."""
    existing = await _call(client, "GET", "/v1/customers", params={"email": email, "limit": 10})
    for row in existing.get("data", []):
        if (row.get("metadata") or {}).get("supplier_id") == supplier_id:
            return row["id"]
    return None


async def _find_or_create_customer(
    client: httpx.AsyncClient,
    *,
    name: str,
    email: str,
    address: dict[str, str],
    supplier_id: str,
) -> str:
    """Reuse this supplier's own customer, else create one. The address is
    (re)written on reuse — Stripe Tax needs a current location, and the
    modal's address is fresher than whatever a past quote stored."""
    payload = {
        "name": name,
        "email": email,
        "address": {**address, "country": "US"},
        "metadata": {"supplier_id": supplier_id, "managed_by": "circuits-com"},
    }
    customer_id = await _find_supplier_customer(client, email=email, supplier_id=supplier_id)
    if customer_id is not None:
        await _call(client, "POST", f"/v1/customers/{customer_id}", payload)
        return customer_id
    created = await _call(client, "POST", "/v1/customers", payload)
    return created["id"]


async def _ensure_ladder_coupon(client: httpx.AsyncClient, tier: str, target_usd: int) -> str:
    """Deterministic per-step coupon, verified on reuse."""
    list_usd = QUOTE_LADDER[tier][0]
    off_cents = (list_usd - target_usd) * 100
    coupon_id = f"{tier.upper()}-AT-{target_usd}"
    try:
        await _call(
            client,
            "POST",
            "/v1/coupons",
            {
                "id": coupon_id,
                "amount_off": off_cents,
                "currency": "usd",
                "duration": "forever",
                "name": f"{tier.capitalize()} Sponsorship — ${target_usd}/mo all-in",
                "applies_to": {"products": _TIER_PRODUCTS[tier]},
                "metadata": {"tier": tier, "managed_by": "circuits-com"},
            },
        )
        return coupon_id
    except StripeApiError as exc:
        if exc.status != 400 or "already exists" not in exc.message.lower():
            raise
    # Verify EVERY field the price depends on, not just the amount. The trap
    # is duration: Stripe defaults it to "once", so a hand-made coupon with
    # the right amount_off would discount the FIRST invoice only and silently
    # revert every renewal to list price.
    existing = await _call(client, "GET", f"/v1/coupons/{coupon_id}")
    mismatches = [
        f"{field}={existing.get(field)!r} (expected {want!r})"
        for field, want in (
            ("amount_off", off_cents),
            ("duration", "forever"),
            ("currency", "usd"),
        )
        if existing.get(field) != want
    ]
    if mismatches:
        raise StripeApiError(
            f"coupon {coupon_id} exists but does not match the ladder "
            f"({'; '.join(mismatches)}) — resolve it in the Dashboard",
            status=409,
        )
    return coupon_id


async def create_sponsor_quote(
    client: httpx.AsyncClient,
    *,
    sponsor_id: str,
    tier: str,
    supplier_id: str,
    supplier_name: str,
    email: str,
    address: dict[str, str],
    monthly_total_usd: int,
) -> dict:
    """Build + finalize a quote whose total IS ``monthly_total_usd``, exactly.

    Returns quote id/number/total/customer. Raises StripeApiError on any
    failure, including the self-check: a finalized total that differs from
    the target cancels the quote and errors — it must never reach a customer.
    """
    tier_key = (tier or "").strip().lower()
    if tier_key not in QUOTE_LADDER:
        raise StripeApiError(f"tier {tier!r} has no quote ladder", status=422)
    if monthly_total_usd not in QUOTE_LADDER[tier_key]:
        raise StripeApiError(
            f"${monthly_total_usd}/mo is not on the {tier_key} ladder", status=422
        )

    price_ids = await _resolve_prices(client, tier_key)
    customer_id = await _find_or_create_customer(
        client, name=supplier_name, email=email, address=address, supplier_id=supplier_id
    )

    quote_body: dict[str, Any] = {
        "customer": customer_id,
        "line_items": [{"price": pid, "quantity": 1} for pid in price_ids],
        "automatic_tax": {"enabled": True},
        "collection_method": "send_invoice",
        "invoice_settings": {"days_until_due": 30},
        "subscription_data": {
            "metadata": {"sponsor_id": sponsor_id, "managed_by": "circuits-com"}
        },
        "header": f"Circuit Center — {tier_key.capitalize()} Sponsorship",
        "metadata": {"sponsor_id": sponsor_id, "managed_by": "circuits-com"},
    }
    if monthly_total_usd < QUOTE_LADDER[tier_key][0]:
        coupon_id = await _ensure_ladder_coupon(client, tier_key, monthly_total_usd)
        quote_body["discounts"] = [{"coupon": coupon_id}]

    draft = await _call(client, "POST", "/v1/quotes", quote_body)
    finalized = await _call(client, "POST", f"/v1/quotes/{draft['id']}/finalize")

    expected_cents = monthly_total_usd * 100
    if finalized.get("amount_total") != expected_cents:
        # The cancel is best-effort and must never MASK the mismatch: if it
        # fails, a finalized, wrongly-priced quote is sitting live in Stripe,
        # and the error the rep sees has to say so by id — a bare
        # "could not reach Stripe" reads as "nothing happened, retry".
        try:
            await _call(client, "POST", f"/v1/quotes/{draft['id']}/cancel")
            cancel_note = "quote canceled, nothing was sent"
        except StripeApiError as exc:
            cancel_note = (
                f"AND the cancel failed ({exc.message}) — quote {draft['id']} is "
                "still OPEN in Stripe with the wrong total; cancel it in the Dashboard"
            )
        logger.error(
            "stripe quotes: finalized total %s != expected %s for sponsor %s (%s)",
            finalized.get("amount_total"),
            expected_cents,
            sponsor_id,
            cancel_note,
        )
        raise StripeApiError(
            f"finalized total {finalized.get('amount_total')} ≠ quoted "
            f"{expected_cents} — {cancel_note}",
            status=502,
        )

    return {
        "quote_id": finalized["id"],
        "number": finalized.get("number"),
        "amount_total": finalized["amount_total"],
        "customer_id": customer_id,
        "status": finalized.get("status"),
    }


async def accept_quote(client: httpx.AsyncClient, quote_id: str) -> dict:
    """Mark the quote accepted — Stripe creates the subscription (metadata
    included) and its first send_invoice invoice in the same stroke.

    Only quotes THIS app built are acceptable through it: the metadata stamp
    is checked first, so a quote id pasted from anywhere else cannot be
    committed into a subscription by this endpoint."""
    quote = await _call(client, "GET", f"/v1/quotes/{quote_id}")
    if (quote.get("metadata") or {}).get("managed_by") != "circuits-com":
        raise StripeApiError(
            f"quote {quote_id} was not created by this app — accept it in the Dashboard",
            status=422,
        )
    accepted = await _call(client, "POST", f"/v1/quotes/{quote_id}/accept")
    return {
        "quote_id": accepted["id"],
        "status": accepted.get("status"),
        "subscription_id": accepted.get("subscription"),
    }


async def list_sponsor_quotes(
    client: httpx.AsyncClient, *, email: str, supplier_id: str, sponsor_id: str
) -> list[dict]:
    """THIS sponsorship's quotes — lets the form page show state after the
    creation modal is long closed.

    Scoped twice: to the supplier's own customer (metadata match, same rule as
    creation), then to rows stamped with this ``sponsor_id``. A supplier holds
    several placements at once (Silver and keyword are multi), all sharing one
    customer — an unfiltered list would render placement A's quote on
    placement B's page, one click from activating the wrong board."""
    customer_id = await _find_supplier_customer(client, email=email, supplier_id=supplier_id)
    if customer_id is None:
        return []
    listing = await _call(
        client, "GET", "/v1/quotes", params={"customer": customer_id, "limit": 100}
    )
    return [
        {
            "quote_id": q["id"],
            "number": q.get("number"),
            "status": q.get("status"),
            "amount_total": q.get("amount_total"),
            "created": q.get("created"),
        }
        for q in listing.get("data", [])
        if (q.get("metadata") or {}).get("sponsor_id") == sponsor_id
    ]


async def quote_pdf(client: httpx.AsyncClient, quote_id: str) -> bytes:
    """The customer-facing PDF (served from files.stripe.com)."""
    try:
        resp = await client.get(f"{STRIPE_FILES}/v1/quotes/{quote_id}/pdf")
    except httpx.HTTPError as exc:
        raise StripeApiError(f"could not reach Stripe ({type(exc).__name__})") from exc
    if resp.status_code >= 400:
        raise StripeApiError(f"Stripe returned {resp.status_code} for the PDF", status=resp.status_code)
    return resp.content
