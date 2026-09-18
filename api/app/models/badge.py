"""Badges (2026-09-18, owner: "the idea of a 'badge' is going to be a continual thing
that gets applied to customers regularly"). `badges` is the catalogue — what a badge CAN
be; `supplier_badges` is who holds which one and how its fire looks. One holding per
(supplier, family): choosing the founder badge's alternate appearance UPDATES badge_id.
Per-environment state like sponsorships — never in the catalog transfer."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
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

FOUNDER_FAMILY = "founder"
FOUNDER_BADGE_1 = "founder_badge_1"
FOUNDER_BADGE_2 = "founder_badge_2"
BADGE_SCHEMES = ("red", "orange", "yellow", "green", "blue", "indigo", "violet", "white", "black")
INTENSITY_RANGE = (0.3, 2.0)
OPACITY_RANGE = (0.2, 1.0)


class Badge(Base):
    __tablename__ = "badges"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key = Column(String(40), nullable=False, unique=True)
    family = Column(String(40), nullable=False)
    label = Column(String(80), nullable=False)
    available = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC))


class SupplierBadge(Base):
    __tablename__ = "supplier_badges"
    __table_args__ = (
        UniqueConstraint("supplier_id", "family", name="uq_supplier_badges_family"),
        CheckConstraint(
            "scheme IN ('red','orange','yellow','green','blue','indigo','violet','white','black')",
            name="ck_supplier_badges_scheme",
        ),
        CheckConstraint("intensity >= 0.3 AND intensity <= 2", name="ck_supplier_badges_intensity"),
        CheckConstraint("opacity >= 0.2 AND opacity <= 1", name="ck_supplier_badges_opacity"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    supplier_id = Column(
        UUID(as_uuid=True),
        ForeignKey("suppliers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    badge_id = Column(
        UUID(as_uuid=True), ForeignKey("badges.id", ondelete="RESTRICT"), nullable=False
    )
    family = Column(String(40), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    scheme = Column(String(12), nullable=False, default="orange")
    intensity = Column(Numeric(3, 2), nullable=False, default=Decimal("1.00"))
    opacity = Column(Numeric(3, 2), nullable=False, default=Decimal("0.75"))
    sparks = Column(Boolean, nullable=False, default=True)
    granted_by = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    granted_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC))
    updated_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )

    badge = relationship("Badge", lazy="joined")
    supplier = relationship("Supplier", back_populates="badges")
