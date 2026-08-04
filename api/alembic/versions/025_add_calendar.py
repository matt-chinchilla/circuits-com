"""Shared company calendar: calendar_events + calendar_reminder_sends

Design: docs/superpowers/specs/2026-08-04-shared-calendar-design.md

Two tables. `calendar_events` has NO owner column on purpose — shared is the
default state rather than something configured per event, and a company of five
does not need per-user visibility. `created_by_id` is authorship for the UI only:
nullable, ON DELETE SET NULL, so removing a user never deletes the company's
meetings.

`calendar_reminder_sends` exists for exactly one line of DDL — the
UNIQUE (event_id, kind, channel). The reminder cron may run late, twice, or
overlap itself, and this constraint is what guarantees one send; the job INSERTs
the row first and lets the database arbitrate rather than trusting its own
bookkeeping. ON DELETE CASCADE so deleting an event takes its ledger with it.

Raw SQL with IF NOT EXISTS rather than op.create_table, for the same reason as
022/023/024: alembic/env.py sets no `transaction_per_migration`, so a failure
partway through `upgrade head` leaves the api entrypoint replaying this file on
the next container start — and a migration that dies on "relation already
exists" crash-loops the api with /api/* at 502.

SQLite test note: the suite builds tables with `Base.metadata.create_all` and
never runs migrations, so the contract is declared on the models too
(app/models/calendar_event.py) — that is what the tests exercise. See
tests/test_calendar_schema.py, which reads THIS file's text as well, so the two
declarations cannot drift apart unnoticed.

Revision ID: 025
Revises: 024
Create Date: 2026-08-04
"""

from alembic import op

revision = "025"
down_revision = "024"
branch_labels = None
depends_on = None


CREATE_EVENTS = """
CREATE TABLE IF NOT EXISTS calendar_events (
    id                 UUID         PRIMARY KEY,
    title              VARCHAR(200) NOT NULL,
    starts_at          TIMESTAMPTZ  NOT NULL,
    ends_at            TIMESTAMPTZ  NOT NULL,
    all_day            BOOLEAN      NOT NULL DEFAULT false,
    location           VARCHAR(200),
    meeting_url        TEXT,
    notes              TEXT,
    remind_day_before  BOOLEAN      NOT NULL DEFAULT true,
    remind_hour_before BOOLEAN      NOT NULL DEFAULT true,
    notify_email       BOOLEAN      NOT NULL DEFAULT true,
    notify_sms         BOOLEAN      NOT NULL DEFAULT false,
    created_by_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
)
"""

CREATE_LEDGER = """
CREATE TABLE IF NOT EXISTS calendar_reminder_sends (
    id       UUID        PRIMARY KEY,
    event_id UUID        NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    kind     VARCHAR(16) NOT NULL,
    channel  VARCHAR(8)  NOT NULL,
    sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_calendar_reminder_sends_event_kind_channel
        UNIQUE (event_id, kind, channel)
)
"""

# Every read (the month window) and every reminder pass filters on starts_at.
CREATE_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_calendar_events_starts_at "
    "ON calendar_events (starts_at)",
    "CREATE INDEX IF NOT EXISTS ix_calendar_reminder_sends_event_id "
    "ON calendar_reminder_sends (event_id)",
)


def upgrade() -> None:
    op.execute(CREATE_EVENTS)
    op.execute(CREATE_LEDGER)
    for statement in CREATE_INDEXES:
        op.execute(statement)


def downgrade() -> None:
    # Ledger first: it carries the FK.
    op.execute("DROP TABLE IF EXISTS calendar_reminder_sends")
    op.execute("DROP TABLE IF EXISTS calendar_events")
