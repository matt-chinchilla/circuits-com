"""Checkout intents — the core (spec §6/§7). The public routes append here (T4).

An intent is every Checkout Session we mint, all tiers. For Gold and Platinum an
``open`` intent IS the slot hold (R2), one per category by the partial unique
index ``uq_live_exclusive_intent``. A hold lasts the Stripe session
(``STRIPE_SESSION_MINUTES``) plus ``HOLD_GRACE_MINUTES`` so Stripe's own expiry
always lands first (SA-F14); a lapsed hold is flipped to ``expired`` lazily by
the next transaction that needs the slot, and by the hourly sweep.
"""

import hashlib
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.config import settings
from app.models.sales import CheckoutIntent

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
