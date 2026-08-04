"""Calendar reminder cron — the day-before and hour-before sends.

Design: ``docs/superpowers/specs/2026-08-04-shared-calendar-design.md``.
Invoked on the API box as::

    docker compose exec -T api python -m app.jobs.send_reminders < /dev/null

Three properties shape every line below, and each is a test:

**1. Windows are a LOOKBACK RANGE, not an instant.** A cron tick that runs
late — or one that is missed entirely because the box was rebooting — must
still deliver. So a reminder is due when its send moment has ALREADY PASSED but
by no more than ``CALENDAR_REMINDER_LOOKBACK_MINUTES``. Expressed on the column
that is actually indexed, that is ``starts_at`` in
``[now + lead - lookback, now + lead]``. Matching an instant instead would mean
every tick that landed a second off delivered nothing at all, silently.

The lookback is CLAMPED to the lead time per kind, so the hour-before window
can never reach past an event's own start; a "your meeting is in an hour"
message about a meeting that began twenty minutes ago is worse than none.

**2. The DATABASE is the idempotency arbiter, not this job.** Each (event,
kind, channel) is claimed by INSERTing a ``calendar_reminder_sends`` row and
committing BEFORE the send. A duplicate loses to
``uq_calendar_reminder_sends_event_kind_channel`` — an IntegrityError, which is
the answer, not an error. That holds whether the duplicate came from a second
tick inside the same window, a re-run, or two overlapping processes; an
in-process "already sent" set would only have covered the first.

Claim-then-send is at-MOST-once on purpose. A send that fails after the claim
is logged loudly and NOT retried inside the window: removing the claim to allow
a retry would reopen the exact double-send this table exists to prevent, and
five people getting one late reminder beats five people getting four.

**3. A missing channel is inert, never fatal.** With ``SMS_TOPIC_ARN`` unset,
SMS is skipped WITHOUT claiming a ledger row (claiming one would suppress the
send forever once someone did configure a topic) and email is untouched.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import SessionLocal
from app.models.calendar_event import (
    CalendarEvent,
    CalendarReminderSend,
    as_utc,
    safe_meeting_url,
)
from app.services import email as email_service
from app.services import sms as sms_service

logger = logging.getLogger(__name__)

# lead time each reminder kind fires at, and the human label that goes in the
# subject line. Order matters only for log readability.
LEAD_TIMES: dict[str, timedelta] = {
    "day_before": timedelta(days=1),
    "hour_before": timedelta(hours=1),
}
LEAD_LABELS: dict[str, str] = {
    "day_before": "tomorrow",
    "hour_before": "in 1 hour",
}
# Which per-event toggle switches each kind off.
KIND_TOGGLE: dict[str, str] = {
    "day_before": "remind_day_before",
    "hour_before": "remind_hour_before",
}


def _now() -> datetime:
    """Clock seam — tests inject their own `now` instead of monkeypatching."""
    return datetime.now(UTC)


def _lookback(kind: str, configured: timedelta | None = None) -> timedelta:
    """The lookback for one kind, clamped to that kind's lead time.

    Unclamped, a 90-minute lookback would make the hour-before window start at
    ``now - 30min`` — i.e. it would fire for events that have already begun.
    Clamping keeps every window strictly on the future side of ``starts_at``.
    """
    base = configured
    if base is None:
        base = timedelta(minutes=max(0, int(settings.CALENDAR_REMINDER_LOOKBACK_MINUTES)))
    return min(base, LEAD_TIMES[kind])


@dataclass(frozen=True)
class _Due:
    """A snapshot of one event, taken BEFORE any claim is attempted.

    Plain values, not an ORM object: a losing claim ends in
    ``session.rollback()``, which expires every instance in the session, and
    reading ``event.title`` afterwards would silently re-SELECT mid-loop.
    """

    event_id: uuid.UUID
    title: str
    starts_at: datetime
    ends_at: datetime
    all_day: bool
    location: str | None
    meeting_url: str | None
    notes: str | None
    notify_email: bool
    notify_sms: bool


def find_due(
    db: Session, kind: str, now: datetime, lookback: timedelta | None = None
) -> list[_Due]:
    """Events whose ``kind`` reminder is due in the lookback window.

    Filters on the per-event ``remind_*`` toggle here rather than after the
    fetch, so a switched-off reminder costs nothing and can never be claimed.
    """
    lead = LEAD_TIMES[kind]
    back = _lookback(kind, lookback)
    window_end = now + lead
    window_start = window_end - back

    toggle = getattr(CalendarEvent, KIND_TOGGLE[kind])
    rows = (
        db.query(CalendarEvent)
        .filter(
            toggle.is_(True),
            CalendarEvent.starts_at >= window_start,
            CalendarEvent.starts_at <= window_end,
        )
        .order_by(CalendarEvent.starts_at.asc())
        .all()
    )
    return [
        _Due(
            event_id=row.id,
            title=row.title,
            starts_at=as_utc(row.starts_at),
            ends_at=as_utc(row.ends_at),
            all_day=bool(row.all_day),
            location=row.location,
            meeting_url=safe_meeting_url(row.meeting_url),
            notes=row.notes,
            notify_email=bool(row.notify_email),
            notify_sms=bool(row.notify_sms),
        )
        for row in rows
    ]


def claim(db: Session, event_id: uuid.UUID, kind: str, channel: str) -> bool:
    """Try to take the (event, kind, channel) slot. True iff THIS run won it.

    The commit is what makes the claim visible to a concurrent run, so it
    happens before the send rather than at the end of the pass. A losing claim
    raises IntegrityError from the unique constraint — that is the mechanism,
    not a failure, so it is caught and reported as ``False``.
    """
    row = CalendarReminderSend(
        id=uuid.uuid4(),
        event_id=event_id,
        kind=kind,
        channel=channel,
        sent_at=datetime.now(UTC),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return False
    return True


def _email_recipients() -> list[str]:
    """The roster, cleaned. Empty means email is not deliverable at all."""
    return [r.strip() for r in settings.CALENDAR_RECIPIENTS if r and r.strip()]


def _send_email(due: _Due, kind: str) -> bool:
    recipients = _email_recipients()

    # Both "no relay" and "nobody to send to" are filtered in _channels_for,
    # BEFORE a claim is taken — reaching here means a real attempt is possible.
    #
    # An attempt that fails must still be REPORTED as failed, which it was not:
    # this returned True unconditionally, so a refused relay produced a "sent"
    # counter and a cheerful log line while the reminder was gone. The claim is
    # deliberately kept in that case (at-most-once — see the module docstring);
    # what changed is that the operator now learns about it.
    #
    # asyncio.run per message: this is a short-lived job, not a server, and one
    # loop for the whole pass buys nothing at five people and two reminders.
    try:
        delivered = asyncio.run(
            email_service.send_event_reminder(
                recipients,
                title=due.title,
                starts_at=due.starts_at,
                ends_at=due.ends_at,
                all_day=due.all_day,
                location=due.location,
                meeting_url=due.meeting_url,
                notes=due.notes,
                lead_label=LEAD_LABELS[kind],
            )
        )
    except Exception:
        logger.exception("[calendar] reminder email failed for %r", due.title)
        return False
    # _smtp_send catches its own SMTP errors rather than raising (its other
    # callers are BackgroundTasks), so the try/except above is not enough on
    # its own — a dead relay returns normally. The bool is the real signal.
    return bool(delivered)


def _send_sms(due: _Due, kind: str) -> bool:
    # Same clock as the email. These were formatted independently — email
    # through CALENDAR_TIMEZONE, SMS hard-coded to UTC — so one event with both
    # channels on told you "2:00 PM EDT" in the inbox and "18:00 UTC" on the
    # phone. Two different answers to "when is my meeting" is worse than either
    # answer alone.
    when = email_service.format_event_when(due.starts_at, due.ends_at, all_day=due.all_day)
    parts = [f"Reminder ({LEAD_LABELS[kind]}): {due.title}", when]
    if due.location:
        parts.append(due.location)
    if due.meeting_url:
        parts.append(due.meeting_url)
    return sms_service.send_sms(" | ".join(parts), subject=f"Reminder: {due.title}")


def _channels_for(due: _Due) -> list[str]:
    """Which channels this event wants, filtered by what is actually available.

    ``notify_sms`` on an unconfigured deployment yields NOTHING — and, crucially,
    no ledger row either, so arming a topic later does not find the slot already
    taken by a send that never happened.
    """
    channels: list[str] = []
    if due.notify_email:
        # Symmetric with SMS below, and for the same reason. A claim is a
        # PROMISE that a delivery happened, so it must only be taken when a
        # delivery is actually possible — the UNIQUE constraint makes it
        # permanent, and a slot burned on a send that never occurred can never
        # be retried once the deployment is fixed.
        #
        # Two ways email can be undeliverable, and BOTH were found by running
        # this against the real stack rather than by reading it:
        #   - no relay (SMTP_HOST unset) puts app.services.email in demo mode,
        #     where it logs and returns without sending;
        #   - no roster (CALENDAR_RECIPIENTS empty) means there is nobody to
        #     send to. This one is easy to hit by accident: an empty compose
        #     default does not inherit the code default, it overwrites it.
        # Only a genuine attempt that then fails keeps its slot.
        if not settings.SMTP_HOST:
            logger.warning(
                "[calendar] event %s wants email but SMTP_HOST is unset — "
                "skipping without claiming, so it can still send once a relay exists",
                due.event_id,
            )
        elif not _email_recipients():
            logger.warning(
                "[calendar] event %s wants email but CALENDAR_RECIPIENTS is empty — "
                "skipping without claiming, so it can still send once a roster exists",
                due.event_id,
            )
        else:
            channels.append("email")
    if due.notify_sms:
        if sms_service.is_configured():
            channels.append("sms")
        else:
            logger.debug(
                "[calendar] event %s wants SMS but SMS_TOPIC_ARN is unset — skipping",
                due.event_id,
            )
    return channels


def run(
    db: Session,
    *,
    now: datetime | None = None,
    lookback: timedelta | None = None,
) -> dict[str, int]:
    """One pass. Returns a small counter dict for the log line and for tests."""
    moment = as_utc(now) or _now()
    stats = {"due": 0, "sent": 0, "skipped_duplicate": 0, "failed": 0}

    for kind in LEAD_TIMES:
        for due in find_due(db, kind, moment, lookback):
            stats["due"] += 1
            for channel in _channels_for(due):
                if not claim(db, due.event_id, kind, channel):
                    stats["skipped_duplicate"] += 1
                    continue
                try:
                    ok = _send_email(due, kind) if channel == "email" else _send_sms(due, kind)
                except Exception:
                    # The claim STAYS. See the module docstring: at-most-once
                    # is the deliberate trade, and this is logged loudly enough
                    # to notice in `docker logs api`.
                    logger.exception(
                        "[calendar] %s %s reminder raised for event %s",
                        kind,
                        channel,
                        due.event_id,
                    )
                    stats["failed"] += 1
                    continue
                if ok:
                    stats["sent"] += 1
                else:
                    stats["failed"] += 1
                    logger.warning(
                        "[calendar] %s %s reminder failed for event %s (claim kept)",
                        kind,
                        channel,
                        due.event_id,
                    )
    return stats


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    db = SessionLocal()
    try:
        stats = run(db)
    except OperationalError:
        # The database is not accepting connections yet. This loop starts
        # alongside everything else and Postgres is routinely still coming up.
        db.rollback()
        logger.warning("[calendar] database unreachable — skipping this pass")
        return 0
    except ProgrammingError as exc:
        # The tables do not exist yet. `alembic upgrade head` runs in the API
        # container's entrypoint, and nothing orders this loop after it — so on
        # a fresh deploy, or any deploy carrying a new migration, there is a
        # window where this job is running against a schema that has not caught
        # up. Observed on the very first boot of this service: an
        # UndefinedTable traceback, in full, every five minutes.
        #
        # Waiting quietly is right. The next pass is 300 seconds away, the work
        # is idempotent, and nothing is lost by missing one — whereas a
        # traceback on a five-minute timer trains everyone to ignore this
        # container's logs, which is where a real failure would appear.
        db.rollback()
        if "does not exist" in str(exc.orig).lower():
            logger.warning("[calendar] calendar tables are not migrated yet — skipping this pass")
            return 0
        raise
    finally:
        db.close()
    logger.info(
        "[calendar] reminder pass: due=%(due)d sent=%(sent)d "
        "duplicate=%(skipped_duplicate)d failed=%(failed)d",
        stats,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
