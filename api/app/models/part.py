import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Enum, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class Part(Base):
    __tablename__ = "parts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    mpn = Column(String(100), nullable=False, index=True)
    description = Column(Text, nullable=True)
    manufacturer_name = Column(String(200), nullable=False)
    category_id = Column(
        UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True
    )
    datasheet_url = Column(String(500), nullable=True)
    lifecycle_status = Column(
        Enum("active", "nrnd", "obsolete", "unknown", name="lifecycle_status"),
        nullable=False,
        default="active",
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

    category = relationship("Category")
    listings = relationship("PartListing", back_populates="part", lazy="selectin")
