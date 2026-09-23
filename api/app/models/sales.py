"""Gold & Platinum sales (spec §6, migration 057).

Five tables:

* ``sales_codes`` — rep discount codes (Crockford base32, 8 chars, 1–15 points).
* ``checkout_intents`` — every Checkout Session we mint, all tiers. For Gold and
  Platinum an ``open`` row IS the slot hold: ``uq_live_exclusive_intent`` allows
  one per category (R2 — the hold is never a sponsor row, which would render).
* ``sponsor_billing`` — 1:1 beside the sponsor (R3: billing state on ``sponsors``
  would trip the webhook's stale-event gate). The ONLY new table with a foreign
  key to ``sponsors``; it cascades with the row and is an accepted reseed loss.
* ``sponsor_payments`` — the invoice mirror, keyed by Stripe invoice id; the
  sponsor is resolved lazily (an invoice can arrive before its sponsor exists).
* ``billing_audit`` — staff-only, append-only (R4: ``activity_events`` has no
  actor and is customer-readable).

Every table except ``sponsor_billing`` is FK-free toward sponsors / suppliers /
users / categories: those sit in ``--reseed``'s TRUNCATE cascade, and actors are
username strings (the ``sold_by`` precedent).
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID

from app.db.session import Base

# Literal on purpose: migration 057 keeps its own copies (a migration never
# imports app code) and test_sales_models.py pins the two on 057's source text.
CODE_POINTS_CHECK = "code_points >= 1 AND code_points <= 15"
MAX_USES_CHECK = "max_uses >= 1"
LIVE_EXCLUSIVE_WHERE = "status = 'open' AND tier IN ('gold','platinum')"

# A code lives two weeks unless the rep says otherwise (spec §6).
CODE_DEFAULT_DAYS = 14


def _now() -> datetime:
    return datetime.now(UTC)


class SalesCode(Base):
    __tablename__ = "sales_codes"
    __table_args__ = (
        CheckConstraint(CODE_POINTS_CHECK, name="ck_sales_codes_points"),
        CheckConstraint(MAX_USES_CHECK, name="ck_sales_codes_max_uses"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Stored normalised (upper, no dash); displayed XXXX-XXXX.
    code = Column(String(16), nullable=False, unique=True)
    code_points = Column(SmallInteger, nullable=False)
    # NULL = either exclusive tier; else 'gold' | 'platinum' (lowercase).
    tier = Column(String(10), nullable=True)
    # Placement lock. Plain UUID — categories is inside the reseed cascade.
    category_id = Column(UUID(as_uuid=True), nullable=True)
    # R7 binding to an existing company (requires email_lock). Plain UUID.
    supplier_id = Column(UUID(as_uuid=True), nullable=True)
    email_lock = Column(String(200), nullable=True)
    max_uses = Column(SmallInteger, nullable=False, default=1)
    uses = Column(SmallInteger, nullable=False, default=0)
    expires_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: _now() + timedelta(days=CODE_DEFAULT_DAYS),
    )
    rep = Column(String(120), nullable=False)
    created_by = Column(String(120), nullable=False)
    note = Column(String(500), nullable=True)
    active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_now)


class CheckoutIntent(Base):
    __tablename__ = "checkout_intents"
    __table_args__ = (
        # One live hold per exclusive slot. Gold holds a child, Platinum a
        # top-level category, so one index over both tiers is exact.
        Index(
            "uq_live_exclusive_intent",
            "category_id",
            unique=True,
            postgresql_where=text(LIVE_EXCLUSIVE_WHERE),
            sqlite_where=text(LIVE_EXCLUSIVE_WHERE),
        ),
        Index("ix_checkout_intents_status_expires", "status", "expires_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    stripe_session_id = Column(String(255), nullable=True, unique=True)
    release_token_hash = Column(String(64), nullable=True)
    tier = Column(String(10), nullable=False)
    category_id = Column(UUID(as_uuid=True), nullable=True)
    keyword = Column(String(100), nullable=True)
    sales_code_id = Column(UUID(as_uuid=True), ForeignKey("sales_codes.id"), nullable=True)
    supplier_id = Column(UUID(as_uuid=True), nullable=True)
    list_usd = Column(Integer, nullable=False)
    founder_usd = Column(Integer, nullable=False)
    price_usd = Column(Integer, nullable=False)
    channel = Column(String(20), nullable=False)
    sold_by = Column(String(120), nullable=True)
    company_name = Column(String(200), nullable=False)
    email = Column(String(200), nullable=False)
    website = Column(String(200), nullable=True)
    client_ip_hash = Column(String(64), nullable=True)
    # open | completed | expired | released | conflict (services/checkout_intents)
    status = Column(String(12), nullable=False, default="open")
    conflict_reason = Column(String(40), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_now)
    resolved_at = Column(DateTime(timezone=True), nullable=True)


class SponsorBilling(Base):
    __tablename__ = "sponsor_billing"

    sponsor_id = Column(
        UUID(as_uuid=True),
        ForeignKey("sponsors.id", ondelete="CASCADE"),
        primary_key=True,
    )
    stripe_customer_id = Column(String(64), nullable=True)
    stripe_subscription_id = Column(String(64), nullable=True)
    # charge_automatically | send_invoice
    collection_method = Column(String(30), nullable=False, default="charge_automatically")
    # self_serve | rep_code | quote
    channel = Column(String(20), nullable=False)
    list_usd = Column(Integer, nullable=False)
    founder_usd = Column(Integer, nullable=True)
    price_usd = Column(Integer, nullable=False)
    sales_code_id = Column(UUID(as_uuid=True), ForeignKey("sales_codes.id"), nullable=True)
    failing_since = Column(DateTime(timezone=True), nullable=True)
    card_link_version = Column(Integer, nullable=False, default=0)
    post_activation_done_at = Column(DateTime(timezone=True), nullable=True)
    # Spec §10.5: open invoices of a deleted subscription still to be voided.
    void_pending = Column(Boolean, nullable=False, server_default=text("false"), default=False)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)


class SponsorPayment(Base):
    __tablename__ = "sponsor_payments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    stripe_invoice_id = Column(String(64), nullable=False, unique=True)
    stripe_subscription_id = Column(String(64), nullable=False, index=True)
    # Resolved lazily (SA-F7): the first invoice can land before the sponsor.
    sponsor_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    stripe_payment_intent_id = Column(String(64), nullable=True)
    amount_due_cents = Column(Integer, nullable=False, default=0)
    amount_paid_cents = Column(Integer, nullable=False, default=0)
    amount_refunded_cents = Column(Integer, nullable=False, default=0)
    # paid | failed | refunded | partially_refunded | open (services/billing_mirror)
    status = Column(String(20), nullable=False)
    invoice_created_at = Column(DateTime(timezone=True), nullable=True)
    paid_at = Column(DateTime(timezone=True), nullable=True)
    hosted_invoice_url = Column(Text, nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, default=_now, onupdate=_now)


class BillingAudit(Base):
    __tablename__ = "billing_audit"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_at = Column(DateTime(timezone=True), nullable=False, default=_now, index=True)
    # A username, or system:webhook / system:sweep.
    actor = Column(String(120), nullable=False)
    sponsor_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    sales_code_id = Column(UUID(as_uuid=True), nullable=True)
    intent_id = Column(UUID(as_uuid=True), nullable=True)
    action = Column(String(40), nullable=False)
    amount_cents = Column(Integer, nullable=True)
    detail = Column(String(500), nullable=False, default="")
