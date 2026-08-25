"""Account tier, DERIVED (D3) — there is no tier column to drift.

A customer's tier is the highest ACTIVE sponsorship held by the supplier they
are linked to. Everyone starts free, because signup never sets supplier_id.
"""

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import Sponsor, User

FREE = "free"
# Index = rank. The names are the /join tile names, not invented ones.
TIER_RANK = ("silver", "gold", "platinum")


def normalize_tier(raw: str | None) -> str:
    """Lowercase + strip. The admin writes TitleCase, legacy seed rows are
    lowercase, and `tier` is a free string with no enum behind it — a
    TitleCase-only comparison silently drops real rows."""
    return (raw or "").strip().lower()


def account_tier(db: Session, user: User | None) -> str:
    if user is None or user.supplier_id is None:
        return FREE
    rows = (
        db.query(Sponsor.tier)
        .filter(Sponsor.supplier_id == user.supplier_id)
        # NULL status means Active: legacy seed rows omit it, and
        # `status != 'Expired'` is UNKNOWN for NULL, which skips them.
        .filter(or_(Sponsor.status == "Active", Sponsor.status.is_(None)))
        .all()
    )
    best = FREE
    best_rank = -1
    for (raw,) in rows:
        tier = normalize_tier(raw)
        if tier not in TIER_RANK:
            continue
        rank = TIER_RANK.index(tier)
        if rank > best_rank:
            best_rank = rank
            best = tier
    return best
