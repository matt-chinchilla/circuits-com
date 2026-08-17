"""The supplier-sync activity stream: activity_events

One append-only row per thing the sync did (a part imported, a listing
refreshed), read back newest-first by the dashboard's Recent Activity panel.

`supplier_id` REFERENCES suppliers(id) with NO cascade, deliberately: the
supplier delete route NULLs the column instead (mirroring what it already does
for `users.supplier_id`), because an event records something that actually
happened and stays true after the company row is gone.

`created_at` defaults to now() in the DATABASE rather than in the writer — it is
the feed's only ordering, and the index on it is the only one the read path
needs. The second index (supplier_id) serves the delete-time NULL-out and
per-supplier reads.

Raw SQL with IF NOT EXISTS rather than op.create_table, for the same reason as
022/023/024/025: alembic/env.py sets no `transaction_per_migration`, so a
failure partway through `upgrade head` leaves the api entrypoint replaying this
file on the next container start — and a migration that dies on "relation
already exists" crash-loops the api with /api/* at 502.

SQLite test note: the suite builds tables with `Base.metadata.create_all` and
never runs migrations, so the contract is declared on the model too
(app/models/activity_event.py). tests/test_activity_events.py reads THIS file's
text as well, so the two declarations cannot drift apart unnoticed.

Revision ID: 030
Revises: 029
Create Date: 2026-08-17
"""

from alembic import op

revision = "030"
down_revision = "029"
branch_labels = None
depends_on = None


CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS activity_events (
    id          UUID         PRIMARY KEY,
    kind        VARCHAR(40)  NOT NULL,
    supplier_id UUID         REFERENCES suppliers(id),
    title       VARCHAR(255) NOT NULL,
    detail      VARCHAR(500),
    image_url   VARCHAR(500),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
)
"""

CREATE_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_activity_events_created_at ON activity_events (created_at)",
    "CREATE INDEX IF NOT EXISTS ix_activity_events_supplier_id ON activity_events (supplier_id)",
)


def upgrade() -> None:
    op.execute(CREATE_TABLE)
    for statement in CREATE_INDEXES:
        op.execute(statement)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS activity_events")
