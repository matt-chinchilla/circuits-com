"""Public self-serve checkout — /api/checkout/silver.

UNAUTHENTICATED on purpose: the caller is a prospect standing on an open
Silver slot, not an admin. What keeps that safe:

* The endpoint can only mint Stripe-hosted Checkout Sessions for the fixed
  Silver placement at the fixed ladder price — no amounts, no prices, no
  tiers come from the client.
* Placement must be a REAL subcategory (or a keyword), validated here; the
  sponsor row itself is only ever created by the signed webhook after Stripe
  confirms payment.
* A per-IP sliding window (the /api/track pattern) bounds session-mint spam.
* STRIPE_SECRET_KEY unset → 404, the demo-door posture shared by every
  billing surface in this app.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Category, Sponsor
from app.services import stripe_checkout, stripe_quotes
from app.services.rate_limit import client_ip
from app.services.stripe_checkout import silver_monthly_usd
from app.services.stripe_quotes import StripeApiError

router = APIRouter(prefix="/api/checkout", tags=["checkout"])

# Sliding window per client IP: enough for a legitimate buyer opening a few
# slots, a wall for a loop minting sessions. Keyed via the SHARED
# rate_limit.client_ip — which normalizes IPv6 to its /64 (rotating the low
# bits can't bypass it) and reads the same nginx hop the login limiter trusts.
_RATE_WINDOW_SECONDS = 600
_RATE_MAX = 8
# Cap the number of tracked IPs so a spray of one-shot addresses cannot grow
# this dict without bound (the per-IP bucket alone never evicted an idle key).
_RATE_MAX_KEYS = 4096
_rate_buckets: dict[str, list[float]] = defaultdict(list)


def _rate_limited(ip: str) -> bool:
    now = time.monotonic()
    # Evict fully-decayed buckets so idle keys don't accumulate; bounded work
    # because we only sweep when the map is over the cap.
    if len(_rate_buckets) > _RATE_MAX_KEYS:
        for key in [k for k, v in _rate_buckets.items() if not v or now - v[-1] >= _RATE_WINDOW_SECONDS]:
            del _rate_buckets[key]
    bucket = _rate_buckets[ip]
    bucket[:] = [t for t in bucket if now - t < _RATE_WINDOW_SECONDS]
    if len(bucket) >= _RATE_MAX:
        return True
    bucket.append(now)
    return False


def _secret_key() -> str:
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    if not key:
        raise HTTPException(status_code=404, detail="Not found")
    return key


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


@router.get("/silver")
def silver_info() -> dict:
    """What the confirm panel renders — the all-in monthly price."""
    _secret_key()
    return {"monthly_total": silver_monthly_usd(), "tax_included": True}


# Every Silver board shows five slots (SVP_SLOTS in SilverPartners.tsx). The
# two must agree: a picker offering a "full" board would send a buyer to a
# page with nothing to buy.
SILVER_SLOTS_PER_BOARD = 5


@router.get("/silver/boards")
def silver_boards(db: Session = Depends(get_db)) -> dict:
    """Every subcategory board with its open Silver slot count.

    Feeds the /pricing placement picker: a buyer chooses a board here and
    lands on THAT category page with the purchase panel open, so the sale
    still happens standing on the slot. Public and cheap — two grouped
    queries, no per-category N+1 — and it exposes only what the boards
    already render.
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

    parents = {
        cat.id: cat for cat in db.query(Category).filter(Category.parent_id.is_(None)).all()
    }
    children = (
        db.query(Category)
        .filter(Category.parent_id.isnot(None))
        .order_by(Category.name)
        .all()
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
    return {"monthly_total": silver_monthly_usd(), "boards": boards}


@router.post("/silver")
async def create_silver_checkout(
    body: SilverCheckoutBody,
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    key = _secret_key()
    if _rate_limited(client_ip(request)):
        raise HTTPException(status_code=429, detail="Too many checkout attempts — try again soon.")

    keyword = (body.keyword or "").strip()
    if bool(body.category_id) == bool(keyword):
        raise HTTPException(
            status_code=422, detail="Choose exactly one placement: a subcategory or a keyword."
        )

    category_id: str | None = None
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
        category_id = str(child.id)
        placement_label = child.name
        return_path = f"/category/{parent.slug}/{child.slug}" if parent else f"/category/{child.slug}"

    async with stripe_quotes.make_client(key) as client:
        try:
            return await stripe_checkout.create_silver_checkout_session(
                client,
                category_id=category_id,
                keyword=keyword or None,
                placement_label=placement_label,
                company_name=body.company_name.strip(),
                website=(body.website or "").strip() or None,
                email=(str(body.email).strip() or None) if body.email else None,
                return_path=return_path,
            )
        except StripeApiError as exc:
            status = 422 if 400 <= exc.status < 500 else 502
            raise HTTPException(status_code=status, detail=f"stripe: {exc.message}") from exc
