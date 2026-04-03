import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Integer, Numeric, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class PartListing(Base):
    __tablename__ = "part_listings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    part_id = Column(
        UUID(as_uuid=True), ForeignKey("parts.id"), nullable=False
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

    part = relationship("Part", back_populates="listings")
    supplier = relationship("Supplier")
    price_breaks = relationship(
        "PriceBreak", back_populates="listing", lazy="selectin"
    )


class PriceBreak(Base):
    __tablename__ = "price_breaks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    listing_id = Column(
        UUID(as_uuid=True), ForeignKey("part_listings.id"), nullable=False
    )
    min_quantity = Column(Integer, nullable=False)
    unit_price = Column(Numeric(10, 4), nullable=False)

    listing = relationship("PartListing", back_populates="price_breaks")
