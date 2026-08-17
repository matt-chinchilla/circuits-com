"""The activity-event stream's schema contract, round-trip, and delete safety.

``activity_events`` is the persistence layer for the live supplier-sync feed:
the sync route appends one row per event and the dashboard's Recent Activity
reads the newest N back. Three things are worth a test here.

1. **The schema contract, on BOTH declarations.** The suite builds tables with
   ``Base.metadata.create_all`` and never runs alembic, so a column added to the
   model and forgotten in migration 030 passes every other test in this
   directory and is then missing in production. Reading 030's SQL here is what
   makes that drift visible — same reason ``test_calendar_schema.py`` reads 025.

2. **Ordering by ``created_at`` descending**, because that is the only query the
   read side ever runs, and it is what the index exists for.

3. **Deleting a supplier must not delete its history, or fail.** ``supplier_id``
   is a nullable FK, and the supplier cascade NULLs it exactly as it NULLs
   ``User.supplier_id`` — an event is a record of something that happened, and
   it stays true after the company row is gone. Without that step the DELETE
   dies on a foreign-key violation (the test suite runs SQLite with
   ``PRAGMA foreign_keys=ON``), which is a 500 on a route that used to work.

Length contracts are asserted on METADATA rather than by inserting oversized
data: SQLite ignores ``String(N)`` entirely (CLAUDE.md).
"""

import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

from app.models import ActivityEvent, Supplier

MIGRATION = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "030_activity_events.py"
).read_text()

COLUMNS = {
    "id",
    "kind",
    "supplier_id",
    "title",
    "detail",
    "image_url",
    "created_at",
}


class TestModelShape:
    def test_the_table_has_exactly_the_designed_columns(self):
        assert set(ActivityEvent.__table__.c.keys()) == COLUMNS

    def test_table_name(self):
        assert ActivityEvent.__tablename__ == "activity_events"

    @pytest.mark.parametrize(
        "column,nullable",
        [
            ("kind", False),
            ("supplier_id", True),
            ("title", False),
            ("detail", True),
            ("image_url", True),
            ("created_at", False),
        ],
    )
    def test_nullability(self, column, nullable):
        assert ActivityEvent.__table__.c[column].nullable is nullable

    def test_string_lengths(self):
        # SQLite ignores VARCHAR(N), so assert on metadata (CLAUDE.md).
        cols = ActivityEvent.__table__.c
        assert cols.kind.type.length == 40
        assert cols.title.type.length == 255
        assert cols.detail.type.length == 500
        assert cols.image_url.type.length == 500

    def test_uuid_columns_use_the_postgresql_type(self):
        """The conftest @compiles shim keys off postgresql.UUID; a plain
        sa.Uuid would bypass it and reintroduce the NUMERIC-affinity flake."""
        assert isinstance(ActivityEvent.__table__.c.id.type, PG_UUID)
        assert isinstance(ActivityEvent.__table__.c.supplier_id.type, PG_UUID)

    def test_supplier_id_is_a_nullable_fk_to_suppliers(self):
        """Nullable is the point: the row outlives the supplier."""
        fk = next(iter(ActivityEvent.__table__.c.supplier_id.foreign_keys))
        assert fk.column.table.name == "suppliers"
        assert ActivityEvent.__table__.c.supplier_id.nullable is True

    def test_created_at_is_indexed_under_the_designed_name(self):
        """The feed reads newest-first and nothing else."""
        assert "ix_activity_events_created_at" in {
            idx.name for idx in ActivityEvent.__table__.indexes
        }

    def test_supplier_id_is_indexed(self):
        """The supplier-delete NULL-out and per-supplier reads both filter on it."""
        assert any(
            [c.name for c in idx.columns] == ["supplier_id"]
            for idx in ActivityEvent.__table__.indexes
        )

    def test_created_at_has_a_server_default(self):
        """The database stamps the row — a writer that forgets is still ordered
        correctly, and Postgres and SQLite agree on the clock."""
        assert ActivityEvent.__table__.c.created_at.server_default is not None


class TestRoundTrip:
    def test_the_table_exists_after_create_all(self, db):
        assert "activity_events" in set(inspect(db.get_bind()).get_table_names())

    def test_a_row_round_trips_with_every_field(self, db, seeded_db):
        event = ActivityEvent(
            id=uuid.uuid4(),
            kind="part_imported",
            supplier_id=seeded_db["supplier1"].id,
            title="LM7805CT imported",
            detail="1 listing, 3 price breaks",
            image_url="https://example.test/part.png",
        )
        db.add(event)
        db.commit()

        stored = db.query(ActivityEvent).filter_by(id=event.id).one()
        assert stored.kind == "part_imported"
        assert stored.supplier_id == seeded_db["supplier1"].id
        assert stored.title == "LM7805CT imported"
        assert stored.detail == "1 listing, 3 price breaks"
        assert stored.image_url == "https://example.test/part.png"
        # Stamped by the database, not the caller.
        assert stored.created_at is not None

    def test_the_optional_fields_are_optional(self, db):
        """A sync event with no supplier, no detail and no image is a normal
        row — the feed carries system events too."""
        event = ActivityEvent(id=uuid.uuid4(), kind="sync_started", title="Sync started")
        db.add(event)
        db.commit()

        stored = db.query(ActivityEvent).one()
        assert stored.supplier_id is None
        assert stored.detail is None
        assert stored.image_url is None

    def test_rows_come_back_newest_first(self, db):
        """The one query the read side runs. created_at is set explicitly here
        because SQLite's CURRENT_TIMESTAMP has one-second resolution — three
        rows inserted in the same second would tie and prove nothing."""
        base = datetime(2026, 8, 17, 12, 0, tzinfo=UTC)
        for offset, title in ((0, "oldest"), (60, "middle"), (120, "newest")):
            db.add(
                ActivityEvent(
                    id=uuid.uuid4(),
                    kind="part_imported",
                    title=title,
                    created_at=base + timedelta(seconds=offset),
                )
            )
        db.commit()

        titles = [
            row.title
            for row in db.query(ActivityEvent).order_by(ActivityEvent.created_at.desc()).all()
        ]
        assert titles == ["newest", "middle", "oldest"]


class TestSupplierDeleteKeepsTheHistory:
    """DELETE /api/suppliers/{id} NULLs ActivityEvent.supplier_id, exactly as it
    NULLs User.supplier_id. Two failures are being prevented: a foreign-key
    violation turning a working route into a 500, and the silent loss of the
    feed's history for that company."""

    def test_delete_nulls_the_link_and_keeps_the_event(self, client, db, seeded_db, auth_header):
        supplier_id = seeded_db["supplier2"].id
        event = ActivityEvent(
            id=uuid.uuid4(),
            kind="listing_updated",
            supplier_id=supplier_id,
            title="Kennedy Electronics refreshed 8,000 units",
        )
        db.add(event)
        db.commit()

        resp = client.delete(f"/api/suppliers/{supplier_id}", headers=auth_header())
        assert resp.status_code == 200

        assert db.query(Supplier).filter_by(id=supplier_id).first() is None
        stored = db.query(ActivityEvent).filter_by(id=event.id).first()
        assert stored is not None, "the event was deleted with the supplier"
        assert stored.supplier_id is None
        assert stored.title == "Kennedy Electronics refreshed 8,000 units"

    def test_events_for_other_suppliers_are_untouched(self, client, db, seeded_db, auth_header):
        keeper = ActivityEvent(
            id=uuid.uuid4(),
            kind="listing_updated",
            supplier_id=seeded_db["supplier1"].id,
            title="Avnet refreshed 15,000 units",
        )
        db.add(keeper)
        db.commit()

        resp = client.delete(f"/api/suppliers/{seeded_db['supplier2'].id}", headers=auth_header())
        assert resp.status_code == 200

        stored = db.query(ActivityEvent).filter_by(id=keeper.id).one()
        assert stored.supplier_id == seeded_db["supplier1"].id


class TestMigration030:
    def test_it_sits_on_the_head_that_is_actually_on_disk(self):
        assert re.search(r'^revision = "030"', MIGRATION, re.M)
        assert re.search(r'^down_revision = "029"', MIGRATION, re.M)

    def test_it_creates_the_table_idempotently(self):
        """`alembic/env.py` sets no transaction_per_migration, so a partial
        failure replays this file on the next container start — and a migration
        that dies on "relation already exists" crash-loops the api at 502."""
        assert "CREATE TABLE IF NOT EXISTS activity_events" in MIGRATION

    @pytest.mark.parametrize("column", sorted(COLUMNS))
    def test_every_model_column_is_in_the_ddl(self, column):
        assert re.search(rf"^\s+{column}\s", MIGRATION, re.M), (
            f"{column} exists on the model but not in migration 030 — the test suite "
            "builds with create_all and would never notice."
        )

    def test_the_ddl_carries_both_indexes_idempotently(self):
        assert "CREATE INDEX IF NOT EXISTS ix_activity_events_created_at" in MIGRATION
        assert "CREATE INDEX IF NOT EXISTS ix_activity_events_supplier_id" in MIGRATION

    def test_the_supplier_fk_does_not_cascade(self):
        """Deleting a company must not erase what it did; the route NULLs the
        column instead."""
        line = re.search(r"^\s+supplier_id\s+.*$", MIGRATION, re.M)
        assert line and "ON DELETE CASCADE" not in line.group(0)

    def test_the_ddl_matches_the_model_on_the_not_null_columns(self):
        for column in ("kind", "title", "created_at"):
            line = re.search(rf"^\s+{column}\s+.*$", MIGRATION, re.M)
            assert line and "NOT NULL" in line.group(0)

    def test_downgrade_drops_the_table_if_it_exists(self):
        assert "DROP TABLE IF EXISTS activity_events" in MIGRATION
