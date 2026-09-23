"""The Stripe ops layer behind the rep billing console, the checkout
follow-ups and the dunning sweep (spec §5, §8, §9, §10).

Plain async functions over the same raw-httpx client as the quote service
(``stripe_quotes.make_client`` — pinned to ``2026-07-29.dahlia``). Each takes
the client first and returns Stripe's own objects; no DB access here, so the
routes, the webhook background tasks and the sweep compose them freely.

Rules every function keeps:

* **Ids are validated before they reach a path** (``checked_id``) — an id
  like ``sub_../../v1/charges`` never gets interpolated into a URL.
* **Query strings only through ``params=``** (the encoding lesson).
* **Every console/sweep POST carries an ``Idempotency-Key``**: the caller's
  (a UUID minted once per confirm dialog, or ``conflict-refund:{intent}:…``)
  or, where the operation has a natural identity (voiding one invoice,
  moving one card), a deterministic key. Stripe prunes keys after 24 h, so
  the steps that the hourly sweep can retry later ALSO treat Stripe's
  "already done" answers as success: an already-canceled subscription, an
  already-refunded charge, an already-expired session.
* **Dahlia shapes** (§5): an invoice's PaymentIntent is reachable only via
  ``/v1/invoice_payments``; the period end lives on ``items.data[]``; a
  scheduled cancel is ``cancel_at_period_end`` OR ``cancel_at``; the next
  charge comes from ``POST /v1/invoices/create_preview``; a discount names its
  coupon at ``source.coupon``; clearing discounts is the literal ``discounts=``.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime
from typing import Any

import httpx

from .stripe_quotes import StripeApiError, _call, _object_id

logger = logging.getLogger(__name__)

MANAGED_BY = "circuits-com"

STRIPE_ID = {
    "sub": r"^sub_[A-Za-z0-9]{8,64}$",
    "in": r"^in_[A-Za-z0-9]{8,64}$",
    "cus": r"^cus_[A-Za-z0-9]{8,64}$",
    "cs": r"^cs_(test|live)_[A-Za-z0-9]{8,128}$",
}
_STRIPE_ID_RE = {kind: re.compile(pattern) for kind, pattern in STRIPE_ID.items()}

# Stripe lists cap at 100 per page.
_PAGE = 100


def checked_id(kind: str, value: str) -> str:
    """``value`` when it is a well-formed Stripe id of ``kind``; else
    StripeApiError 422. ``fullmatch`` so a trailing newline never slips past
    ``$``."""
    pattern = _STRIPE_ID_RE.get(kind)
    if pattern is None or not isinstance(value, str) or not pattern.fullmatch(value):
        raise StripeApiError(f"malformed Stripe {kind} id", status=422)
    return value


def period_end(sub: dict) -> int | None:
    """When the current period ends: the latest item's ``current_period_end``
    (the field moved off the subscription onto its items in basil)."""
    ends = [
        item.get("current_period_end")
        for item in ((sub.get("items") or {}).get("data") or [])
        if isinstance(item.get("current_period_end"), int)
    ]
    return max(ends) if ends else None


def cancel_scheduled(sub: dict) -> bool:
    """A cancel is scheduled when ``cancel_at_period_end`` is set OR a
    ``cancel_at`` exists — under flexible billing mode the second can be set
    alone."""
    return bool(sub.get("cancel_at_period_end")) or sub.get("cancel_at") is not None


def _sub_path(sub_id: str) -> str:
    return f"/v1/subscriptions/{checked_id('sub', sub_id)}"


def _coupon_ids(sub: dict) -> set[str]:
    """Coupon ids on an EXPANDED ``discounts`` list (dahlia ``source.coupon``;
    the older top-level ``coupon`` is read too, id or object)."""
    found: set[str] = set()
    for discount in sub.get("discounts") or []:
        if not isinstance(discount, dict):
            raise StripeApiError("subscription discounts were not expanded", status=502)
        coupon = (discount.get("source") or {}).get("coupon") or discount.get("coupon")
        coupon = _object_id(coupon)
        if coupon:
            found.add(coupon)
    return found


# ── reads ───────────────────────────────────────────────────────────────────


async def get_subscription(client: httpx.AsyncClient, sub_id: str) -> dict:
    return await _call(client, "GET", _sub_path(sub_id))


async def list_invoices(
    client: httpx.AsyncClient, sub_id: str, status: str | None = None, limit: int = 24
) -> list[dict]:
    """The subscription's invoices, newest first (one page, ``limit`` ≤ 100)."""
    params: dict[str, Any] = {"subscription": checked_id("sub", sub_id), "limit": limit}
    if status:
        params["status"] = status
    listing = await _call(client, "GET", "/v1/invoices", params=params)
    return list(listing.get("data") or [])


async def _all_invoices(client: httpx.AsyncClient, sub_id: str, status: str) -> list[dict]:
    """Every invoice in ``status`` for the subscription, across pages."""
    rows: list[dict] = []
    params: dict[str, Any] = {
        "subscription": checked_id("sub", sub_id),
        "status": status,
        "limit": _PAGE,
    }
    while True:
        listing = await _call(client, "GET", "/v1/invoices", params=params)
        page = list(listing.get("data") or [])
        rows.extend(page)
        if not listing.get("has_more") or not page:
            return rows
        params = {**params, "starting_after": page[-1]["id"]}


async def list_overdue_send_invoice_invoices(
    client: httpx.AsyncClient, due_before: datetime
) -> list[dict]:
    """Every OPEN ``send_invoice`` invoice due before ``due_before``, across
    the whole account — ONE paginated list (the sweep and Needs attention ask
    once, not once per invoiced sponsor). The caller maps each invoice to its
    subscription (``billing_mirror.invoice_subscription_id``)."""
    rows: list[dict] = []
    params: dict[str, Any] = {
        "status": "open",
        "collection_method": "send_invoice",
        "due_date[lt]": int(due_before.timestamp()),
        "limit": _PAGE,
    }
    while True:
        listing = await _call(client, "GET", "/v1/invoices", params=params)
        page = list(listing.get("data") or [])
        rows.extend(page)
        if not listing.get("has_more") or not page:
            return rows
        params = {**params, "starting_after": page[-1]["id"]}


async def invoice_payment_intent(client: httpx.AsyncClient, invoice_id: str) -> str:
    """The PaymentIntent that paid ``invoice_id``.

    Dahlia invoices carry no ``payment_intent``/``charge``; the payment hangs
    off ``/v1/invoice_payments``. A payment that is not a PaymentIntent (an
    out-of-band or legacy charge) is refused 409 ``unsupported_payment`` — the
    console refunds PaymentIntents only. No paid payment at all is 409
    ``no_paid_payment``."""
    listing = await _call(
        client,
        "GET",
        "/v1/invoice_payments",
        params={"invoice": checked_id("in", invoice_id), "status": "paid"},
    )
    rows = list(listing.get("data") or [])
    if not rows:
        raise StripeApiError(
            f"invoice {invoice_id} has no paid payment", status=409, code="no_paid_payment"
        )
    payment = rows[0].get("payment") or {}
    pi = payment.get("payment_intent")
    if payment.get("type") != "payment_intent" or not pi:
        raise StripeApiError(
            f"invoice {invoice_id} was paid by {payment.get('type') or 'an unknown method'}, "
            "which the console cannot refund",
            status=409,
            code="unsupported_payment",
        )
    return _object_id(pi)


async def preview_next(client: httpx.AsyncClient, sub_id: str) -> dict | None:
    """The next invoice as Stripe would build it now (amount, discounts, tax);
    None when nothing is upcoming (a canceled subscription)."""
    try:
        return await _call(
            client,
            "POST",
            "/v1/invoices/create_preview",
            {"subscription": checked_id("sub", sub_id)},
        )
    except StripeApiError as exc:
        if exc.status == 400 and (
            exc.code == "invoice_upcoming_none" or "no upcoming invoice" in exc.message.lower()
        ):
            return None
        raise


async def default_card(client: httpx.AsyncClient, customer_id: str) -> dict | None:
    """``{"brand", "last4", "exp_month", "exp_year"}`` of the CUSTOMER's
    default card (R14: the card lives on the customer), or None."""
    customer = await _call(
        client,
        "GET",
        f"/v1/customers/{checked_id('cus', customer_id)}",
        params={"expand[]": ["invoice_settings.default_payment_method"]},
    )
    pm = (customer.get("invoice_settings") or {}).get("default_payment_method")
    if isinstance(pm, str) and pm:
        pm = await _call(client, "GET", f"/v1/payment_methods/{_pm_id(pm)}")
    if not isinstance(pm, dict):
        return None
    card = pm.get("card")
    if pm.get("type") != "card" or not isinstance(card, dict):
        return None
    return {
        "brand": card.get("brand"),
        "last4": card.get("last4"),
        "exp_month": card.get("exp_month"),
        "exp_year": card.get("exp_year"),
    }


async def search_sponsor_subscriptions(client: httpx.AsyncClient, sponsor_id: str) -> list[dict]:
    """Non-canceled subscriptions stamped with ``metadata.sponsor_id`` (the R13
    lookup for a rep-quoted row that has no stored id).

    ``sponsor_id`` must be a UUID — it is interpolated into Stripe's search
    query language, where a quote would end the string. Search is eventually
    consistent (under a minute, longer during outages); the caller stores a
    match only when exactly one comes back."""
    try:
        sponsor_uuid = str(uuid.UUID(str(sponsor_id)))
    except (ValueError, AttributeError, TypeError):
        raise StripeApiError("malformed sponsor id", status=422) from None
    listing = await _call(
        client,
        "GET",
        "/v1/subscriptions/search",
        params={
            "query": f"metadata['sponsor_id']:'{sponsor_uuid}' AND -status:'canceled'",
            "limit": _PAGE,
        },
    )
    return [s for s in listing.get("data") or [] if s.get("status") != "canceled"]


# ── writes ──────────────────────────────────────────────────────────────────


async def refund_invoice(
    client: httpx.AsyncClient, invoice_id: str, amount_cents: int | None, idempotency_key: str
) -> dict | None:
    """Refund the payment behind ``invoice_id`` — ``amount_cents`` of it, or
    whatever is left when None. Returns the Refund, or None when the charge
    was already fully refunded (``charge_already_refunded`` is success: the
    sweep's hourly retry can outlive the 24 h idempotency key).

    Stripe itself refuses an amount above the unrefunded remainder (400).
    Ownership — that the invoice belongs to THIS sponsor's subscription — is
    the caller's check."""
    if amount_cents is not None and (
        isinstance(amount_cents, bool) or not isinstance(amount_cents, int) or amount_cents <= 0
    ):
        raise StripeApiError("refund amount must be a positive number of cents", status=422)
    checked_id("in", invoice_id)
    pi = await invoice_payment_intent(client, invoice_id)
    body: dict[str, Any] = {"payment_intent": pi}
    if amount_cents is not None:
        body["amount"] = amount_cents
    try:
        return await _call(client, "POST", "/v1/refunds", body, idempotency_key=idempotency_key)
    except StripeApiError as exc:
        if exc.code == "charge_already_refunded":
            return None
        raise


async def cancel_now(client: httpx.AsyncClient, sub_id: str, idempotency_key: str) -> dict:
    """Cancel immediately, without a final invoice or proration
    (``invoice_now=false``, ``prorate=false``). An already-canceled
    subscription is success: its current state is returned.

    ``DELETE`` is idempotent by definition and Stripe documents keys on it as
    having no effect, so ``idempotency_key`` is accepted for a uniform console
    signature but not sent; the already-canceled rule is what makes a retry
    safe. The caller voids open invoices separately (``void_open_invoices``)."""
    path = _sub_path(sub_id)
    try:
        return await _call(
            client, "DELETE", path, params={"invoice_now": "false", "prorate": "false"}
        )
    except StripeApiError as exc:
        if exc.status == 400 and "already canceled" in exc.message.lower():
            sub = await _call(client, "GET", path)
            if sub.get("status") == "canceled":
                return sub
        raise


async def set_period_end_cancel(
    client: httpx.AsyncClient, sub_id: str, cancel: bool, idempotency_key: str
) -> dict:
    """Schedule (``cancel=True``) or undo (``False``) a cancel at period end.

    Undo also clears a bare ``cancel_at`` (flexible billing mode schedules
    cancels that way) with a second POST ``cancel_at=""`` — sent separately,
    under its own derived key, because an idempotency key replayed with
    different parameters is an error."""
    path = _sub_path(sub_id)
    sub = await _call(
        client,
        "POST",
        path,
        {"cancel_at_period_end": bool(cancel)},
        idempotency_key=idempotency_key,
    )
    if not cancel and sub.get("cancel_at") is not None:
        sub = await _call(
            client, "POST", path, {"cancel_at": ""}, idempotency_key=f"{idempotency_key}:cancel_at"
        )
    return sub


async def void_open_invoices(client: httpx.AsyncClient, sub_id: str) -> int:
    """Void every OPEN invoice of the subscription; returns how many.

    A canceled subscription's open invoice can still be paid on its hosted
    page (resurrecting the sponsor through ``invoice.paid``) and still counts
    toward reported tax until voided. Each void is keyed ``void:{invoice}``."""
    voided = 0
    for invoice in await _all_invoices(client, sub_id, "open"):
        invoice_id = checked_id("in", invoice.get("id"))
        await _call(
            client,
            "POST",
            f"/v1/invoices/{invoice_id}/void",
            idempotency_key=f"void:{invoice_id}",
        )
        voided += 1
    return voided


async def set_coupon(
    client: httpx.AsyncClient, sub_id: str, coupon_id: str | None, idempotency_key: str
) -> dict:
    """Make ``coupon_id`` the subscription's ONLY discount, or clear every
    discount when None (the literal ``discounts=`` — an empty list would send
    nothing and change nothing). Applies from the next invoice.

    Re-reads the subscription with its discounts expanded and raises
    StripeApiError 502 unless the coupons on it are exactly the ones asked
    for — a "successful" update that left the old discount would bill the
    customer the wrong price forever."""
    path = _sub_path(sub_id)
    body: dict[str, Any] = (
        {"discounts": [{"coupon": coupon_id}]} if coupon_id else {"discounts": ""}
    )
    await _call(client, "POST", path, body, idempotency_key=idempotency_key)
    sub = await _call(client, "GET", path, params={"expand[]": ["discounts"]})
    have = _coupon_ids(sub)
    want = {coupon_id} if coupon_id else set()
    if have != want or (coupon_id is None and sub.get("discounts")):
        raise StripeApiError(
            f"subscription {sub_id} discounts are {sorted(have) or 'none'} after the change "
            f"(expected {sorted(want) or 'none'})",
            status=502,
        )
    return sub


async def pay_oldest_open_invoice(
    client: httpx.AsyncClient, sub_id: str, idempotency_key: str
) -> dict | None:
    """Attempt payment of the subscription's OLDEST open invoice now (the
    retry-payment action and the card link's ``done`` step); None when
    nothing is open. A declined card surfaces as StripeApiError (402)."""
    open_invoices = await _all_invoices(client, sub_id, "open")
    if not open_invoices:
        return None
    oldest = min(open_invoices, key=lambda inv: (inv.get("created") or 0, inv.get("id") or ""))
    invoice_id = checked_id("in", oldest.get("id"))
    return await _call(
        client, "POST", f"/v1/invoices/{invoice_id}/pay", idempotency_key=idempotency_key
    )


async def move_card_to_customer(client: httpx.AsyncClient, sub_id: str) -> bool:
    """R14: move the card Checkout saved on the SUBSCRIPTION to the customer.

    A subscription's own ``default_payment_method`` outranks the customer's,
    and the portal's card update writes the customer's — so until the card
    is moved, a customer who updates their card keeps being charged on the
    old one. Sets ``customer.invoice_settings.default_payment_method`` to it,
    then clears the subscription's field (``""``). False when the
    subscription has no card of its own (nothing to move; already moved)."""
    path = _sub_path(sub_id)
    sub = await _call(client, "GET", path)
    pm = _object_id(sub.get("default_payment_method"))
    if not pm:
        return False
    customer_id = checked_id("cus", _object_id(sub.get("customer")))
    await _call(
        client,
        "POST",
        f"/v1/customers/{customer_id}",
        {"invoice_settings": {"default_payment_method": pm}},
        idempotency_key=f"card-move:{sub_id}:{pm}:customer",
    )
    await _call(
        client,
        "POST",
        path,
        {"default_payment_method": ""},
        idempotency_key=f"card-move:{sub_id}:{pm}:subscription",
    )
    return True


async def ensure_portal_configuration(client: httpx.AsyncClient) -> str:
    """The id of this app's card-update-only Customer Portal configuration,
    created once per account.

    Found by ``metadata.managed_by`` — the list endpoint cannot filter on
    metadata, so it pages every active configuration. Created with exactly
    one feature enabled (``payment_method_update``) and the other four
    disabled, under a fixed idempotency key so two first-time opens cannot
    create two."""
    params: dict[str, Any] = {"active": "true", "limit": _PAGE}
    while True:
        listing = await _call(client, "GET", "/v1/billing_portal/configurations", params=params)
        page = list(listing.get("data") or [])
        for config in page:
            if (config.get("metadata") or {}).get("managed_by") == MANAGED_BY:
                return config["id"]
        if not listing.get("has_more") or not page:
            break
        params = {**params, "starting_after": page[-1]["id"]}
    created = await _call(
        client,
        "POST",
        "/v1/billing_portal/configurations",
        {
            "features": {
                "payment_method_update": {"enabled": True},
                "customer_update": {"enabled": False},
                "invoice_history": {"enabled": False},
                "subscription_cancel": {"enabled": False},
                "subscription_update": {"enabled": False},
            },
            "metadata": {"managed_by": MANAGED_BY},
        },
        idempotency_key="portal-configuration:card-only:v1",
    )
    return created["id"]


async def card_update_session(
    client: httpx.AsyncClient, customer_id: str, config_id: str, return_url: str
) -> str:
    """A short-lived portal URL that opens straight on "update your card"
    and, once done, redirects to ``return_url`` (also the portal's own back
    link). Minted on every open — portal sessions expire quickly."""
    session = await _call(
        client,
        "POST",
        "/v1/billing_portal/sessions",
        {
            "customer": checked_id("cus", customer_id),
            "configuration": config_id,
            "return_url": return_url,
            "flow_data": {
                "type": "payment_method_update",
                "after_completion": {"type": "redirect", "redirect": {"return_url": return_url}},
            },
        },
    )
    url = session.get("url")
    if not url:
        raise StripeApiError("Stripe returned a portal session without a URL", status=502)
    return url


async def expire_checkout_session(client: httpx.AsyncClient, session_id: str) -> None:
    """Expire an open Checkout Session (the buyer's own "back" path and the
    staff Release). A session that is already expired or complete is not an
    error — there is nothing left to expire."""
    path = f"/v1/checkout/sessions/{checked_id('cs', session_id)}"
    try:
        await _call(client, "POST", f"{path}/expire", idempotency_key=f"expire:{session_id}")
    except StripeApiError as exc:
        if exc.status != 400:
            raise
        session = await _call(client, "GET", path)
        if session.get("status") not in ("expired", "complete"):
            raise


async def stamp_customer_supplier(
    client: httpx.AsyncClient, customer_id: str, supplier_id: str
) -> None:
    """Stamp ``metadata.supplier_id`` on a Checkout-created customer, so the
    quote flow's per-supplier lookup finds it instead of minting another."""
    await _call(
        client,
        "POST",
        f"/v1/customers/{checked_id('cus', customer_id)}",
        {"metadata": {"supplier_id": str(supplier_id), "managed_by": MANAGED_BY}},
        idempotency_key=f"stamp-supplier:{customer_id}:{supplier_id}",
    )


_PM_RE = re.compile(r"^(pm|card|src)_[A-Za-z0-9]{6,64}$")


def _pm_id(value: str) -> str:
    if not _PM_RE.fullmatch(value):
        raise StripeApiError("malformed Stripe payment method id", status=502)
    return value
