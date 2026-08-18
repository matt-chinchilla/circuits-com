"""Per-supplier feed configuration: supplier_feeds

One row per supplier that has a feed. `auto_import_enabled` is the only column
anything reads today — the admin's "Nightly auto-import" switch writes it and
the nightly job's selection query reads it.

`feed_url` and `api_key` are created here but written by nothing yet: the
partner-feed phase gives a distributor its own inventory URL and its own
credential, and adding them now — while the table is empty — is cheaper than a
second migration against a table that will by then carry production rows.
(`last_synced_at` went live with the nightly job: stamped after each
supplier's run.) `api_key` is TEXT with no length cap for the same reason as
`provider_credentials.api_key`: the format belongs to another company. Nothing
returns it to a client.

`supplier_id` IS the primary key: a supplier has exactly one feed
configuration, and a surrogate id would only create room for two rows to
disagree about whether the nightly job runs. The FK carries NO ON DELETE
CASCADE — `routes/suppliers.delete_supplier` removes this row explicitly, as it
does for every other dependent it owns, and a database cascade would hide a
forgotten step there instead of failing on it.

Raw SQL with IF NOT EXISTS rather than op.create_table, for the same reason as
022/023/024/025/030/031: alembic/env.py sets no `transaction_per_migration`, so
a failure partway through `upgrade head` leaves the api entrypoint replaying
this file on the next container start — and a migration that dies on "relation
already exists" crash-loops the api with /api/* at 502.

SQLite test note: the suite builds tables with `Base.metadata.create_all` and
never runs migrations, so the contract is declared on the model too
(app/models/supplier_feed.py). tests/test_supplier_feed_settings.py reads THIS
file's text as well, so the two declarations cannot drift apart unnoticed.

Revision ID: 032
Revises: 031
Create Date: 2026-08-18
"""

from alembic import op

revision = "032"
down_revision = "031"
branch_labels = None
depends_on = None


CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS supplier_feeds (
    supplier_id         UUID         PRIMARY KEY REFERENCES suppliers(id),
    feed_url            VARCHAR(500),
    api_key             TEXT,
    auto_import_enabled BOOLEAN      NOT NULL DEFAULT false,
    last_synced_at      TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
)
"""


def upgrade() -> None:
    op.execute(CREATE_TABLE)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS supplier_feeds")
