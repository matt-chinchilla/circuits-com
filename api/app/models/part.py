import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, Column, DateTime, Enum, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class Part(Base):
    __tablename__ = "parts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sku = Column(String(100), nullable=False, index=True)
    slug = Column(String(200), nullable=True, index=True)
    description = Column(Text, nullable=True)
    manufacturer_name = Column(String(200), nullable=False)
    # Resolved manufacturer (2026-08-20). manufacturer_name stays the raw
    # as-imported string; this FK is the canonical join, backfilled by the
    # seed and stamped by the feed importer via manufacturer_canon.
    manufacturer_id = Column(
        UUID(as_uuid=True),
        ForeignKey("manufacturers.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    category_id = Column(
        UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True, index=True
    )
    # Denormalized subcategory slug — points at the parent category's
    # subs[].slug (the canonical taxonomy in ui_kits/website/data.js).
    # Stored here so /api/parts/ list responses don't need to join through
    # Category each row to surface "Parent (Sub)" labels on the admin UI.
    # Backfilled from category.parent.slug for existing rows via migration 006.
    sub_slug = Column(String(80), nullable=True, index=True)
    datasheet_url = Column(String(500), nullable=True)
    # Product photo URL. Populated by the (future) distributor-API sync, not
    # hand-entered — the part page falls back to the category icon when NULL.
    image_url = Column(String(500), nullable=True)
    lifecycle_status = Column(
        Enum("active", "nrnd", "obsolete", "unknown", name="lifecycle_status"),
        nullable=False,
        default="active",
    )
    # BOM tool (migration 037): normalized package token ("0805", "SOIC-8") —
    # stamped by the feed paths, absence degrades to "no warning" (D5).
    package = Column(String(60), nullable=True)
    # NULL == lifecycle never confirmed by a feed → UI renders hatched (D6).
    lifecycle_verified_at = Column(DateTime(timezone=True), nullable=True)
    # Spec-sheet facts (migration 039), feed-owned like `package`: "SMT"/"THT"
    # or NULL (the mapper never guesses), tri-state RoHS where NULL means
    # unknown — distinct from False — and the manufacturer lead time in days.
    mount = Column(String(8), nullable=True)
    rohs = Column(Boolean, nullable=True)
    lead_time_days = Column(Integer, nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )

    __table_args__ = (
        # EXACT-match rung of the BOM ladder: upper(sku) = upper(:mpn).
        # Non-unique on purpose — duplicate SKUs across manufacturers exist.
        Index("ix_parts_sku_upper", func.upper(sku)),
    )

    category = relationship("Category")
    listings = relationship("PartListing", back_populates="part", lazy="selectin")
