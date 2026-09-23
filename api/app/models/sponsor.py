import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    or_,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class Sponsor(Base):
    __tablename__ = "sponsors"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=False)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True)
    keyword = Column(String(100), nullable=True)
    image_url = Column(Text, nullable=True)
    brand_primary = Column(String(9), nullable=True)
    brand_secondary = Column(String(9), nullable=True)
    description = Column(Text, nullable=True)
    tier = Column(String(10), default="gold")
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    amount = Column(Numeric(10, 2), nullable=True)
    status = Column(String(20), nullable=True)
    # The Stripe subscription that OWNS this row (migration 028). Set only for
    # self-serve purchases, where the row is created by the webhook AFTER
    # Stripe made the subscription — so it cannot carry sponsor_id, and its
    # lifecycle events (renew/cancel) MUST resolve by this id, never by the
    # buyer-typed company name (which is public and forgeable). Rep-quoted
    # sponsorships leave it NULL and resolve by subscription metadata
    # sponsor_id as before. Unique so a redelivered checkout is a clean no-op.
    stripe_subscription_id = Column(String(64), nullable=True)
    # Sales rep who closed the deal — an admin User.username (migration 019).
    # ADMIN-ONLY: exposed on AdminSponsorCreate/Update/Response, never on the
    # public SponsorResponse (routes/sponsors.py is unauthenticated). Free
    # string, not an FK, so renaming/removing a rep can't orphan a sponsorship.
    sold_by = Column(String(120), nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=True,
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=True,
    )

    __table_args__ = (
        CheckConstraint(
            "(category_id IS NOT NULL AND keyword IS NULL) OR (category_id IS NULL AND keyword IS NOT NULL)",
            name="sponsor_category_or_keyword",
        ),
        # Single source of truth + caps (2026-06-03): a company sponsors any given
        # category at most once, and any given keyword at most once. NULLs are
        # SQL-distinct, so a company's many keyword sponsors (category_id NULL) and
        # its many category sponsors (keyword NULL) coexist freely — the caps
        # (≤15 top-level + ≤75 child = the taxonomy size) fall out of this.
        UniqueConstraint("supplier_id", "category_id", name="uq_sponsor_supplier_category"),
        UniqueConstraint("supplier_id", "keyword", name="uq_sponsor_supplier_keyword"),
        # A Stripe subscription owns at most one sponsor row — the webhook's
        # idempotency key for a redelivered checkout.session.completed.
        UniqueConstraint("stripe_subscription_id", name="uq_sponsor_stripe_subscription"),
    )

    supplier = relationship("Supplier")
    category = relationship("Category")


def is_single_slot(tier: str | None, is_top_level: bool) -> bool:
    """True for single-occupant sponsor placements — Platinum on a top-level
    category, Gold on a child — which hold exactly ONE active sponsor. A 2nd is
    BLOCKED 409 by ``admin_sponsors._reject_if_slot_taken`` + migration 016's
    partial unique indexes, and ``seed.get_or_create_sponsor`` skips a taken slot.
    Silver (subcategory directory) and keyword placements are multi-occupant —
    never single-slot. The single home for the tier↔occupancy matrix so the API
    block and the seed guard can never desync. Casing-tolerant (admin emits
    TitleCase, legacy seed/DB rows lowercase — CLAUDE.md tier-casing gotcha)."""
    t = (tier or "").strip().lower()
    return (t == "platinum" and is_top_level) or (t == "gold" and not is_top_level)


def exclusive_occupant_clause():
    """R16 (spec §3): an exclusive slot (Gold on a child, Platinum on a top-level
    category) is TAKEN by any same-category, same-tier row that is not Expired.
    Paused still pays — "hide the board, keep billing" — so it occupies, and a
    legacy NULL status is Active. Callers add the category + tier filters (tier
    lower-cased, the casing gotcha); this is only the status half, the single
    home for self-serve slot availability. Deliberately WIDER than migration
    016's Active|NULL index and `_reject_if_slot_taken`, which govern what may
    be SHOWN; this governs what may be SOLD. Compared case-sensitively against
    the TitleCase literal, like every other status predicate."""
    return or_(Sponsor.status.is_(None), Sponsor.status != "Expired")
