"""Shared company calendar — /api/calendar/*

Design: ``docs/superpowers/specs/2026-08-04-shared-calendar-design.md``.

Four routes, all behind ONE dependency (:func:`require_calendar_access`):

    GET    /api/calendar/events?from=&to=
    POST   /api/calendar/events
    PATCH  /api/calendar/events/{id}
    DELETE /api/calendar/events/{id}

**Two doors only: the plugin's shared secret, or an admin bearer token.**
This module publishes the company's meeting schedule — titles, times, join
links — so every route takes one dependency that refuses anything else, and a
route added later cannot forget. (Migration 043 retired the public demo
account, which is why the demo carve-out that used to live here is gone.)

Schemas live in this module rather than ``app/schemas/`` on the
``admin_presence.py`` precedent: they have exactly one consumer, and the
repo's ≥2-consumer rule for shared homes cuts the same way on the backend.
"""

from __future__ import annotations

import hmac
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import CalendarEvent, User
from app.models.calendar_event import (
    as_utc,
    clear_reminder_ledger,
    validate_optional_http_url,
)
from app.services.auth_service import (
    get_authenticated_user,
    get_current_user,
    security,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

# The header the Roundcube plugin may present instead of a user bearer token.
# Both this and `Authorization: Bearer <secret>` are accepted and compared
# against the SAME configured value with the same constant-time comparison, so
# neither is weaker: the bearer form mirrors the existing MAIL_SYNC_SECRET
# channel between these two boxes, while the named header is unambiguous for a
# PHP client that would otherwise have to reason about JWT-vs-secret.
CALENDAR_SECRET_HEADER = "X-Calendar-Secret"
# Who the plugin says is acting. Only ever read AFTER the secret matched.
CALENDAR_ACTOR_HEADER = "X-Calendar-Actor"


# ── Auth ────────────────────────────────────────────────────────────────────


def _plugin_secret_matches(presented: str | None) -> bool:
    """Constant-time check of a presented secret against CALENDAR_API_SECRET.

    Returns False whenever the secret is UNCONFIGURED, whatever was presented.
    An empty configured secret matching an empty header would turn "the
    operator hasn't set this up yet" into "the calendar is public", which is
    the single worst failure this endpoint could have.
    """
    configured = (settings.CALENDAR_API_SECRET or "").strip()
    if not configured:
        return False
    candidate = (presented or "").strip()
    if not candidate:
        return False
    # Compare BYTES, not str: hmac.compare_digest raises TypeError on str
    # arguments containing any character above U+007F, so a single 0x80+ byte
    # in this header turned an unauthenticated request into a 500 with a
    # traceback, on all four routes, for anyone with curl.
    #
    # The two sides are decoded by DIFFERENT codecs and must be re-encoded by
    # the codec each one came through, or a non-ASCII secret can never match:
    # Starlette decodes header bytes as latin-1, while os.environ decodes as
    # UTF-8. Encoding both as UTF-8 double-encodes the header —
    # b's\xc3\xa9' arrives, becomes 's\xc3\xa9' as text, and re-encodes to
    # b's\xc3\x83\xc2\xa9'. Latent today because the documented way to generate
    # this value (secrets.token_urlsafe) is pure ASCII, and it fails closed
    # either way; but an operator using a passphrase would have hit a 401 with
    # a correct secret and no way to tell why.
    return hmac.compare_digest(
        candidate.encode("latin-1", "replace"), configured.encode("utf-8")
    )


def _resolve_actor(db: Session, presented_email: str | None) -> User | None:
    """Map the plugin's actor header to a real user, or None.

    Deliberately forgiving: an address that matches nobody, or a missing
    header, yields None and the event is simply unattributed. Attribution is a
    nicety and must never be able to fail a calendar write.

    """
    email = (presented_email or "").strip().lower()
    if not email:
        return None
    user = db.query(User).filter(func.lower(User.email) == email).first()
    if user is None:
        return None
    return user


def require_calendar_access(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    x_calendar_secret: str | None = Header(default=None, alias=CALENDAR_SECRET_HEADER),
    x_calendar_actor: str | None = Header(default=None, alias=CALENDAR_ACTOR_HEADER),
    db: Session = Depends(get_db),
) -> User | None:
    """THE calendar gate. Returns the acting user, or None for the plugin.

    Two ways in, and nothing else:

    1. **The Roundcube plugin**, server-side from PHP, with the shared secret.
       No user, no CORS, and no credential in a webmail user's browser.
    2. **A signed-in admin**, with the ordinary bearer token — which keeps the
       forced-password-change gate and the rest of the auth model unchanged,
       because this defers to ``get_current_user`` for it.

    Every failure (no credentials, bad token, expired session) is
    ``get_authenticated_user``'s 401 — this function never opens a path that
    one would have closed.
    """
    presented_bearer = credentials.credentials if credentials is not None else None
    if _plugin_secret_matches(x_calendar_secret) or _plugin_secret_matches(presented_bearer):
        # The plugin says who is acting. Trusting this header is safe ONLY
        # because we are inside the branch where the shared secret already
        # matched: the secret authenticates the caller, and the header is then
        # attribution from a trusted server, not a claim from a browser. It is
        # unreachable without the secret.
        #
        # Without it every event the webmail created — which is every event —
        # was written with created_by_id NULL, leaving the column, its foreign
        # key and the response field permanently empty.
        return _resolve_actor(db, x_calendar_actor)

    user = get_authenticated_user(credentials=credentials, db=db)
    # Everything else the platform already enforces — the must_change_password
    # 403 above all — comes from the shared dependency, not a copy of it.
    return get_current_user(user)


# ── Schemas ─────────────────────────────────────────────────────────────────


class CalendarEventResponse(BaseModel):
    id: uuid.UUID
    title: str
    starts_at: datetime
    ends_at: datetime
    all_day: bool
    location: str | None = None
    meeting_url: str | None = None
    notes: str | None = None
    remind_day_before: bool
    remind_hour_before: bool
    notify_email: bool
    notify_sms: bool
    created_by_id: uuid.UUID | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)

    @field_validator("starts_at", "ends_at", "created_at", "updated_at", mode="before")
    @classmethod
    def _stamp_utc(cls, v):
        """Re-stamp UTC on the way out.

        SQLite returns NAIVE datetimes for a ``DateTime(timezone=True)`` column
        (Postgres returns aware ones), so without this the same event
        serializes as ``...T14:00:00`` on one backend and ``...T14:00:00Z`` on
        the other — and a PHP client parsing the first in server-local time
        would draw the meeting in the wrong hour.
        """
        return as_utc(v) if isinstance(v, datetime) else v


class CalendarEventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    starts_at: datetime
    ends_at: datetime
    all_day: bool = False
    location: str | None = Field(default=None, max_length=200)
    meeting_url: str | None = None
    notes: str | None = None
    remind_day_before: bool = True
    remind_hour_before: bool = True
    notify_email: bool = True
    notify_sms: bool = False

    @field_validator("starts_at", "ends_at", mode="after")
    @classmethod
    def _to_utc(cls, v: datetime) -> datetime:
        """Normalize to aware-UTC at the boundary.

        Non-negotiable: SQLAlchemy's SQLite DATETIME binding DROPS a tzinfo
        offset instead of converting it, so a `+02:00` payload would be stored
        as 14:00 UTC on Postgres and 14:00 local-wall-clock in the test suite.
        Normalizing here means the column only ever holds UTC.
        """
        return as_utc(v)

    @field_validator("meeting_url", mode="after")
    @classmethod
    def _check_url(cls, v: str | None) -> str | None:
        return validate_optional_http_url(v)


class CalendarEventUpdate(BaseModel):
    """All-optional PATCH body — the router uses ``exclude_unset=True`` so an
    omitted field is left untouched (vs. explicitly set to null)."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    all_day: bool | None = None
    location: str | None = Field(default=None, max_length=200)
    meeting_url: str | None = None
    notes: str | None = None
    remind_day_before: bool | None = None
    remind_hour_before: bool | None = None
    notify_email: bool | None = None
    notify_sms: bool | None = None

    @field_validator("starts_at", "ends_at", mode="after")
    @classmethod
    def _to_utc(cls, v: datetime | None) -> datetime | None:
        return as_utc(v)

    @field_validator("meeting_url", mode="after")
    @classmethod
    def _check_url(cls, v: str | None) -> str | None:
        return validate_optional_http_url(v)


# Columns backing NOT NULL database columns: an explicit `null` for one of
# these would only surface as a 500 IntegrityError at commit, so it is a 422.
_NON_NULLABLE_FIELDS = (
    "title",
    "starts_at",
    "ends_at",
    "all_day",
    "remind_day_before",
    "remind_hour_before",
    "notify_email",
    "notify_sms",
)


# ── Helpers ─────────────────────────────────────────────────────────────────


def _parse_event_id(event_id: str) -> uuid.UUID:
    """Path-param id → UUID. A malformed id is treated as not-found (404).

    Matches admin_expenses/admin_sponsors: under SQLite the ORM needs a real
    UUID to build the WHERE clause (a bare str throws "'str' has no attribute
    'hex'").
    """
    try:
        return uuid.UUID(event_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="Event not found") from None


def _get_or_404(db: Session, event_id: str) -> CalendarEvent:
    event = db.query(CalendarEvent).filter(CalendarEvent.id == _parse_event_id(event_id)).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


def _check_range(starts_at: datetime, ends_at: datetime) -> None:
    if ends_at < starts_at:
        raise HTTPException(status_code=422, detail="ends_at must not precede starts_at.")


# ── Routes ──────────────────────────────────────────────────────────────────


@router.get("/events", response_model=list[CalendarEventResponse])
def list_events(
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    db: Session = Depends(get_db),
    actor: User | None = Depends(require_calendar_access),
):
    """Events OVERLAPPING the window, oldest first.

    Overlap, not containment: a Monday-to-Friday all-day event has to appear
    when the month grid asks for the week it straddles, and an event that
    started before the window but has not ended is exactly the one someone
    opening the calendar wants to see. Both bounds are optional; omitting them
    returns everything.

    ``from`` is a Python keyword, hence the ``from_``/alias pair.
    """
    query = db.query(CalendarEvent)
    window_start = as_utc(from_)
    window_end = as_utc(to)
    if window_start is not None:
        query = query.filter(CalendarEvent.ends_at >= window_start)
    if window_end is not None:
        query = query.filter(CalendarEvent.starts_at <= window_end)
    return query.order_by(CalendarEvent.starts_at.asc()).all()


@router.post("/events", response_model=CalendarEventResponse, status_code=status.HTTP_201_CREATED)
def create_event(
    body: CalendarEventCreate,
    db: Session = Depends(get_db),
    actor: User | None = Depends(require_calendar_access),
):
    _check_range(body.starts_at, body.ends_at)
    event = CalendarEvent(
        id=uuid.uuid4(),
        created_by_id=actor.id if actor is not None else None,
        **body.model_dump(),
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@router.patch("/events/{event_id}", response_model=CalendarEventResponse)
def update_event(
    event_id: str,
    body: CalendarEventUpdate,
    db: Session = Depends(get_db),
    actor: User | None = Depends(require_calendar_access),
):
    event = _get_or_404(db, event_id)
    update_data = body.model_dump(exclude_unset=True)

    nulled_required = [
        f for f in _NON_NULLABLE_FIELDS if f in update_data and update_data[f] is None
    ]
    if nulled_required:
        raise HTTPException(
            status_code=422,
            detail=f"These fields cannot be null: {', '.join(sorted(nulled_required))}.",
        )

    # Validate the POST-update range so a partial PATCH that moves only one
    # endpoint cannot invert the event.
    _check_range(
        update_data.get("starts_at") or as_utc(event.starts_at),
        update_data.get("ends_at") or as_utc(event.ends_at),
    )

    # RESCHEDULING CLEARS THE LEDGER. Moving a meeting to a new time must let
    # its reminders fire again — otherwise the old ledger rows silently swallow
    # both of them, and the failure mode is invisible (nothing errors, the mail
    # simply never arrives). Compared against the stored value so a PATCH that
    # merely re-sends the same starts_at does NOT re-arm an already-sent
    # reminder.
    new_start = update_data.get("starts_at")
    rescheduled = new_start is not None and as_utc(new_start) != as_utc(event.starts_at)
    if rescheduled:
        cleared = clear_reminder_ledger(db, event.id)
        if cleared:
            logger.info(
                "[calendar] event %s rescheduled — cleared %d reminder ledger row(s)",
                event.id,
                cleared,
            )

    for key, value in update_data.items():
        setattr(event, key, value)

    db.commit()
    db.refresh(event)
    return event


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_event(
    event_id: str,
    db: Session = Depends(get_db),
    actor: User | None = Depends(require_calendar_access),
):
    event = _get_or_404(db, event_id)
    # Explicit, not just the FK's ON DELETE CASCADE: SQLite only honors that
    # with PRAGMA foreign_keys=ON, and an orphaned ledger row would suppress a
    # reminder for a recycled id.
    clear_reminder_ledger(db, event.id)
    db.delete(event)
    db.commit()
