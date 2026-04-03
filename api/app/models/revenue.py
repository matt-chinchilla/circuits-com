import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, Date, DateTime, Enum, ForeignKey, Numeric, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class Revenue(Base):
    __tablename__ = "revenue"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    supplier_id = Column(
        UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=False
    )
    type = Column(
        Enum("sponsorship", "listing_fee", "featured", name="revenue_type"),
        nullable=False,
    )
    amount = Column(Numeric(10, 2), nullable=False)
    description = Column(Text, nullable=True)
    period_start = Column(Date, nullable=False)
    period_end = Column(Date, nullable=False)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    supplier = relationship("Supplier")
