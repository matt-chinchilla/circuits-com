"""Admin-managed distributor feed keys: provider_credentials

One row per feed provider slug, holding the API key the sync route presents to
that distributor. The DB row wins over the environment variable
(`registry.get_feed_key`), so a key can be pasted into Admin → Settings instead
of edited into the host `.env` and recreated into the container — while an
environment that already carries one keeps working with no row at all.

`provider` IS the primary key: a provider has exactly one key, and a surrogate
id would only create room for two rows to disagree about which.

`api_key` is TEXT with no length cap — the format belongs to another company —
and is stored verbatim because the server must present it verbatim; there is
nothing a hash could be checked against. Nothing reads it back to a client.

`updated_at` defaults to now() in the DATABASE (and the model adds onupdate) —
"when was this key last changed" is the only thing the admin card can say about
a value it will not show.

Raw SQL with IF NOT EXISTS rather than op.create_table, for the same reason as
022/023/024/025/030: alembic/env.py sets no `transaction_per_migration`, so a
failure partway through `upgrade head` leaves the api entrypoint replaying this
file on the next container start — and a migration that dies on "relation
already exists" crash-loops the api with /api/* at 502.

SQLite test note: the suite builds tables with `Base.metadata.create_all` and
never runs migrations, so the contract is declared on the model too
(app/models/provider_credential.py).

Revision ID: 031
Revises: 030
Create Date: 2026-08-17
"""

from alembic import op

revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None


CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS provider_credentials (
    provider   VARCHAR(40) PRIMARY KEY,
    api_key    TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""


def upgrade() -> None:
    op.execute(CREATE_TABLE)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS provider_credentials")
