import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Enum, ForeignKey, String, Text
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
    lifecycle_status = Column(
        Enum("active", "nrnd", "obsolete", "unknown", name="lifecycle_status"),
        nullable=False,
        default="active",
    )
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

    category = relationship("Category")
    listings = relationship("PartListing", back_populates="part", lazy="selectin")
