"""page_views.ip — the literal client address, beside the one-way hash.

Revision ID: 050
Revises: 049

Owner decision 2026-09-01: the map's town intel card should show which
addresses a dot's views came from, and `ip_hash` was designed one-way, so
the only path is to START keeping the literal address. Forward-only like
040/048/049 and for the same reason — no row written before this migration
can ever learn its address.

Every reader of this column sits behind `require_staff` (the same gate that
keeps the demo account out of leads); nothing public ever serializes it.

String(45) fits the longest IPv6 textual form. NULLABLE AND UNINDEXED,
matching the other forward-only geo columns: NULL means "before capture",
and the per-city breakdown that reads it filters on city keys first.
"""

import sqlalchemy as sa
from alembic import op

revision = "050"
down_revision = "049"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("page_views", sa.Column("ip", sa.String(length=45), nullable=True))


def downgrade() -> None:
    op.drop_column("page_views", "ip")
