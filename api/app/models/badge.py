"""Badges (2026-09-18, owner: "the idea of a 'badge' is going to be a continual thing
that gets applied to customers regularly"). `badges` is the catalogue — what a badge CAN
be; `supplier_badges` is who holds which one and how its fire looks. One holding per
(supplier, family): choosing the founder badge's alternate appearance UPDATES badge_id.
Two artworks share the row: `founder_badge_1` (the burning pin: scheme/intensity/
opacity/sparks) and `founder_badge_2` (the pulsing pin: scheme, `intensity` read as
its glow, and `speed`).
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
# `speed` is the pulsing badge's cycle length in seconds (056; the design's
# `speed` attribute, 1–6, default 2.6). The burning badge ignores it.
SPEED_RANGE = (1.0, 6.0)

# The CHECK bodies are BUILT from the constants above so there is one copy of
# each rule on this side. Migration 055 keeps its own literal DDL — a migration
# must never import app code, because it has to keep running after the code
# moves on — and `test_the_model_and_055_agree_on_the_checks` pins the two
# together on the migration's SOURCE text.
SCHEME_CHECK_SQL = "scheme IN (" + ",".join(f"'{s}'" for s in BADGE_SCHEMES) + ")"
INTENSITY_CHECK_SQL = f"intensity >= {INTENSITY_RANGE[0]} AND intensity <= {INTENSITY_RANGE[1]}"
OPACITY_CHECK_SQL = f"opacity >= {OPACITY_RANGE[0]} AND opacity <= {OPACITY_RANGE[1]}"
SPEED_CHECK_SQL = f"speed >= {SPEED_RANGE[0]} AND speed <= {SPEED_RANGE[1]}"


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
        CheckConstraint(SCHEME_CHECK_SQL, name="ck_supplier_badges_scheme"),
        CheckConstraint(INTENSITY_CHECK_SQL, name="ck_supplier_badges_intensity"),
        CheckConstraint(OPACITY_CHECK_SQL, name="ck_supplier_badges_opacity"),
        CheckConstraint(SPEED_CHECK_SQL, name="ck_supplier_badges_speed"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # No index of its own: `uq_supplier_badges_family` is (supplier_id, family)
    # with supplier_id LEADING, so every `WHERE supplier_id = ?` lookup is
    # already served from it. A second index would be pure write cost.
    supplier_id = Column(
        UUID(as_uuid=True),
        ForeignKey("suppliers.id", ondelete="CASCADE"),
        nullable=False,
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
    # Pulsing badge only (founder_badge_2): seconds per prestige cycle. Kept on
    # the same row as the fire fields so switching artwork keeps both looks.
    speed = Column(Numeric(3, 1), nullable=False, default=Decimal("2.6"))
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
