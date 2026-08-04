"""The calendar's schema contract — model metadata AND the migration text.

Both, because they are two independent declarations of the same tables and the
suite only ever executes one of them: tests build with
``Base.metadata.create_all`` and never run alembic, so a column added to the
model and forgotten in migration 025 would pass every other test in this
directory and then be missing in production. Reading 025's SQL here is what
makes that drift visible.

Length and CHECK contracts are asserted on METADATA rather than by inserting
oversized data: SQLite ignores ``String(N)`` lengths and CHECK constraints
entirely (CLAUDE.md), so a round-trip assertion would prove nothing.
"""

import re
from pathlib import Path

import pytest
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

from app.models import CalendarEvent, CalendarReminderSend
from app.models.calendar_event import REMINDER_CHANNELS, REMINDER_KINDS

MIGRATION = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "025_add_calendar.py"
).read_text()

EVENT_COLUMNS = {
    "id",
    "title",
    "starts_at",
    "ends_at",
    "all_day",
    "location",
    "meeting_url",
    "notes",
    "remind_day_before",
    "remind_hour_before",
    "notify_email",
    "notify_sms",
    "created_by_id",
    "created_at",
    "updated_at",
}


class TestEventModel:
    def test_the_table_has_exactly_the_designed_columns(self):
        assert set(CalendarEvent.__table__.c.keys()) == EVENT_COLUMNS

    def test_there_is_no_owner_column(self):
        """Shared is the default STATE, not a per-event setting. An owner/
        visibility column appearing here would be a design change, not a
        refactor — five people do not need per-user calendars, and adding one
        later is a migration rather than a rewrite."""
        for forbidden in ("owner_id", "user_id", "visibility", "is_private"):
            assert forbidden not in CalendarEvent.__table__.c

    @pytest.mark.parametrize(
        "column,nullable",
        [
            ("title", False),
            ("starts_at", False),
            ("ends_at", False),
            ("all_day", False),
            ("location", True),
            ("meeting_url", True),
            ("notes", True),
            ("remind_day_before", False),
            ("remind_hour_before", False),
            ("notify_email", False),
            ("notify_sms", False),
            ("created_by_id", True),
        ],
    )
    def test_nullability(self, column, nullable):
        assert CalendarEvent.__table__.c[column].nullable is nullable

    def test_string_lengths(self):
        # SQLite ignores VARCHAR(N), so assert on metadata (CLAUDE.md).
        assert CalendarEvent.__table__.c.title.type.length == 200
        assert CalendarEvent.__table__.c.location.type.length == 200

    def test_meeting_url_and_notes_are_unbounded_text(self):
        """A Teams/Meet link with a passcode is routinely 300+ chars — a
        VARCHAR(255) here would truncate real meetings."""
        assert getattr(CalendarEvent.__table__.c.meeting_url.type, "length", None) is None
        assert getattr(CalendarEvent.__table__.c.notes.type, "length", None) is None

    def test_uuid_columns_use_the_postgresql_type(self):
        """The conftest @compiles shim keys off postgresql.UUID; a plain
        sa.Uuid would bypass it and reintroduce the NUMERIC-affinity flake."""
        assert isinstance(CalendarEvent.__table__.c.id.type, PG_UUID)
        assert isinstance(CalendarEvent.__table__.c.created_by_id.type, PG_UUID)

    def test_created_by_is_set_null_not_cascade(self):
        """Deleting a person must not delete the company's meetings."""
        fk = next(iter(CalendarEvent.__table__.c.created_by_id.foreign_keys))
        assert fk.column.table.name == "users"
        assert fk.ondelete == "SET NULL"

    def test_starts_at_is_indexed(self):
        """Every read (the month window) and every reminder pass filters on it."""
        assert any(
            [c.name for c in idx.columns] == ["starts_at"]
            for idx in CalendarEvent.__table__.indexes
        )

    def test_reminder_defaults_are_on_and_sms_is_off(self):
        cols = CalendarEvent.__table__.c
        assert cols.remind_day_before.default.arg is True
        assert cols.remind_hour_before.default.arg is True
        assert cols.notify_email.default.arg is True
        # OFF by default: setup friction and the risk of a loop spending real
        # money, not the unit price.
        assert cols.notify_sms.default.arg is False
        assert cols.all_day.default.arg is False


class TestLedgerModel:
    def test_columns(self):
        assert set(CalendarReminderSend.__table__.c.keys()) == {
            "id",
            "event_id",
            "kind",
            "channel",
            "sent_at",
        }

    def test_the_unique_constraint_is_exactly_event_kind_channel(self):
        """THE idempotency guarantee. Widening or dropping it turns a late or
        doubled cron tick into duplicate reminders."""
        uniques = [
            c
            for c in CalendarReminderSend.__table__.constraints
            if c.__class__.__name__ == "UniqueConstraint"
        ]
        assert len(uniques) == 1
        assert [c.name for c in uniques[0].columns] == ["event_id", "kind", "channel"]

    def test_event_id_cascades(self):
        fk = next(iter(CalendarReminderSend.__table__.c.event_id.foreign_keys))
        assert fk.column.table.name == "calendar_events"
        assert fk.ondelete == "CASCADE"

    def test_kind_and_channel_lengths_fit_every_declared_value(self):
        kind_len = CalendarReminderSend.__table__.c.kind.type.length
        channel_len = CalendarReminderSend.__table__.c.channel.type.length
        assert kind_len == 16
        assert channel_len == 8
        assert max(len(k) for k in REMINDER_KINDS) <= kind_len
        assert max(len(c) for c in REMINDER_CHANNELS) <= channel_len

    def test_nothing_is_nullable(self):
        for column in ("event_id", "kind", "channel", "sent_at"):
            assert CalendarReminderSend.__table__.c[column].nullable is False


class TestMigration025:
    def test_it_sits_on_the_head_that_is_actually_on_disk(self):
        assert re.search(r'^revision = "025"', MIGRATION, re.M)
        assert re.search(r'^down_revision = "024"', MIGRATION, re.M)

    def test_it_creates_both_tables_idempotently(self):
        """`alembic/env.py` sets no transaction_per_migration, so a partial
        failure replays this file on the next container start — and a migration
        that dies on "relation already exists" crash-loops the api at 502."""
        assert "CREATE TABLE IF NOT EXISTS calendar_events" in MIGRATION
        assert "CREATE TABLE IF NOT EXISTS calendar_reminder_sends" in MIGRATION

    @pytest.mark.parametrize("column", sorted(EVENT_COLUMNS))
    def test_every_model_column_is_in_the_ddl(self, column):
        assert re.search(rf"^\s+{column}\s", MIGRATION, re.M), (
            f"{column} exists on the model but not in migration 025 — the test suite "
            "builds with create_all and would never notice."
        )

    def test_the_ddl_carries_the_unique_constraint(self):
        assert "UNIQUE (event_id, kind, channel)" in MIGRATION
        assert "uq_calendar_reminder_sends_event_kind_channel" in MIGRATION

    def test_the_ddl_carries_both_fk_behaviours(self):
        assert "REFERENCES users(id) ON DELETE SET NULL" in MIGRATION
        assert "REFERENCES calendar_events(id) ON DELETE CASCADE" in MIGRATION

    def test_the_ddl_matches_the_model_on_nullability_of_the_optional_three(self):
        for column in ("location", "meeting_url", "notes"):
            line = re.search(rf"^\s+{column}\s+.*$", MIGRATION, re.M)
            assert line and "NOT NULL" not in line.group(0)

    def test_downgrade_drops_the_ledger_before_the_events(self):
        """The ledger carries the FK; the other order fails on Postgres."""
        ledger = MIGRATION.index("DROP TABLE IF EXISTS calendar_reminder_sends")
        events = MIGRATION.index("DROP TABLE IF EXISTS calendar_events")
        assert ledger < events


class TestTablesActuallyBuild:
    """create_all is what the whole suite runs on — prove these two tables are
    part of it and that the unique constraint is live under SQLite."""

    def test_both_tables_exist_after_create_all(self, db):
        from sqlalchemy import inspect

        names = set(inspect(db.get_bind()).get_table_names())
        assert {"calendar_events", "calendar_reminder_sends"} <= names

    def test_the_unique_constraint_is_enforced_by_sqlite_too(self, db):
        import uuid as uuid_mod
        from datetime import UTC, datetime

        from sqlalchemy.exc import IntegrityError

        event = CalendarEvent(
            id=uuid_mod.uuid4(),
            title="Standup",
            starts_at=datetime(2026, 8, 10, 14, 0, tzinfo=UTC),
            ends_at=datetime(2026, 8, 10, 14, 30, tzinfo=UTC),
        )
        db.add(event)
        db.commit()

        db.add(
            CalendarReminderSend(
                id=uuid_mod.uuid4(), event_id=event.id, kind="day_before", channel="email"
            )
        )
        db.commit()
        db.add(
            CalendarReminderSend(
                id=uuid_mod.uuid4(), event_id=event.id, kind="day_before", channel="email"
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()

        # A different channel for the same kind is a DIFFERENT slot.
        db.add(
            CalendarReminderSend(
                id=uuid_mod.uuid4(), event_id=event.id, kind="day_before", channel="sms"
            )
        )
        db.commit()
        assert db.query(CalendarReminderSend).count() == 2
