"""Public self-serve checkout — /api/checkout/{silver,exclusive,quote}.

UNAUTHENTICATED on purpose: the caller is a prospect choosing a slot, not an
admin. What keeps that safe:

* These routes can only mint Stripe-hosted Checkout Sessions for fixed tier
  prices. The client sends a tier, a placement and maybe a rep's code; every
  price comes from ``sales_pricing`` (the one rule), never from the request.
* Placement must be a REAL category of the right shape for the tier (Silver
  and Gold on a subcategory, Platinum on a top-level category), validated
  here; the sponsor row itself is only ever created by the signed webhook
  after Stripe confirms payment.
* Gold and Platinum are single-slot: a buyer takes a HOLD (a
  ``checkout_intents`` row, R2) before the session exists, so two buyers can
  never both be sent to pay for one slot; anti-squatting bounds holds per IP
  and per email (services/checkout_intents).
* A per-IP sliding window (the /api/track pattern) bounds session-mint spam;
  a second, wider window bounds ``/quote``.
* STRIPE_SECRET_KEY unset → 404, the demo-door posture shared by every
  billing surface in this app.

Every 4xx ``detail`` is a STRING. Machine codes the /join page maps:
409 ``slot_taken`` / ``slot_held`` (lapse time in the ``X-Held-Until`` header)
/ ``already_sponsor``; 429 ``hold_limit``.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field, TypeAdapter, ValidationError
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Category, Sponsor
from app.services import (
    checkout_intents,
    sales_pricing,
    stripe_billing,
    stripe_checkout,
    stripe_quotes,
)
from app.services.checkout_intents import (
    AlreadySponsor,
    CodeInvalid,
    HoldLimit,
    PlacementInvalid,
    SlotHeld,
    SlotTaken,
)
from app.services.rate_limit import client_ip
from app.services.sales_codes import NOT_VALID_MESSAGE
from app.services.stripe_checkout import silver_monthly_usd
from app.services.stripe_quotes import StripeApiError

router = APIRouter(prefix="/api/checkout", tags=["checkout"])

# Sliding window per client IP: enough for a legitimate buyer opening a few
# slots, a wall for a loop minting sessions. Keyed via the SHARED
# rate_limit.client_ip — which normalizes IPv6 to its /64 (rotating the low
# bits can't bypass it) and reads the same nginx hop the login limiter trusts.
_RATE_WINDOW_SECONDS = 600
_RATE_MAX = 8
# /quote is called as a buyer types a code or picks a slot — wider, but still
# a wall against enumerating codes.
_QUOTE_RATE_MAX = 30
# Cap the number of tracked IPs so a spray of one-shot addresses cannot grow
# a bucket dict without bound (the per-IP bucket alone never evicted an idle key).
_RATE_MAX_KEYS = 4096
_rate_buckets: dict[str, list[float]] = defaultdict(list)
_quote_buckets: dict[str, list[float]] = defaultdict(list)


def _rate_limited(
    ip: str,
    buckets: dict[str, list[float]] | None = None,
    limit: int = _RATE_MAX,
) -> bool:
    buckets = _rate_buckets if buckets is None else buckets
    now = time.monotonic()
    # Evict fully-decayed buckets so idle keys don't accumulate; bounded work
    # because we only sweep when the map is over the cap.
    if len(buckets) > _RATE_MAX_KEYS:
        for key in [k for k, v in buckets.items() if not v or now - v[-1] >= _RATE_WINDOW_SECONDS]:
            del buckets[key]
    bucket = buckets[ip]
    bucket[:] = [t for t in bucket if now - t < _RATE_WINDOW_SECONDS]
    if len(bucket) >= limit:
        return True
    bucket.append(now)
    return False


def _too_many() -> HTTPException:
    return HTTPException(status_code=429, detail="Too many checkout attempts — try again soon.")


def _secret_key() -> str:
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    if not key:
        raise HTTPException(status_code=404, detail="Not found")
    return key


def _stripe_http_error(exc: StripeApiError) -> HTTPException:
    status = 422 if 400 <= exc.status < 500 else 502
    return HTTPException(status_code=status, detail=f"stripe: {exc.message}")


_EMAIL = TypeAdapter(EmailStr)


def _valid_email(raw: str | None) -> str:
    """The buyer's email, validated here so a malformed one is a STRING 422,
    never a Stripe 400 (and never pydantic's list-shaped detail)."""
    value = (raw or "").strip() if isinstance(raw, str) else ""
    if not value or len(value) > 200:
        raise HTTPException(status_code=422, detail="Enter a valid work email.")
    try:
        _EMAIL.validate_python(value)
    except ValidationError:
        raise HTTPException(status_code=422, detail="Enter a valid work email.") from None
    return value


def _company(raw: str | None) -> str:
    value = (raw or "").strip() if isinstance(raw, str) else ""
    if not 2 <= len(value) <= 120:
        raise HTTPException(
            status_code=422, detail="Enter your company name (2 to 120 characters)."
        )
    return value


def _website(raw: str | None) -> str | None:
    value = (raw or "").strip() if isinstance(raw, str) else ""
    if len(value) > 200:
        raise HTTPException(status_code=422, detail="The website is too long.")
    return value or None


# ── Silver ──────────────────────────────────────────────────────────────────


class SilverCheckoutBody(BaseModel):
    """XOR placement, exactly like the Sponsor model's own constraint."""

    category_id: str | None = None
    keyword: str | None = Field(default=None, max_length=100)
    company_name: str = Field(min_length=2, max_length=120)
    # The buyer's work email, collected by the confirm panel. Prefills Stripe's
    # hosted page and becomes the customer's address, so the receipt and every
    # renewal invoice reach the person who actually bought. OPTIONAL on the
    # wire: the panel always sends it, but a cached pre-redesign bundle does
    # not, and a checkout that still works beats a 422 nobody can see.
    email: EmailStr | None = None
    # Still accepted (a rep-built request may carry it) though the redesigned
    # panel no longer collects one — see stripe_checkout's metadata.
    website: str | None = Field(default=None, max_length=200)


def _silver_prices() -> dict:
    """``monthly_total`` stays the LIST price for cached pre-Founder bundles
    (LU-F11); ``price_usd`` is what Stripe charges — the Founder's Deal."""
    return {
        "monthly_total": silver_monthly_usd(),
        "price_usd": sales_pricing.price_usd("silver"),
        "founder_usd": sales_pricing.founder_usd("silver"),
    }


@router.get("/silver")
def silver_info() -> dict:
    """What the confirm panel renders — the all-in monthly price."""
    _secret_key()
    return {**_silver_prices(), "tax_included": True}


# Every Silver board shows five slots (SVP_SLOTS in SilverPartners.tsx). The
# two must agree: a picker offering a "full" board would send a buyer to a
# page with nothing to buy.
SILVER_SLOTS_PER_BOARD = 5


@router.get("/silver/boards")
def silver_boards(db: Session = Depends(get_db)) -> dict:
    """Every subcategory board with its open Silver slot count.

    Feeds the /join placement picker: a buyer chooses a board here and lands on
    THAT category page with the purchase panel open, so the sale still happens
    standing on the slot. Public and cheap — two grouped queries, no
    per-category N+1 — and it exposes only what the boards already render.
    """
    _secret_key()

    taken: dict[str, int] = {
        str(row[0]): row[1]
        for row in (
            db.query(Sponsor.category_id, func.count(Sponsor.id))
            .filter(
                Sponsor.category_id.isnot(None),
                func.lower(Sponsor.tier) == "silver",
                # NULL status counts as Active — the legacy-seed rule.
                or_(Sponsor.status == "Active", Sponsor.status.is_(None)),
            )
            .group_by(Sponsor.category_id)
            .all()
        )
    }

    parents = {cat.id: cat for cat in db.query(Category).filter(Category.parent_id.is_(None)).all()}
    children = (
        db.query(Category).filter(Category.parent_id.isnot(None)).order_by(Category.name).all()
    )

    boards = []
    for child in children:
        parent = parents.get(child.parent_id)
        if parent is None:
            continue
        open_slots = max(0, SILVER_SLOTS_PER_BOARD - taken.get(str(child.id), 0))
        boards.append(
            {
                "category_id": str(child.id),
                "name": child.name,
                "parent_name": parent.name,
                "path": f"/category/{parent.slug}/{child.slug}",
                "open_slots": open_slots,
                "total_slots": SILVER_SLOTS_PER_BOARD,
            }
        )
    return {**_silver_prices(), "boards": boards}


@router.post("/silver")
async def create_silver_checkout(
    body: SilverCheckoutBody,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    key = _secret_key()
    ip = client_ip(request)
    if _rate_limited(ip):
        raise _too_many()

    keyword = (body.keyword or "").strip()
    if bool(body.category_id) == bool(keyword):
        raise HTTPException(
            status_code=422, detail="Choose exactly one placement: a subcategory or a keyword."
        )

    category_key: uuid.UUID | None = None
    return_path = "/keyword/" + keyword if keyword else "/"
    placement_label = f"keyword “{keyword}”" if keyword else ""
    if body.category_id:
        try:
            cat_key = uuid.UUID(body.category_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="Subcategory not found") from None
        child = db.query(Category).filter(Category.id == cat_key).first()
        # Silver lives on SUBCATEGORY boards — a top-level id here means a
        # stale or hand-built request, and the tier matrix (Postgres trigger
        # included) would refuse the row later anyway. Refuse it now.
        if child is None or child.parent_id is None:
            raise HTTPException(status_code=404, detail="Subcategory not found")

        # CAPACITY — the board holds five. Nothing downstream enforces this:
        # migration 016's partial unique indexes back only the single-slot
        # tiers, because Silver is deliberately multi-occupant, and the
        # webhook's gates are about money, not occupancy. So without this
        # check a stale `?sponsor=1` link (a bookmark, a rep's email sent
        # before the board filled) or two buyers racing the last slot ends
        # with someone paying for a slot that does not exist — the
        # refund-and-an-apology outcome self-serve exists to avoid. Checked
        # at session-mint because that is the last moment before Stripe has
        # the customer's money.
        taken = (
            db.query(func.count(Sponsor.id))
            .filter(
                Sponsor.category_id == child.id,
                func.lower(Sponsor.tier) == "silver",
                or_(Sponsor.status == "Active", Sponsor.status.is_(None)),
            )
            .scalar()
            or 0
        )
        if taken >= SILVER_SLOTS_PER_BOARD:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{child.name} is full — all {SILVER_SLOTS_PER_BOARD} Silver slots "
                    "are taken. The partners desk can tell you what's opening next."
                ),
            )

        parent = db.query(Category).filter(Category.id == child.parent_id).first()
        category_key = child.id
        placement_label = child.name
        return_path = (
            f"/category/{parent.slug}/{child.slug}" if parent else f"/category/{child.slug}"
        )

    # Recorded before the session exists (spec §7: Silver sessions are
    # intents too, non-blocking) so the webhook can price-check the payment
    # against what the server charged.
    intent = checkout_intents.open_silver_intent(
        db,
        category_id=category_key,
        keyword=keyword or None,
        company_name=body.company_name.strip(),
        email=(str(body.email).strip() or None) if body.email else None,
        website=(body.website or "").strip() or None,
        ip=ip,
    )
    try:
        async with stripe_quotes.make_client(key) as client:
            session = await stripe_checkout.create_silver_checkout_session(
                client,
                intent=intent,
                placement_label=placement_label,
                return_path=return_path,
            )
    except Exception as exc:
        checkout_intents.mark_mint_failed(db, intent)
        if isinstance(exc, StripeApiError):
            raise _stripe_http_error(exc) from exc
        raise
    checkout_intents.mark_minted(db, intent, session["session_id"])
    return session


# ── Gold & Platinum ─────────────────────────────────────────────────────────


@router.get("/exclusive/slots")
def exclusive_slots(tier: str = "", db: Session = Depends(get_db)) -> dict:
    """Open and held Gold (subcategory) or Platinum (top-level) slots. Taken
    slots (R16 — Paused still pays) are omitted; a held slot carries the time
    its hold lapses at the latest."""
    _secret_key()
    try:
        t = checkout_intents.exclusive_tier(tier)
        rows = checkout_intents.slot_rows(db, t)
    except PlacementInvalid as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    return {
        "tier": t,
        "list_usd": sales_pricing.list_usd(t),
        "founder_usd": sales_pricing.founder_usd(t),
        "slots": [asdict(row) for row in rows],
    }


class QuoteBody(BaseModel):
    tier: str | None = None
    category_id: str | None = None
    code: str | None = None
    email: str | None = None


@router.post("/quote")
def quote(body: QuoteBody, request: Request, db: Session = Depends(get_db)) -> dict:
    """The price a buyer would pay — server numbers only. No side effects."""
    _secret_key()
    if _rate_limited(client_ip(request), _quote_buckets, _QUOTE_RATE_MAX):
        raise _too_many()
    try:
        return checkout_intents.quote(
            db,
            tier=body.tier,
            category_id=body.category_id or None,
            code=body.code,
            email=body.email,
        )
    except PlacementInvalid as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


class ExclusiveBody(BaseModel):
    # Loosely typed on purpose: every field is validated by hand so each 422
    # carries a STRING detail the page can show (pydantic's is a list).
    tier: str | None = None
    category_id: str | None = None
    code: str | None = None
    company_name: str | None = None
    email: str | None = None
    website: str | None = None


@router.post("/exclusive")
async def create_exclusive_checkout(
    body: ExclusiveBody,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """Take the hold, then mint the session (commit-then-mint, LU-F6).

    The hold is COMMITTED before Stripe is called, so a second buyer is
    refused while the first is on Stripe's page; any failure to mint marks
    the intent ``expired`` before answering, so a Stripe outage never leaves
    a slot held (SA-F14)."""
    key = _secret_key()
    ip = client_ip(request)
    if _rate_limited(ip):
        raise _too_many()
    company = _company(body.company_name)
    email = _valid_email(body.email)
    website = _website(body.website)
    if not body.category_id:
        raise HTTPException(status_code=422, detail="Choose a category from the list.")

    try:
        intent, token = checkout_intents.open_exclusive_intent(
            db,
            tier=body.tier,
            category_id=body.category_id,
            code=body.code,
            company_name=company,
            email=email,
            website=website,
            ip=ip,
        )
    except PlacementInvalid as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except SlotTaken:
        raise HTTPException(status_code=409, detail="slot_taken") from None
    except SlotHeld as exc:
        until = checkout_intents.iso(exc.held_until)
        raise HTTPException(
            status_code=409,
            detail="slot_held",
            headers={"X-Held-Until": until} if until else None,
        ) from None
    except AlreadySponsor:
        raise HTTPException(status_code=409, detail="already_sponsor") from None
    except HoldLimit:
        raise HTTPException(status_code=429, detail="hold_limit") from None
    except CodeInvalid:
        raise HTTPException(status_code=422, detail=NOT_VALID_MESSAGE) from None

    customer_id = checkout_intents.bound_customer_id(db, intent.supplier_id)
    try:
        async with stripe_quotes.make_client(key) as client:
            session = await stripe_checkout.create_tier_checkout_session(
                client,
                intent=intent,
                customer_id=customer_id,
                success_path=f"/join?welcome={intent.tier}",
                cancel_path="/join?released=1",
            )
    except Exception as exc:
        checkout_intents.mark_mint_failed(db, intent)
        if isinstance(exc, StripeApiError):
            raise _stripe_http_error(exc) from exc
        raise
    checkout_intents.mark_minted(db, intent, session["session_id"])
    return {
        "url": session["url"],
        "release_token": token,
        "held_until": checkout_intents.iso(intent.expires_at),
    }


class ReleaseBody(BaseModel):
    release_token: str | None = None


@router.post("/exclusive/release")
async def release_hold(body: ReleaseBody, db: Session = Depends(get_db)) -> dict:
    """The buyer's "back" from Stripe: expire their session, free the slot.

    The Stripe session is expired FIRST — a released slot must not stay
    payable — and a session Stripe reports ``complete`` is never released
    (the buyer paid in another tab; the webhook owns that intent now). If
    Stripe cannot be reached the hold stays and lapses by itself. An unknown
    or already-used token is a quiet ``released: false``."""
    key = _secret_key()
    token = body.release_token if isinstance(body.release_token, str) else ""
    if not token or len(token) > 128:
        raise HTTPException(status_code=422, detail="A release token is required.")

    intent = checkout_intents.open_intent_by_token(db, token)
    if intent is None:
        return {"released": False}
    session_id = intent.stripe_session_id
    if session_id:
        try:
            async with stripe_quotes.make_client(key) as client:
                await stripe_billing.expire_checkout_session(client, session_id)
                session = await stripe_quotes._call(
                    client,
                    "GET",
                    f"/v1/checkout/sessions/{stripe_billing.checked_id('cs', session_id)}",
                )
        except StripeApiError as exc:
            raise HTTPException(status_code=502, detail=f"stripe: {exc.message}") from exc
        if session.get("status") == "complete":
            return {"released": False}
    return {"released": checkout_intents.release(db, token) is not None}
