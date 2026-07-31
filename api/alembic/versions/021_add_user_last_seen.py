"""Add users.last_seen_at for admin presence

The topbar presence bubbles need a store that is correct under prod's
`uvicorn --workers 4`: the original module-level dict was per-worker, so the
roster flickered depending on which worker answered a poll (2026-07-31 review
finding). One nullable timestamp on the existing users row is the smallest
multi-worker-correct store — one UPDATE per 30s heartbeat per open admin tab,
no new table, survives restarts.

Revision ID: 021
Revises: 020
Create Date: 2026-07-31
"""

from alembic import op
import sqlalchemy as sa

revision = "021"
down_revision = "020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "last_seen_at")
