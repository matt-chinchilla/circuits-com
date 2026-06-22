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
    description = Column(Text, nullable=True)
    tier = Column(String(10), default="gold")
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    amount = Column(Numeric(10, 2), nullable=True)
    status = Column(String(20), nullable=True)
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
