import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, Date, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


def _now():
    return datetime.now(UTC)


class Manufacturer(Base):
    """A component maker. NO FK into the --reseed TRUNCATE graph — load-bearing
    (test_leads_schema.test_reseed_fk_isolation). The supplier bridge lives on
    suppliers.manufacturer_id, pointing INTO this table, never out of it."""

    __tablename__ = "manufacturers"
    __table_args__ = (
        # The idempotency/auto-merge key. Unique INDEX (not constraint) declared
        # here so SQLite's create_all reproduces it (uq_users_email_lower precedent).
        Index("uq_manufacturers_canonical_key", "canonical_key", unique=True),
        Index("ix_manufacturers_name_lower", "name"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(200), nullable=False)
    slug = Column(String(220), nullable=False, unique=True)
    canonical_key = Column(String(220), nullable=False)
    website = Column(String(300), nullable=True)
    logo_url = Column(Text, nullable=True)  # never seeded (favicon churn); admin-set only
    description = Column(Text, nullable=True)
    # CSV figure ("Number of parts"), NEVER rendered as our parts count (L11).
    external_part_count = Column(Integer, nullable=True)
    external_part_count_source = Column(String(40), nullable=True)
    external_part_count_as_of = Column(Date, nullable=True)
    catalog_part_count = Column(Integer, nullable=False, default=0)
    source = Column(String(20), nullable=False, default="catalog")  # csv | catalog | manual
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)

    aliases = relationship("ManufacturerAlias", back_populates="manufacturer", lazy="selectin")


class ManufacturerAlias(Base):
    """A raw spelling accepted as this manufacturer. alias_canon is globally
    unique: one spelling can only ever resolve to one company."""

    __tablename__ = "manufacturer_aliases"
    __table_args__ = (Index("uq_manufacturer_aliases_canon", "alias_canon", unique=True),)

    manufacturer_id = Column(
        UUID(as_uuid=True), ForeignKey("manufacturers.id", ondelete="CASCADE"),
        primary_key=True, index=True,
    )
    alias_canon = Column(String(220), primary_key=True)
    alias = Column(String(200), nullable=False)
    source = Column(String(20), nullable=False)  # breakdown | catalog | slash-head | prefix | manual
    confidence = Column(String(10), nullable=False)  # auto | approved
    first_seen_at = Column(DateTime(timezone=True), default=_now, nullable=False)

    manufacturer = relationship("Manufacturer", back_populates="aliases")


class ManufacturerMergeCandidate(Base):
    """The review queue. NEVER auto-applied — a human approves or rejects.
    status='rejected' rows double as never-merge rules (Microchip USA)."""

    __tablename__ = "manufacturer_merge_candidates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    left_manufacturer_id = Column(
        UUID(as_uuid=True), ForeignKey("manufacturers.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    right_alias = Column(String(200), nullable=False)
    rule = Column(String(30), nullable=False)  # slash-head | prefix | csv-collision | never
    evidence = Column(Text, nullable=True)
    status = Column(String(12), nullable=False, default="pending")  # pending | approved | rejected
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)
