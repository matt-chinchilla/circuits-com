"""Shared company calendar — the events table and the reminder idempotency ledger.

Design: ``docs/superpowers/specs/2026-08-04-shared-calendar-design.md``.

**There is no owner column, and that is the design.** Shared is the default
state rather than something configured per event: five people do not need
per-user visibility, and adding it later is a migration, not a rewrite.
``created_by_id`` records authorship for the UI, nothing more — it is nullable
with ``ON DELETE SET NULL`` so removing a user never takes the company's
meetings with them.

``calendar_reminder_sends`` is the idempotency ledger, and its
``UNIQUE(event_id, kind, channel)`` is the whole point of the table. The
reminder job is a cron that may run late, twice, or overlap itself; the
DATABASE — not the job's own bookkeeping — is what guarantees one send. See
``app/jobs/send_reminders.py``, which INSERTs the row first and lets the
constraint arbitrate.

Two pure helpers live here rather than in the router, for the same reason
``is_single_slot`` lives in ``models/sponsor.py``: they are the semantics of a
column, and more than one call site needs them (the write boundary in
``routes/calendar.py``, the render/compose side in ``services/email.py``, and
the reminder job).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from urllib.parse import urlparse

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Session

from app.db.session import Base

# The two reminder lead times, and the two delivery channels. Single home —
# `app/jobs/send_reminders.py` builds its windows from these and the ledger's
# `kind`/`channel` values are drawn from them, so the sets cannot drift.
REMINDER_KINDS: tuple[str, ...] = ("day_before", "hour_before")
REMINDER_CHANNELS: tuple[str, ...] = ("email", "sms")

# `meeting_url` is TEXT in the database (a Teams/Meet link with a passcode is
# routinely 300+ chars), but an unbounded field that ends up in an href is a
# denial-of-service on every render site. 2048 is the practical browser ceiling.
MAX_MEETING_URL_LEN = 2048


def as_utc(value: datetime | None) -> datetime | None:
    """Normalize a datetime to aware-UTC; ``None`` passes through.

    Postgres hands back aware datetimes for a ``DateTime(timezone=True)``
    column; SQLite — which is what ``Base.metadata.create_all`` gives the test
    suite — hands back NAIVE ones for the same column, and its DATETIME binding
    DROPS a tzinfo offset rather than converting it. So every value crossing
    this boundary is normalized to UTC on the way IN (the router's schemas) and
    re-stamped as UTC on the way OUT, or a `+02:00` event would be stored as
    14:00 UTC on Postgres and 14:00 local-wall-clock on SQLite.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def validate_optional_http_url(value: str | None) -> str | None:
    """Pydantic validator: allow None and http(s) URLs; reject everything else.

    The URL sibling of ``app/utils/image_url.py``'s
    ``validate_optional_image_url``, minus the ``data:`` allowance — a meeting
    link is never a data URI. ``meeting_url`` becomes an ``href`` in the
    Roundcube plugin, and a stored ``javascript:`` in a field that becomes an
    href is the exact stored-XSS shape this repo has already shipped once (see
    the ``safeHttpUrl`` gotcha in CLAUDE.md). Guarded at BOTH ends: this raises
    a 422 at the write boundary, and :func:`safe_meeting_url` hides anything
    hostile that predates the guard at every read site.
    """
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        # An empty string from a cleared form field means "no link", not "".
        return None
    if len(trimmed) > MAX_MEETING_URL_LEN:
        raise ValueError(f"meeting URL too long (max {MAX_MEETING_URL_LEN} chars)")
    parsed = urlparse(trimmed)
    # netloc is required as well as the scheme: "http:evil" parses with
    # scheme="http" and no host, which is not a link anyone can follow.
    if parsed.scheme.lower() in ("http", "https") and parsed.netloc:
        return trimmed
    raise ValueError("meeting_url must be an http(s) URL")


def safe_meeting_url(value: str | None) -> str | None:
    """Read-side twin of :func:`validate_optional_http_url` — returns the URL
    when it is safe to render/print, ``None`` otherwise. Never raises.

    Defense in depth: rows written before the validator existed (or by hand in
    psql) must not be able to smuggle a ``javascript:`` payload into a link.
    """
    try:
        return validate_optional_http_url(value)
    except ValueError:
        return None


class CalendarEvent(Base):
    __tablename__ = "calendar_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String(200), nullable=False)
    # Indexed: every read (the month window) and every reminder-job pass
    # filters on starts_at and nothing else.
    starts_at = Column(DateTime(timezone=True), nullable=False, index=True)
    ends_at = Column(DateTime(timezone=True), nullable=False)
    all_day = Column(Boolean, nullable=False, default=False)
    location = Column(String(200), nullable=True)
    meeting_url = Column(Text, nullable=True)
    notes = Column(Text, nullable=True)
    # Per-event reminder switches. remind_* choose WHEN, notify_* choose HOW,
    # and each suppresses independently — `remind_day_before=False` kills both
    # channels for that lead time, `notify_sms=False` kills SMS for both.
    remind_day_before = Column(Boolean, nullable=False, default=True)
    remind_hour_before = Column(Boolean, nullable=False, default=True)
    notify_email = Column(Boolean, nullable=False, default=True)
    # SMS is OFF by default: the reason is setup friction and the risk of a
    # loop spending real money, not the ~$0.0065 unit price.
    notify_sms = Column(Boolean, nullable=False, default=False)
    created_by_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
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


class CalendarReminderSend(Base):
    """One row per (event, lead time, channel) that has actually been sent.

    The unique constraint below is the idempotency guarantee. Nothing else is:
    the job does not remember what it did, and must not — it can be run twice
    concurrently, or an hour late after a missed tick, and the second attempt
    has to lose at the database rather than at an in-process set.
    """

    __tablename__ = "calendar_reminder_sends"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id = Column(
        UUID(as_uuid=True),
        ForeignKey("calendar_events.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Plain VARCHARs, not native enums: the value sets live in REMINDER_KINDS /
    # REMINDER_CHANNELS above and adding one must not need an ALTER TYPE (and
    # Postgres enum values can never be removed). Same call the `expenses`
    # table made for `category`.
    kind = Column(String(16), nullable=False)
    channel = Column(String(8), nullable=False)
    sent_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )

    # `index=True` on event_id above already declares
    # ix_calendar_reminder_sends_event_id — do NOT restate it here, or
    # create_all emits the CREATE INDEX twice and SQLite refuses the second.
    __table_args__ = (
        UniqueConstraint(
            "event_id",
            "kind",
            "channel",
            name="uq_calendar_reminder_sends_event_kind_channel",
        ),
    )


def clear_reminder_ledger(db: Session, event_id: uuid.UUID) -> int:
    """Delete every ledger row for an event; returns how many were removed.

    Called when an event is RESCHEDULED. Without it, moving a meeting from
    Tuesday to Thursday leaves the Tuesday ledger rows in place and both
    reminders are silently swallowed against the new time — the failure mode is
    invisible (nothing errors, the mail simply never arrives), which is exactly
    why it gets its own named function and its own test.

    Deliberately unconditional: it clears BOTH kinds and BOTH channels. A move
    of any size invalidates every lead time that was computed from the old
    start, and "did the day-before window already pass under the new time?" is
    the job's question to answer, not this function's.
    """
    removed = (
        db.query(CalendarReminderSend).filter(CalendarReminderSend.event_id == event_id).delete()
    )
    return int(removed or 0)
