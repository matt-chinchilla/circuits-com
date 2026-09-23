"""Checkout intents — the core (spec §6/§7). The public routes append here (T4).

An intent is every Checkout Session we mint, all tiers. For Gold and Platinum an
``open`` intent IS the slot hold (R2), one per category by the partial unique
index ``uq_live_exclusive_intent``. A hold lasts the Stripe session
(``STRIPE_SESSION_MINUTES``) plus ``HOLD_GRACE_MINUTES`` so Stripe's own expiry
always lands first (SA-F14); a lapsed hold is flipped to ``expired`` lazily by
the next transaction that needs the slot, and by the hourly sweep.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models.category import Category
from app.models.sales import CheckoutIntent, SponsorBilling
from app.models.sponsor import Sponsor, exclusive_occupant_clause
from app.services import sales_pricing
from app.services.billing_mirror import audit
from app.services.sales_codes import NOT_VALID_MESSAGE, usable_code
from app.services.sales_pricing import EXCLUSIVE_TIERS

OPEN, COMPLETED, EXPIRED, RELEASED, CONFLICT = (
    "open",
    "completed",
    "expired",
    "released",
    "conflict",
)
STRIPE_SESSION_MINUTES = 35
HOLD_GRACE_MINUTES = 10


def expire_lapsed(db: Session, now: datetime | None = None) -> int:
    """Flip every ``open`` intent whose hold has lapsed (``expires_at < now``) to
    ``expired``; returns how many. Never commits — the caller's transaction
    (the one about to take a hold, or the sweep's) owns it."""
    stamp = now or datetime.now(UTC)
    lapsed = (
        db.query(CheckoutIntent)
        .filter(CheckoutIntent.status == OPEN, CheckoutIntent.expires_at < stamp)
        .all()
    )
    for intent in lapsed:
        intent.status = EXPIRED
    # Flushed so the index sees the freed slot before the caller's INSERT
    # (the app's sessions run with autoflush off).
    db.flush()
    return len(lapsed)


def hash_token(token: str) -> str:
    """The stored form of a buyer's release token (sha256 hex, unsalted: the
    token itself is a 32-byte random secret)."""
    return hashlib.sha256(token.encode()).hexdigest()


def client_ip_hash(ip: str) -> str:
    """A keyed, truncated fingerprint for anti-squatting counts — never the IP."""
    return hashlib.sha256((ip + settings.ADMIN_SECRET_KEY).encode()).hexdigest()[:32]


# ── Public checkout (T4): slots, quote, the hold, release ─────────────────────
#
# Everything the /api/checkout/exclusive* routes decide lives here, so the
# routes stay transport (HTTP status mapping) and the rules are testable
# without a client. Prices come ONLY from sales_pricing.


class SlotTaken(Exception):
    """R16: a same-category, same-tier sponsor row that is not Expired."""


class SlotHeld(Exception):
    """Another buyer's live hold; ``held_until`` is when it lapses at the latest."""

    def __init__(self, held_until: datetime | None):
        super().__init__("slot_held")
        self.held_until = held_until


class AlreadySponsor(Exception):
    """R7: the code's bound company already holds a live row on this category."""


class HoldLimit(Exception):
    """Anti-squatting (LU-F6): one open hold per IP/email; two lapses → 24 h."""


class CodeInvalid(Exception):
    """The code cannot be used for this purchase (the reason is never told)."""


class PlacementInvalid(ValueError):
    """Unknown tier or category, or a category of the wrong shape for the tier.
    ``str(exc)`` is the public 422 detail."""


@dataclass
class SlotRow:
    category_id: str
    name: str
    parent_name: str | None
    path: str
    state: str  # "open" | "held" | "taken"
    held_until: str | None


LAPSE_WINDOW_HOURS = 24
LAPSES_ALLOWED = 2
SYSTEM_ACTOR = "system:checkout"


def as_utc(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; every stamp here is UTC."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def iso(value: datetime | None) -> str | None:
    return as_utc(value).isoformat() if value is not None else None


def normalize_email(email: str | None) -> str:
    return (email or "").strip().lower()


def exclusive_tier(tier) -> str:
    t = tier.strip().lower() if isinstance(tier, str) else ""
    if t not in EXCLUSIVE_TIERS:
        raise PlacementInvalid("Choose Gold or Platinum.")
    return t


def placement_category(db: Session, tier: str, category_id) -> Category:
    """The category a ``tier`` sale may sit on: Gold on a subcategory, Platinum
    on a top-level category — the tier matrix, checked here so the Postgres
    trigger never has to."""
    try:
        key = category_id if isinstance(category_id, uuid.UUID) else uuid.UUID(str(category_id))
    except (TypeError, ValueError):
        raise PlacementInvalid("Choose a category from the list.") from None
    cat = db.query(Category).filter(Category.id == key).one_or_none()
    if cat is None:
        raise PlacementInvalid("Choose a category from the list.")
    if tier == "gold" and cat.parent_id is None:
        raise PlacementInvalid("Gold sits on a subcategory — choose one from the list.")
    if tier == "platinum" and cat.parent_id is not None:
        raise PlacementInvalid("Platinum sits on a top-level category — choose one from the list.")
    return cat


def _occupied(db: Session, tier: str, category_id: uuid.UUID) -> bool:
    """R16, the single-slot "taken" rule for selling (Paused occupies)."""
    return (
        db.query(Sponsor.id)
        .filter(
            Sponsor.category_id == category_id,
            func.lower(Sponsor.tier) == tier,
            exclusive_occupant_clause(),
        )
        .first()
        is not None
    )


def _live_hold(db: Session, category_id: uuid.UUID, now: datetime) -> CheckoutIntent | None:
    """The live hold on a slot, if any. A lapsed ``open`` row is not live even
    before ``expire_lapsed`` flips it (read-only callers never flip)."""
    return (
        db.query(CheckoutIntent)
        .filter(
            CheckoutIntent.category_id == category_id,
            CheckoutIntent.status == OPEN,
            CheckoutIntent.tier.in_(EXCLUSIVE_TIERS),
            CheckoutIntent.expires_at >= now,
        )
        .first()
    )


def slot_rows(db: Session, tier: str, now: datetime | None = None) -> list[SlotRow]:
    """Every exclusive slot for ``tier`` with its state: ``open``, ``held`` (a
    live checkout) or ``taken`` (R16's occupant — Paused still pays). Taken
    slots stay LISTED (owner, 2026-09-23: a vanished row reads as if the
    category never existed); only the state travels, never who holds it — a
    Paused board is not public. Gold = subcategories, Platinum = top-level
    categories. Read-only."""
    t = exclusive_tier(tier)
    stamp = now or datetime.now(UTC)
    taken = {
        row[0]
        for row in db.query(Sponsor.category_id)
        .filter(
            Sponsor.category_id.isnot(None),
            func.lower(Sponsor.tier) == t,
            exclusive_occupant_clause(),
        )
        .all()
    }
    held = {
        row[0]: row[1]
        for row in db.query(CheckoutIntent.category_id, CheckoutIntent.expires_at)
        .filter(
            CheckoutIntent.status == OPEN,
            CheckoutIntent.tier.in_(EXCLUSIVE_TIERS),
            CheckoutIntent.expires_at >= stamp,
            CheckoutIntent.category_id.isnot(None),
        )
        .all()
    }
    parents = {c.id: c for c in db.query(Category).filter(Category.parent_id.is_(None)).all()}
    if t == "platinum":
        candidates = [(cat, None) for cat in parents.values()]
    else:
        candidates = [
            (cat, parents[cat.parent_id])
            for cat in db.query(Category).filter(Category.parent_id.isnot(None)).all()
            if cat.parent_id in parents
        ]
    rows = []
    for cat, parent in candidates:
        occupied = cat.id in taken
        until = None if occupied else held.get(cat.id)
        rows.append(
            SlotRow(
                category_id=str(cat.id),
                name=cat.name,
                parent_name=parent.name if parent else None,
                path=f"/category/{parent.slug}/{cat.slug}" if parent else f"/category/{cat.slug}",
                state="taken" if occupied else ("held" if until is not None else "open"),
                held_until=iso(until),
            )
        )
    rows.sort(key=lambda r: ((r.parent_name or "").lower(), r.name.lower()))
    return rows


def quote(db: Session, *, tier, category_id=None, code=None, email=None) -> dict:
    """What a purchase would cost and whether its slot is free (spec §7).

    No side effects: lapsed holds are flipped inside this transaction only so a
    code's open-hold count is current, then everything is rolled back. The
    email lock is evaluated only when ``email`` is sent (LU-F18)."""
    t = exclusive_tier(tier)
    now = datetime.now(UTC)
    code_answer = None
    points = 0
    slot_state = None
    try:
        cat = placement_category(db, t, category_id) if category_id else None
        expire_lapsed(db, now)
        if cat is not None:
            if _occupied(db, t, cat.id):
                slot_state = "taken"
            elif _live_hold(db, cat.id, now) is not None:
                slot_state = "held"
            else:
                slot_state = "open"
        if isinstance(code, str) and code.strip():
            row = usable_code(
                db,
                code,
                tier=t,
                category_id=cat.id if cat is not None else None,
                email=email if isinstance(email, str) else None,
                now=now,
            )
            if row is None:
                code_answer = {"accepted": False, "points": None, "message": NOT_VALID_MESSAGE}
            else:
                points = int(row.code_points)
                code_answer = {"accepted": True, "points": points, "message": None}
    finally:
        db.rollback()
    list_price = sales_pricing.list_usd(t)
    price = sales_pricing.price_usd(t, points)
    return {
        "tier": t,
        "list_usd": list_price,
        "founder_usd": sales_pricing.founder_usd(t),
        "price_usd": price,
        "savings_usd": list_price - price,
        "code": code_answer,
        "slot_state": slot_state,
    }


def _squatting(db: Session, *, category_id, email_key: str, ip_hash: str, now: datetime) -> bool:
    """LU-F6. One open exclusive hold per client IP and per email; and after
    two LAPSED holds on this slot from this IP or email within 24 h, that pair
    waits out the day. A released hold never counts, and neither does a hold
    that never reached Stripe (no session id: a Stripe failure, not a squat)."""
    same_buyer = or_(
        CheckoutIntent.client_ip_hash == ip_hash,
        func.lower(CheckoutIntent.email) == email_key,
    )
    open_hold = (
        db.query(CheckoutIntent.id)
        .filter(
            CheckoutIntent.status == OPEN,
            CheckoutIntent.tier.in_(EXCLUSIVE_TIERS),
            same_buyer,
        )
        .first()
    )
    if open_hold is not None:
        return True
    lapses = (
        db.query(func.count(CheckoutIntent.id))
        .filter(
            CheckoutIntent.status == EXPIRED,
            CheckoutIntent.category_id == category_id,
            CheckoutIntent.tier.in_(EXCLUSIVE_TIERS),
            CheckoutIntent.stripe_session_id.isnot(None),
            CheckoutIntent.created_at >= now - timedelta(hours=LAPSE_WINDOW_HOURS),
            same_buyer,
        )
        .scalar()
    )
    return (lapses or 0) >= LAPSES_ALLOWED


def open_exclusive_intent(
    db: Session,
    *,
    tier,
    category_id,
    code,
    company_name: str,
    email: str,
    website: str | None,
    ip: str,
    now: datetime | None = None,
) -> tuple[CheckoutIntent, str]:
    """Take the hold on one Gold/Platinum slot and COMMIT it (spec §7, LU-F6).

    One transaction: lapsed holds expire → tier and placement shape
    (PlacementInvalid) → R16 occupant (SlotTaken) → anti-squatting (HoldLimit)
    → a live hold (SlotHeld) → the code under FOR UPDATE (CodeInvalid) → R7
    (AlreadySponsor) → insert + commit, where the partial unique index is the
    race backstop (SlotHeld). Returns ``(intent, release_token)``; only the
    token's hash is stored. The caller mints the Stripe session and must call
    ``mark_mint_failed`` if that fails."""
    stamp = now or datetime.now(UTC)
    t = exclusive_tier(tier)
    cat = None
    try:
        expire_lapsed(db, stamp)
        cat = placement_category(db, t, category_id)
        if _occupied(db, t, cat.id):
            raise SlotTaken()
        ip_hash = client_ip_hash(ip)
        if _squatting(
            db, category_id=cat.id, email_key=normalize_email(email), ip_hash=ip_hash, now=stamp
        ):
            raise HoldLimit()
        live = _live_hold(db, cat.id, stamp)
        if live is not None:
            raise SlotHeld(as_utc(live.expires_at))

        sales_code = None
        if isinstance(code, str) and code.strip():
            sales_code = usable_code(
                db, code, tier=t, category_id=cat.id, email=email, lock=True, now=stamp
            )
            if sales_code is None:
                raise CodeInvalid()
            if (
                sales_code.supplier_id is not None
                and db.query(Sponsor.id)
                .filter(
                    Sponsor.supplier_id == sales_code.supplier_id,
                    Sponsor.category_id == cat.id,
                    exclusive_occupant_clause(),
                )
                .first()
                is not None
            ):
                raise AlreadySponsor()

        points = int(sales_code.code_points) if sales_code is not None else 0
        token = secrets.token_urlsafe(32)
        intent = CheckoutIntent(
            release_token_hash=hash_token(token),
            tier=t,
            category_id=cat.id,
            sales_code_id=sales_code.id if sales_code is not None else None,
            supplier_id=sales_code.supplier_id if sales_code is not None else None,
            list_usd=sales_pricing.list_usd(t),
            founder_usd=sales_pricing.founder_usd(t),
            price_usd=sales_pricing.price_usd(t, points),
            channel="rep_code" if sales_code is not None else "self_serve",
            sold_by=(
                sales_code.rep if sales_code is not None else settings.SELF_SERVE_ONBOARDING_REP
            ),
            company_name=company_name,
            email=email.strip(),
            website=website,
            client_ip_hash=ip_hash,
            status=OPEN,
            expires_at=stamp + timedelta(minutes=STRIPE_SESSION_MINUTES + HOLD_GRACE_MINUTES),
            created_at=stamp,
        )
        db.add(intent)
        db.flush()
        audit(
            db,
            SYSTEM_ACTOR,
            "checkout_started",
            intent_id=intent.id,
            sales_code_id=intent.sales_code_id,
            amount_cents=intent.price_usd * 100,
            detail=f"{t} · {cat.name} · {company_name}",
        )
        db.commit()
    except IntegrityError:
        # Lost the race for uq_live_exclusive_intent between the pre-check and
        # the insert: someone else holds the slot now.
        db.rollback()
        rival = (
            db.query(CheckoutIntent.expires_at)
            .filter(
                CheckoutIntent.category_id == cat.id,
                CheckoutIntent.status == OPEN,
                CheckoutIntent.tier.in_(EXCLUSIVE_TIERS),
            )
            .first()
            if cat is not None
            else None
        )
        raise SlotHeld(as_utc(rival[0]) if rival else None) from None
    except Exception:
        db.rollback()
        raise
    return intent, token


def open_silver_intent(
    db: Session,
    *,
    category_id: uuid.UUID | None,
    keyword: str | None,
    company_name: str,
    email: str | None,
    website: str | None,
    ip: str,
    now: datetime | None = None,
) -> CheckoutIntent:
    """Record a Silver checkout (spec §7). NOT a hold: the partial index covers
    only the exclusive tiers and the board's five-slot capacity check stays in
    the route. Committed so the webhook can find it by ``intent_id``."""
    stamp = now or datetime.now(UTC)
    intent = CheckoutIntent(
        tier="silver",
        category_id=category_id,
        keyword=keyword,
        list_usd=sales_pricing.list_usd("silver"),
        founder_usd=sales_pricing.founder_usd("silver"),
        price_usd=sales_pricing.price_usd("silver"),
        channel="self_serve",
        sold_by=settings.SELF_SERVE_ONBOARDING_REP,
        company_name=company_name,
        # NOT NULL column; a cached pre-redesign bundle sends no email.
        email=(email or "").strip(),
        website=website,
        client_ip_hash=client_ip_hash(ip),
        status=OPEN,
        expires_at=stamp + timedelta(minutes=STRIPE_SESSION_MINUTES + HOLD_GRACE_MINUTES),
        created_at=stamp,
    )
    db.add(intent)
    db.flush()
    audit(
        db,
        SYSTEM_ACTOR,
        "checkout_started",
        intent_id=intent.id,
        amount_cents=intent.price_usd * 100,
        detail=f"silver · {keyword or category_id} · {company_name}",
    )
    db.commit()
    return intent


def mark_minted(db: Session, intent: CheckoutIntent, session_id: str | None) -> None:
    """Store the Stripe session id on the intent (the webhook matches on it)."""
    intent.stripe_session_id = session_id
    db.commit()


def mark_mint_failed(db: Session, intent: CheckoutIntent) -> None:
    """The session never reached the buyer: give the slot (and the code's
    use) back at once (LU-F6, SA-F14)."""
    db.rollback()
    intent.status = EXPIRED
    db.commit()


def open_intent_by_token(db: Session, release_token) -> CheckoutIntent | None:
    if not isinstance(release_token, str) or not release_token:
        return None
    return (
        db.query(CheckoutIntent)
        .filter(
            CheckoutIntent.release_token_hash == hash_token(release_token),
            CheckoutIntent.status == OPEN,
        )
        .one_or_none()
    )


def release(db: Session, release_token: str) -> CheckoutIntent | None:
    """The buyer's own "back": ``open`` → ``released``, audited, committed.
    The caller expires the Stripe session FIRST, so a released slot is never
    still payable. ``None`` when the token matches no open hold."""
    intent = open_intent_by_token(db, release_token)
    if intent is None:
        return None
    intent.status = RELEASED
    audit(
        db,
        SYSTEM_ACTOR,
        "hold_released",
        intent_id=intent.id,
        sales_code_id=intent.sales_code_id,
        detail="released by the buyer",
    )
    db.commit()
    return intent


def bound_customer_id(db: Session, supplier_id: uuid.UUID | None) -> str | None:
    """R7: the Stripe customer a bound company already bills through (its most
    recently updated billing row), else None."""
    if supplier_id is None:
        return None
    row = (
        db.query(SponsorBilling.stripe_customer_id)
        .join(Sponsor, Sponsor.id == SponsorBilling.sponsor_id)
        .filter(
            Sponsor.supplier_id == supplier_id,
            SponsorBilling.stripe_customer_id.isnot(None),
        )
        .order_by(SponsorBilling.updated_at.desc())
        .first()
    )
    return row[0] if row else None
