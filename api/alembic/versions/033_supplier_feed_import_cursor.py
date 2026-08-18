"""Per-category import sweep depth: supplier_feeds.import_cursor

Without it every Import run re-read the distributor's FIRST page for every
category, so once each category's first page had been absorbed the run found
nothing new — the owner-reported discovery plateau.

Shape: ``{category_slug: next_start_at}``, where the int is the offset the
NEXT sweep of that category asks the provider for, and ``-1`` means EXHAUSTED
(a sweep came back with fewer raw rows than it asked for). When every category
is exhausted the importer clears the whole dict and starts over — a fully
swept catalog keeps re-verifying itself and picks up what the distributor
listed since.

``sa.JSON`` (not JSONB): the suite builds its tables with
``Base.metadata.create_all`` on SQLite and never runs migrations, so a
Postgres-only type here would leave every test blind to the column. Nothing
queries INTO this value — it is read whole, per supplier — so JSONB's indexing
would buy nothing.

Raw SQL with IF NOT EXISTS rather than op.add_column, for the same reason as
032: alembic/env.py sets no `transaction_per_migration`, so a failure partway
through `upgrade head` replays this file on the next container start, and a
migration that dies on "column already exists" crash-loops the api at 502.

The model declares the same column (app/models/supplier_feed.py);
tests/test_supplier_feed_settings.py reads THIS file's text so the two cannot
drift apart unnoticed.

Revision ID: 033
Revises: 032
Create Date: 2026-08-18
"""

from alembic import op

revision = "033"
down_revision = "032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE supplier_feeds ADD COLUMN IF NOT EXISTS import_cursor JSON")


def downgrade() -> None:
    op.execute("ALTER TABLE supplier_feeds DROP COLUMN IF EXISTS import_cursor")
