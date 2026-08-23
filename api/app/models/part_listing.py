import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class PartListing(Base):
    __tablename__ = "part_listings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    part_id = Column(
        UUID(as_uuid=True), ForeignKey("parts.id"), nullable=False, index=True
    )
    supplier_id = Column(
        UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=False
    )
    sku = Column(String(100), nullable=True)
    stock_quantity = Column(Integer, default=0)
    lead_time_days = Column(Integer, nullable=True)
    unit_price = Column(Numeric(10, 4), nullable=False)
    currency = Column(String(3), default="USD")
    last_updated = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    __table_args__ = (
        # ONE row per distributor per part. Without this the comparison table
        # can list the same distributor twice for one part, `total_stock`
        # double-counts, and "best price" becomes ambiguous — and nothing in
        # the database prevented it: routes/parts.py said so out loud
        # ("this guard is the ONLY duplicate protection"). Production has zero
        # violations today, so this is free to add and only ever a backstop.
        UniqueConstraint("part_id", "supplier_id", name="uq_part_listings_part_supplier"),
    )

    part = relationship("Part", back_populates="listings")
    supplier = relationship("Supplier")
    price_breaks = relationship(
        "PriceBreak", back_populates="listing", lazy="selectin"
    )


class PriceBreak(Base):
    __tablename__ = "price_breaks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    listing_id = Column(
        UUID(as_uuid=True), ForeignKey("part_listings.id"), nullable=False, index=True
    )
    min_quantity = Column(Integer, nullable=False, index=True)
    unit_price = Column(Numeric(10, 4), nullable=False)

    listing = relationship("PartListing", back_populates="price_breaks")
