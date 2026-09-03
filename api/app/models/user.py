import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, Column, DateTime, Enum, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Customers sign up with a name, not a username (D7): username is
    # lower(email) for them, so it must hold an address.
    username = Column(String(255), unique=True, nullable=False)
    # Recovery address for forgot-password / forgot-username, and (alembic
    # 022) the case-insensitive login identifier — required + unique on
    # lower(email) via the `uq_users_email_lower` index below. (alembic 015)
    email = Column(String(255), nullable=False, index=True)
    password_hash = Column(String(200), nullable=False)
    role = Column(
        Enum("admin", "user", "owner", "viewer", name="user_role", create_constraint=True),
        nullable=False,
        default="user",
    )
    supplier_id = Column(
        UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=True
    )
    first_name = Column(String(80), nullable=True)
    last_name = Column(String(80), nullable=True)
    # NULL = the mailbox has not been proved. Set by POST /api/auth/verify.
    email_verified_at = Column(DateTime(timezone=True), nullable=True)
    # NULL = awaiting staff approval (D17). NOT the same as verification:
    # verified means "they own that mailbox", activated means "we said yes".
    # Only consulted for CUSTOMER_ROLES — staff are never gated on it.
    activated_at = Column(DateTime(timezone=True), nullable=True)
    signup_ip = Column(String(45), nullable=True)  # longest IPv6 text form
    signup_country = Column(String(2), nullable=True)  # ISO alpha-2, DB-IP
    # D18: capability is the LINKS, not a type enum. Neither = free;
    # supplier_id = distributor; manufacturer_id = maker; BOTH = a company
    # that does both (Avnet). Staff-set only — no request body sets these.
    manufacturer_id = Column(
        UUID(as_uuid=True), ForeignKey("manufacturers.id"), nullable=True
    )
    # Which KPI the customer console's chart tile is showing (migration 045).
    # NULL = the registry's default. A plain VARCHAR rather than an enum
    # because the KPI registry is expected to grow, and a stored key that the
    # registry no longer offers must fall back to the default rather than
    # break the page — so the validity check lives at the write site.
    dashboard_kpi = Column(String(40), nullable=True)
    # Admin presence heartbeat (alembic 021) — see routes/admin_presence.py.
    # Nullable: only stamped while an admin has the console open.
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    # Auth hardening (alembic 022). must_change_password forces a reset on
    # next login once a later task enforces it (set true for accounts whose
    # credentials that migration rotated out from under them).
    # password_changed_at is stamped ONLY by a real password change/reset;
    # None means "no constraint" to the session-invalidation check
    # (auth_service.token_predates_password_change). Migration 022 deliberately
    # does NOT backfill it — stamping now() would have invalidated every live
    # session at deploy.
    must_change_password = Column(Boolean, nullable=False, default=False)
    password_changed_at = Column(DateTime(timezone=True), nullable=True, default=None)
    # P3 mailbox push-sync drift flag (alembic 023). True means "the site's
    # password changed but the mail box did NOT get it" — the site is always
    # the source of truth, so a failed push never blocks the change, it just
    # records that the mailbox is behind. app/services/mail_sync.py sets it,
    # the next successful login retries and clears it, and /api/auth/me
    # surfaces it so the drift is visible rather than silent.
    mail_sync_pending = Column(Boolean, nullable=False, default=False)
    # Sign-in history (alembic 024). Each successful login SHIFTS last_* into
    # prev_* and stamps itself into last_*, because the useful reading of "last
    # sign-in" is the one BEFORE the current session — telling someone they
    # signed in four seconds ago is not information, telling them where the
    # previous session came from is. The console renders the prev_* pair.
    # NULL means "never recorded", which is the truth for every pre-024 row and
    # for a first-ever sign-in; the UI says so instead of printing a zero date.
    # The address comes from rate_limit.client_ip (X-Real-IP, written by nginx)
    # — never the caller-supplied X-Forwarded-For, which would let an attacker
    # choose the evidence. 45 chars is the longest IPv6 text form.
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    last_login_ip = Column(String(45), nullable=True)
    prev_login_at = Column(DateTime(timezone=True), nullable=True)
    prev_login_ip = Column(String(45), nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )

    supplier = relationship("Supplier")

    # Case-insensitive uniqueness on email (alembic 022). SQLite (test
    # suite, via Base.metadata.create_all) honors functional/expression
    # unique indexes same as Postgres, so this is genuinely exercised in
    # tests — see tests/test_auth_hardening.py — not just a migration-only
    # artifact.
    __table_args__ = (Index("uq_users_email_lower", func.lower(email), unique=True),)
