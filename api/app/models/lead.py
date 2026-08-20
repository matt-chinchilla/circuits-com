import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


def _now():
    return datetime.now(UTC)


class Lead(Base):
    """A person (or company placeholder) on the sales call list. ADMIN-ONLY
    data — never referenced by any public router (test_leads_never_public).
    No FK into the --reseed TRUNCATE graph; manufacturer link optional and
    ~95% NULL by measurement."""

    __tablename__ = "leads"
    __table_args__ = (
        Index("uq_leads_source_key", "source_key", unique=True),
        Index("ix_leads_company_slug", "company_slug"),
        Index("ix_leads_last_outcome", "last_outcome"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_key = Column(String(300), nullable=False)  # canon("Company|Contact") — idempotency key
    company_name = Column(String(200), nullable=False)  # branch string verbatim
    branch_label = Column(String(80), nullable=True)
    company_slug = Column(String(220), nullable=False)  # paren-stripped canon
    manufacturer_id = Column(
        UUID(as_uuid=True), ForeignKey("manufacturers.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    tier = Column(String(1), nullable=True)  # S/M/L
    ring = Column(String(12), nullable=True)  # STRING — 'UNVERIFIED' is a real value
    street = Column(String(200), nullable=True)
    city = Column(String(80), nullable=True)
    state = Column(String(2), nullable=True)
    postal_code = Column(String(10), nullable=True)
    main_phone = Column(String(24), nullable=True)
    website = Column(String(200), nullable=True)
    sales_email = Column(String(200), nullable=True)
    contact_name = Column(String(120), nullable=True)  # NULL == needs_enrichment row
    needs_enrichment = Column(Boolean, nullable=False, default=False)
    contact_title = Column(String(120), nullable=True)
    direct_phone = Column(String(24), nullable=True)
    contact_email = Column(String(200), nullable=True)
    linkedin_url = Column(String(300), nullable=True)
    hours_tz = Column(String(40), nullable=True)
    notes = Column(Text, nullable=True)
    # Denorms, written ONLY by services.leads.record_outcome in one txn.
    last_outcome = Column(String(12), nullable=True)
    last_contacted_at = Column(DateTime(timezone=True), nullable=True)
    contact_attempts = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)

    contacts = relationship(
        "LeadContact", back_populates="lead", lazy="selectin",
        order_by="LeadContact.created_at.desc()",
    )


class LeadContact(Base):
    """Append-only outcome history. recorded_by is a FREE STRING username
    (Sponsor.sold_by precedent) — an FK to users would join the reseed graph."""

    __tablename__ = "lead_contacts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lead_id = Column(
        UUID(as_uuid=True), ForeignKey("leads.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    outcome = Column(String(12), nullable=False)  # converted | maybe | rejected (VARCHAR, activity_event precedent)
    sale_tier = Column(String(10), nullable=True)  # a LABEL — never writes a sponsor row (L7)
    note = Column(String(500), nullable=True)
    recorded_by = Column(String(120), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False, index=True)

    lead = relationship("Lead", back_populates="contacts")
