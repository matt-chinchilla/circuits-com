"""Part spec fields — mount / rohs / lead_time_days (search v2 spec sheet).

All three nullable, no backfill, no CHECK constraints (SQLite parity): values
are normalized at the single write boundary, the feed mapper. Columns fill
organically via future syncs/imports; NULL renders as an em-dash.
"""

import sqlalchemy as sa
from alembic import op

revision = "039"
down_revision = "038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("parts", sa.Column("mount", sa.String(8), nullable=True))
    op.add_column("parts", sa.Column("rohs", sa.Boolean(), nullable=True))
    op.add_column("parts", sa.Column("lead_time_days", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("parts", "lead_time_days")
    op.drop_column("parts", "rohs")
    op.drop_column("parts", "mount")
