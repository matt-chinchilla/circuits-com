import uuid
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, Date, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class Sponsor(Base):
    __tablename__ = "sponsors"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=False)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True)
    keyword = Column(String(100), nullable=True)
    image_url = Column(String(500), nullable=True)
    description = Column(Text, nullable=True)
    tier = Column(String(10), default="gold")
    start_date = Column(Date, nullable=True)
    end_date = Column(Date, nullable=True)
    amount = Column(Numeric(10, 2), nullable=True)
    status = Column(String(20), nullable=True)
    # CSB v13 rep-contact block — all nullable, populated per-sponsor by the
    # admin form or the seed-update commit. Surfaced on the public
    # CategorySponsorBanner; absent values collapse gracefully.
    contact_name = Column(String(80), nullable=True)
    role = Column(String(80), nullable=True)
    phone = Column(String(40), nullable=True)
    hours = Column(String(60), nullable=True)
    email = Column(String(120), nullable=True)
    division = Column(String(80), nullable=True)
    partno = Column(String(60), nullable=True)
    lettermark = Column(String(8), nullable=True)
    blurb = Column(String(160), nullable=True)
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
    )

    supplier = relationship("Supplier")
    category = relationship("Category")
