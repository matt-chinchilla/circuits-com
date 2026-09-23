"""The rep billing console — /api/admin/sponsors/{id}/billing (spec §9, D3).

Everything a rep would otherwise do in the Stripe Dashboard, from the
sponsor's admin page: read the live subscription (status, scheduled cancel,
period end, next charge, card, price and discount, invoices), cancel at
period end / resume / cancel now, refund, change the discount, retry a
payment, and mint a card-update link. Reps never see Stripe.

Rules every route keeps:

* **Walls.** ``require_staff`` on the router (customer 403 ``staff_only``,
  viewer 403 ``read_only`` on every POST); the GET also carries
  ``require_billing_reader`` (viewer 403 ``no_billing_access``, R6).
* **Unconfigured = absent.** ``STRIPE_SECRET_KEY`` unset → 404, checked
  before anything else.
* **One subscription per sponsor (R13).** The stored id (``sponsor_billing``,
  else ``sponsors.stripe_subscription_id``) is the only one acted on. A
  rep-quoted row with none is resolved by Search on ``metadata.sponsor_id``;
  exactly one non-canceled match is STORED (in ``sponsor_billing`` — never on
  ``sponsors``, whose ``updated_at`` feeds the webhook's stale-event gate, R3),
  several answer ``ambiguous_subscription``.
* **Idempotency (LU-F22, SA-F9).** Every Stripe-writing POST requires the
  ``Idempotency-Key`` header — a UUID the confirm dialog mints ONCE — and
  forwards it to Stripe verbatim, so a double-click or a retry is answered
  from Stripe's record instead of acting twice. Missing → 422
  ``idempotency_key_required``.
* **Stripe ids are regex-checked before any path interpolation**
  (``stripe_billing.checked_id``); query strings only via ``params=``.
* **Every action writes ``billing_audit``**; every 4xx ``detail`` is a string.
* **Cancel-now writes the sponsor** (``Expired``) and clears the in-process
  category cache; the client wraps it in ``bustingAfter``.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Sponsor, User
from app.models.sales import BillingAudit, SalesCode, SponsorBilling, SponsorPayment
from app.services import (
    billing_mirror,
    card_links,
    category_cache,
    sales_codes,
    sales_pricing,
    stripe_billing,
    stripe_quotes,
)
from app.services.auth_service import require_billing_reader, require_staff
from app.services.stripe_quotes import StripeApiError, _call

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/admin/sponsors",
    tags=["admin-billing"],
    dependencies=[Depends(require_staff)],
)

# Machine codes (string details; each has a CODE_MESSAGES entry client-side).
IDEMPOTENCY_KEY_REQUIRED = "idempotency_key_required"
AMBIGUOUS_SUBSCRIPTION = "ambiguous_subscription"
NO_SUBSCRIPTION = "no_subscription"
LEGACY_PRICE = "legacy_price"
UNSUPPORTED_PAYMENT = "unsupported_payment"
SEND_INVOICE_CARD_LINK = "This customer pays by emailed invoice — share the invoice link instead."

# A confirm dialog's crypto.randomUUID() fits; so does anything a sane client
# mints. Stripe caps keys at 255 characters.
_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._:\-]{8,200}$")
_COUPON = re.compile(r"^(SILVER|GOLD|PLATINUM)-AT-(\d+)$")
_LIVE_STATUSES = {"active", "trialing", "past_due", "unpaid", "incomplete", "paused"}


# ── helpers ─────────────────────────────────────────────────────────────────


def _secret_key() -> str:
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    if not key:
        raise HTTPException(status_code=404, detail="Not found")
    return key


def _checked_key(value: str | None) -> str:
    key = (value or "").strip()
    if not _IDEMPOTENCY_KEY.fullmatch(key):
        raise HTTPException(status_code=422, detail=IDEMPOTENCY_KEY_REQUIRED)
    return key


def _load_sponsor(db: Session, sponsor_id: str) -> Sponsor:
    try:
        key = uuid.UUID(sponsor_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="Sponsor not found") from None
    sponsor = db.get(Sponsor, key)
    if sponsor is None:
        raise HTTPException(status_code=404, detail="Sponsor not found")
    return sponsor


def _as_http_error(exc: StripeApiError) -> HTTPException:
    """Stripe's answer as a STRING detail the console can show. Our own
    deliberate codes stay machine codes; other 4xx are the rep's to act on
    (422); anything else is upstream weather (502)."""
    if exc.code == UNSUPPORTED_PAYMENT:
        return HTTPException(status_code=409, detail=UNSUPPORTED_PAYMENT)
    if exc.code == "no_paid_payment":
        return HTTPException(status_code=409, detail="That invoice has no payment to refund.")
    if exc.status == 404:
        return HTTPException(status_code=404, detail="Stripe has no such record.")
    out = 422 if 400 <= exc.status < 500 else 502
    return HTTPException(status_code=out, detail=f"stripe: {exc.message}")


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()
    if isinstance(value, int) and not isinstance(value, bool):
        return datetime.fromtimestamp(value, UTC).isoformat()
    return None


def _tier(sponsor: Sponsor) -> str | None:
    t = (sponsor.tier or "").strip().lower()
    return t if t in sales_pricing.TIERS else None


def _require_tier(sponsor: Sponsor) -> str:
    tier = _tier(sponsor)
    if tier is None:
        raise HTTPException(status_code=422, detail="This sponsorship's tier has no price.")
    return tier


def _stored_subscription(sponsor: Sponsor, billing: SponsorBilling | None) -> str | None:
    return (billing.stripe_subscription_id if billing else None) or sponsor.stripe_subscription_id


def _coupon_ids(sub: dict) -> list[str] | None:
    """Coupon ids on the subscription's discounts; None when they were not
    expanded (bare discount ids say nothing about the price)."""
    out = []
    for discount in sub.get("discounts") or []:
        if not isinstance(discount, dict):
            return None
        coupon = (discount.get("source") or {}).get("coupon") or discount.get("coupon")
        coupon = coupon.get("id") if isinstance(coupon, dict) else coupon
        if coupon:
            out.append(coupon)
    return out


def _price_from_sub(tier: str, sub: dict) -> int | None:
    """The monthly price the subscription is on, when we can tell: list with
    no discount, or ``{TIER}-AT-{price}`` from one of our coupons. None for a
    discount we did not mint (e.g. a legacy percentage coupon) or one we
    cannot see (unexpanded)."""
    coupons = _coupon_ids(sub)
    if coupons is None:
        return None
    if not coupons:
        return sales_pricing.list_usd(tier)
    if len(coupons) == 1:
        m = _COUPON.fullmatch(coupons[0])
        if m and m.group(1).lower() == tier:
            return int(m.group(2))
    return None


def _points_for(tier: str, price: int | None) -> int | None:
    """The fewest code points the rule turns into ``price`` (several land on
    the floor); None when no point value does (list price, legacy coupons)."""
    if price is None:
        return None
    for pts in range(sales_pricing.MAX_CODE_POINTS + 1):
        if sales_pricing.price_usd(tier, pts) == price:
            return pts
    return None


def _item_price_ids(sub: dict) -> set[str]:
    ids = set()
    for item in (sub.get("items") or {}).get("data") or []:
        price = item.get("price")
        pid = price.get("id") if isinstance(price, dict) else price
        if pid:
            ids.add(pid)
    return ids


async def _is_legacy_price(client, tier: str, sub: dict) -> bool:
    """True when the subscription's items are not the tier's CURRENT two
    prices (an archived pre-2026-08-22 price, say): the rule's coupons are
    fenced to the current products, so a discount change would not land."""
    current = {p["id"] for p in await stripe_quotes.resolve_tier_prices(client, tier)}
    return _item_price_ids(sub) != current


async def _read_subscription(client, sub_id: str) -> dict:
    """The live subscription with its discounts expanded (the ops layer's
    ``get_subscription`` does not expand)."""
    path = f"/v1/subscriptions/{stripe_billing.checked_id('sub', sub_id)}"
    return await _call(client, "GET", path, params={"expand[]": ["discounts"]})


def _ensure_billing(db: Session, sponsor: Sponsor, sub: dict) -> SponsorBilling:
    """The sponsor's billing row, created from the live subscription when a
    rep-quoted (or pre-057) sponsor has none. Never writes ``sponsors``."""
    billing = db.get(SponsorBilling, sponsor.id)
    customer = sub.get("customer")
    customer = customer.get("id") if isinstance(customer, dict) else customer
    collection = sub.get("collection_method") or "charge_automatically"
    if billing is not None:
        if not billing.stripe_customer_id and customer:
            billing.stripe_customer_id = customer
        if not billing.stripe_subscription_id:
            billing.stripe_subscription_id = sub.get("id")
        return billing
    tier = _require_tier(sponsor)
    price = _price_from_sub(tier, sub)
    if price is None:
        price = int(sponsor.amount) if sponsor.amount is not None else sales_pricing.list_usd(tier)
    return billing_mirror.upsert_billing(
        db,
        sponsor.id,
        stripe_customer_id=customer,
        stripe_subscription_id=sub.get("id"),
        collection_method=collection,
        channel="quote" if collection == "send_invoice" else "self_serve",
        list_usd=sales_pricing.list_usd(tier),
        founder_usd=sales_pricing.founder_usd(tier),
        price_usd=price,
    )


@dataclass
class _Resolved:
    sub_id: str | None
    needs: str | None  # None | "ambiguous_subscription" | "no_subscription"


async def _resolve(db: Session, client, sponsor: Sponsor) -> _Resolved:
    """R13: the stored id, else a Search that stores exactly one match."""
    billing = db.get(SponsorBilling, sponsor.id)
    stored = _stored_subscription(sponsor, billing)
    if stored:
        return _Resolved(stored, None)
    matches = await stripe_billing.search_sponsor_subscriptions(client, str(sponsor.id))
    if len(matches) > 1:
        return _Resolved(None, AMBIGUOUS_SUBSCRIPTION)
    if not matches:
        return _Resolved(None, NO_SUBSCRIPTION)
    sub = matches[0]
    stripe_billing.checked_id("sub", sub.get("id"))
    _ensure_billing(db, sponsor, sub)
    db.commit()
    return _Resolved(sub["id"], None)


async def _acting_subscription(db: Session, client, sponsor: Sponsor) -> str:
    """The subscription an ACTION may touch, or a 409 that says why not."""
    resolved = await _resolve(db, client, sponsor)
    if resolved.needs == AMBIGUOUS_SUBSCRIPTION:
        raise HTTPException(status_code=409, detail=AMBIGUOUS_SUBSCRIPTION)
    if resolved.sub_id is None:
        raise HTTPException(status_code=409, detail="This sponsorship has no Stripe subscription.")
    return resolved.sub_id


def _mirror_rows(db: Session, invoice_ids: list[str]) -> dict[str, SponsorPayment]:
    if not invoice_ids:
        return {}
    rows = db.query(SponsorPayment).filter(SponsorPayment.stripe_invoice_id.in_(invoice_ids))
    return {r.stripe_invoice_id: r for r in rows}


def _invoice_row(invoice: dict, mirror: SponsorPayment | None) -> dict:
    status = invoice.get("status")
    if mirror is not None and mirror.status in (
        billing_mirror.REFUNDED,
        billing_mirror.PARTIALLY_REFUNDED,
    ):
        status = mirror.status
    return {
        "id": invoice.get("id"),
        "number": invoice.get("number"),
        "created": _iso(invoice.get("created")),
        "amount_due_cents": invoice.get("amount_due") or 0,
        "amount_paid_cents": invoice.get("amount_paid") or 0,
        "amount_refunded_cents": (mirror.amount_refunded_cents or 0) if mirror else 0,
        "status": status,
        "hosted_url": invoice.get("hosted_invoice_url"),
        "pdf_url": invoice.get("invoice_pdf"),
        "due_date": _iso(invoice.get("due_date")),
    }


def _grace() -> timedelta:
    return timedelta(days=settings.BILLING_GRACE_DAYS)


# ── the read ────────────────────────────────────────────────────────────────


@router.get("/{sponsor_id}/billing")
async def get_billing(
    sponsor_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_billing_reader),
) -> dict:
    key = _secret_key()
    sponsor = _load_sponsor(db, sponsor_id)
    tier = _tier(sponsor)
    out: dict[str, Any] = {
        "configured": True,
        "subscription_id": None,
        "status": None,
        "collection_method": None,
        "cancel_scheduled": False,
        "cancel_at": None,
        "period_end": None,
        "next_charge": None,
        "card": None,
        "list_usd": sales_pricing.list_usd(tier) if tier else None,
        "founder_usd": sales_pricing.founder_usd(tier) if tier else None,
        "price_usd": None,
        "code_points": None,
        "channel": None,
        "sold_by": sponsor.sold_by,
        "code": None,
        "failing_since": None,
        "cancels_on": None,
        "legacy_price": False,
        "invoices": [],
        "needs_resolution": None,
    }
    async with stripe_quotes.make_client(key) as client:
        try:
            resolved = await _resolve(db, client, sponsor)
            billing = db.get(SponsorBilling, sponsor.id)
            if billing is not None:
                out["channel"] = billing.channel
                out["price_usd"] = billing.price_usd
                out["failing_since"] = _iso(billing.failing_since)
                if billing.sales_code_id:
                    code = db.get(SalesCode, billing.sales_code_id)
                    out["code"] = sales_codes.display_code(code.code) if code else None
            if resolved.sub_id is None:
                out["needs_resolution"] = resolved.needs
                return out

            sub = await _read_subscription(client, resolved.sub_id)
            invoices = await stripe_billing.list_invoices(client, resolved.sub_id)
            legacy = await _is_legacy_price(client, tier, sub) if tier else False
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc

        collection = sub.get("collection_method") or "charge_automatically"
        live_price = _price_from_sub(tier, sub) if tier else None
        out.update(
            subscription_id=resolved.sub_id,
            status=sub.get("status"),
            collection_method=collection,
            cancel_scheduled=stripe_billing.cancel_scheduled(sub),
            cancel_at=_iso(sub.get("cancel_at")),
            period_end=_iso(stripe_billing.period_end(sub)),
            legacy_price=legacy,
        )
        if live_price is not None:
            out["price_usd"] = live_price
        if tier and out["price_usd"] is not None:
            out["code_points"] = _points_for(tier, out["price_usd"])

        live = sub.get("status") in _LIVE_STATUSES
        if live and not out["cancel_scheduled"]:
            try:
                preview = await stripe_billing.preview_next(client, resolved.sub_id)
            except StripeApiError as exc:  # a panel without a preview still helps
                logger.warning("billing: preview failed for %s: %s", resolved.sub_id, exc.message)
                preview = None
            if preview:
                out["next_charge"] = {
                    "amount_cents": preview.get("amount_due", preview.get("total")),
                    "date": _iso(
                        preview.get("next_payment_attempt")
                        or preview.get("period_end")
                        or stripe_billing.period_end(sub)
                    ),
                }
        customer = sub.get("customer")
        customer = customer.get("id") if isinstance(customer, dict) else customer
        if collection == "charge_automatically" and customer:
            try:
                out["card"] = await stripe_billing.default_card(client, customer)
            except StripeApiError as exc:
                logger.warning("billing: card read failed for %s: %s", customer, exc.message)

    mirror = _mirror_rows(db, [i.get("id") for i in invoices if i.get("id")])
    out["invoices"] = [_invoice_row(i, mirror.get(i.get("id"))) for i in invoices]

    if collection == "send_invoice":
        # A quoted customer is never auto-charged, so nothing ever "fails":
        # the clock starts at the oldest overdue open invoice (SA-F4).
        now = datetime.now(UTC)
        overdue = sorted(
            i["due_date"]
            for i in invoices
            if i.get("status") == "open"
            and isinstance(i.get("due_date"), int)
            and i["due_date"] < now.timestamp()
        )
        if overdue:
            out["failing_since"] = _iso(overdue[0])
            out["cancels_on"] = _iso(datetime.fromtimestamp(overdue[0], UTC) + _grace())
        else:
            out["failing_since"] = None
    elif out["failing_since"]:
        started = datetime.fromisoformat(out["failing_since"])
        out["cancels_on"] = (started + _grace()).isoformat()
    return out


# ── the actions ─────────────────────────────────────────────────────────────


class CancelBody(BaseModel):
    when: Literal["period_end", "now", "resume"]


class RefundBody(BaseModel):
    invoice_id: str = Field(min_length=1, max_length=80)
    amount_cents: int | None = Field(default=None, gt=0)


class DiscountBody(BaseModel):
    code_points: int = Field(ge=0, le=sales_pricing.MAX_CODE_POINTS)


@router.post("/{sponsor_id}/billing/cancel")
async def cancel(
    sponsor_id: str,
    body: CancelBody,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    key = _secret_key()
    sponsor = _load_sponsor(db, sponsor_id)
    idem = _checked_key(idempotency_key)
    async with stripe_quotes.make_client(key) as client:
        sub_id = await _acting_subscription(db, client, sponsor)
        try:
            if body.when == "now":
                sub = await stripe_billing.cancel_now(client, sub_id, idem)
                voided = await stripe_billing.void_open_invoices(client, sub_id)
            else:
                sub = await stripe_billing.set_period_end_cancel(
                    client, sub_id, body.when == "period_end", idem
                )
                voided = 0
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc

    if body.when == "now":
        sponsor.status = "Expired"
        billing = db.get(SponsorBilling, sponsor.id)
        if billing is not None:
            billing.void_pending = False
        action, detail = "cancel_now", f"{sub_id} canceled; {voided} open invoice(s) voided"
    elif body.when == "period_end":
        action, detail = "cancel_period_end", f"{sub_id} cancels at period end"
    else:
        action, detail = "cancel_resumed", f"{sub_id} scheduled cancel undone"
    billing_mirror.audit(db, user.username, action, sponsor_id=sponsor.id, detail=detail)
    db.commit()
    if body.when == "now":
        category_cache.clear()
    return {
        "subscription_status": sub.get("status"),
        "cancel_scheduled": stripe_billing.cancel_scheduled(sub),
        "cancel_at": _iso(sub.get("cancel_at")),
        "sponsor_status": sponsor.status,
        "voided_invoices": voided,
    }


def _refund_audits(db: Session, sponsor_id: uuid.UUID) -> list[str]:
    rows = db.query(BillingAudit.detail).filter(
        BillingAudit.sponsor_id == sponsor_id, BillingAudit.action == "refund"
    )
    return [r[0] or "" for r in rows]


def _prior_refund(db: Session, sponsor_id: uuid.UUID, idem: str) -> bool:
    """A refund was already made under this Idempotency-Key — a retry of the
    SAME dialog, which Stripe will answer from its record. (Compared in
    Python: ``_`` is a LIKE wildcard and may appear in keys and ids.)"""
    return any(d.endswith(f" key={idem}") for d in _refund_audits(db, sponsor_id))


def _refund_recorded(db: Session, sponsor_id: uuid.UUID, refund_id: str) -> bool:
    return any(d.startswith(f"{refund_id} ") for d in _refund_audits(db, sponsor_id))


def _settle_refund_status(row: SponsorPayment) -> None:
    paid, refunded = row.amount_paid_cents or 0, row.amount_refunded_cents or 0
    if refunded <= 0:
        return
    row.status = billing_mirror.REFUNDED if refunded >= paid else billing_mirror.PARTIALLY_REFUNDED


@router.post("/{sponsor_id}/billing/refund")
async def refund(
    sponsor_id: str,
    body: RefundBody,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    """Refund all or part of one paid invoice of THIS sponsor's subscription.
    Never cancels. A retry under the same key reaches Stripe with the same
    key and is answered from Stripe's record — one refund, however often
    the button is pressed."""
    key = _secret_key()
    sponsor = _load_sponsor(db, sponsor_id)
    idem = _checked_key(idempotency_key)
    try:
        invoice_id = stripe_billing.checked_id("in", body.invoice_id)
    except StripeApiError:
        raise HTTPException(status_code=422, detail="malformed invoice id") from None
    retry = _prior_refund(db, sponsor.id, idem)

    async with stripe_quotes.make_client(key) as client:
        sub_id = await _acting_subscription(db, client, sponsor)
        try:
            invoice = await _call(client, "GET", f"/v1/invoices/{invoice_id}")
        except StripeApiError as exc:
            if exc.status == 404:
                raise HTTPException(
                    status_code=404, detail="Invoice not found for this sponsorship."
                ) from exc
            raise _as_http_error(exc) from exc
        if billing_mirror.invoice_subscription_id(invoice) != sub_id:
            raise HTTPException(status_code=404, detail="Invoice not found for this sponsorship.")

        row = billing_mirror.upsert_payment_from_invoice(db, invoice)
        if row is not None and row.sponsor_id is None:
            row.sponsor_id = sponsor.id
        paid = invoice.get("amount_paid") or 0
        remaining = paid - ((row.amount_refunded_cents or 0) if row else 0)
        if not retry and body.amount_cents is not None and body.amount_cents > remaining:
            raise HTTPException(
                status_code=422,
                detail=f"That is more than is left to refund (${remaining / 100:,.2f}).",
            )
        try:
            result = await stripe_billing.refund_invoice(
                client, invoice_id, body.amount_cents, idem
            )
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc

    if result is None:  # Stripe: already fully refunded
        if row is not None:
            row.amount_refunded_cents = paid
            _settle_refund_status(row)
        db.commit()
        return {
            "refund_id": None,
            "amount_cents": 0,
            "already_refunded": True,
            "invoice": _invoice_row(invoice, row),
        }

    refund_id = result.get("id") or ""
    amount = result.get("amount") or 0
    if not _refund_recorded(db, sponsor.id, refund_id):
        if row is not None:
            row.amount_refunded_cents = (row.amount_refunded_cents or 0) + amount
            if not row.stripe_payment_intent_id and result.get("payment_intent"):
                row.stripe_payment_intent_id = result["payment_intent"]
            _settle_refund_status(row)
        billing_mirror.audit(
            db,
            user.username,
            "refund",
            sponsor_id=sponsor.id,
            amount_cents=amount,
            detail=f"{refund_id} on {invoice_id} key={idem}",
        )
    db.commit()
    return {
        "refund_id": refund_id,
        "amount_cents": amount,
        "already_refunded": False,
        "invoice": _invoice_row(invoice, row),
    }


@router.post("/{sponsor_id}/billing/discount")
async def change_discount(
    sponsor_id: str,
    body: DiscountBody,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    """Move the subscription to the rule's price for ``code_points`` (0 = the
    Founder's Deal; there is no "back to list"). One amount_off coupon,
    verified on the subscription after the write; applies from the next
    invoice. 409 ``legacy_price`` when the items are not the tier's current
    prices (the coupon is fenced to those)."""
    key = _secret_key()
    sponsor = _load_sponsor(db, sponsor_id)
    idem = _checked_key(idempotency_key)
    tier = _require_tier(sponsor)
    price = sales_pricing.price_usd(tier, body.code_points)
    async with stripe_quotes.make_client(key) as client:
        sub_id = await _acting_subscription(db, client, sponsor)
        try:
            sub = await _read_subscription(client, sub_id)
            if await _is_legacy_price(client, tier, sub):
                raise HTTPException(status_code=409, detail=LEGACY_PRICE)
            prices = await stripe_quotes.resolve_tier_prices(client, tier)
            coupon = await stripe_quotes.ensure_price_coupon(
                client,
                tier,
                price,
                [p["product"] for p in prices],
                name=sales_pricing.coupon_name(tier, price),
            )
            await stripe_billing.set_coupon(client, sub_id, coupon, idem)
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc

    billing = _ensure_billing(db, sponsor, sub)
    billing.price_usd = price
    billing_mirror.audit(
        db,
        user.username,
        "discount_changed",
        sponsor_id=sponsor.id,
        amount_cents=price * 100,
        detail=f"{body.code_points} pts → ${price:,}/mo ({coupon}) on {sub_id}",
    )
    db.commit()
    return {
        "price_usd": price,
        "code_points": body.code_points,
        "coupon_id": coupon,
        "applies_from": "next_invoice",
    }


@router.post("/{sponsor_id}/billing/retry-payment")
async def retry_payment(
    sponsor_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    """Try the OLDEST open invoice now (LU-F14d). A decline is a 422 with
    Stripe's own sentence."""
    key = _secret_key()
    sponsor = _load_sponsor(db, sponsor_id)
    idem = _checked_key(idempotency_key)
    async with stripe_quotes.make_client(key) as client:
        sub_id = await _acting_subscription(db, client, sponsor)
        try:
            invoice = await stripe_billing.pay_oldest_open_invoice(client, sub_id, idem)
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc
    if invoice is None:
        raise HTTPException(status_code=409, detail="Nothing is due — there is no open invoice.")
    row = billing_mirror.upsert_payment_from_invoice(db, invoice)
    if row is not None and row.sponsor_id is None:
        row.sponsor_id = sponsor.id
    billing_mirror.audit(
        db,
        user.username,
        "payment_retried",
        sponsor_id=sponsor.id,
        amount_cents=invoice.get("amount_paid") or 0,
        detail=f"{invoice.get('id')} → {invoice.get('status')}",
    )
    db.commit()
    return {
        "invoice_id": invoice.get("id"),
        "status": invoice.get("status"),
        "amount_paid_cents": invoice.get("amount_paid") or 0,
    }


@router.post("/{sponsor_id}/billing/card-link")
async def create_card_link(
    sponsor_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
) -> dict:
    """A 7-day card-update link for the customer; minting one REVOKES the
    previous link (the version in the token must be the current one).
    Refused for ``send_invoice`` subscriptions (SA-F4): they pay on the
    hosted invoice page, and a saved card would never be charged."""
    key = _secret_key()
    sponsor = _load_sponsor(db, sponsor_id)
    async with stripe_quotes.make_client(key) as client:
        sub_id = await _acting_subscription(db, client, sponsor)
        try:
            sub = await stripe_billing.get_subscription(client, sub_id)
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc
    if (sub.get("collection_method") or "charge_automatically") == "send_invoice":
        raise HTTPException(status_code=409, detail=SEND_INVOICE_CARD_LINK)

    billing = _ensure_billing(db, sponsor, sub)
    billing.card_link_version = (billing.card_link_version or 0) + 1
    expires_at = card_links.link_expiry()
    token = card_links.make_token(sponsor.id, billing.card_link_version, expires_at)
    billing_mirror.audit(
        db,
        user.username,
        "card_link_created",
        sponsor_id=sponsor.id,
        detail=f"card link v{billing.card_link_version} until {expires_at.date().isoformat()}",
    )
    db.commit()
    email = (sponsor.supplier.email or "").strip() if sponsor.supplier else ""
    return {
        "url": card_links.link_url(token),
        "expires_at": expires_at.isoformat(),
        "email": email or None,
    }
