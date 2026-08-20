"""presence_fakes singleton — the circuits --fakeuser demo lever.

One row (id=1) whose `count` is how many synthetic users the admin presence
pill shows. Written only by scripts/fakeuser.sh (psql), read by
routes/admin_presence.py. Seeded here at count=0 so the lever exists but does
nothing until raised.
"""

import sqlalchemy as sa
from alembic import op

revision = "034"
down_revision = "033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "presence_fakes",
        sa.Column("id", sa.SmallInteger(), primary_key=True),
        sa.Column("count", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("id = 1", name="ck_presence_fakes_singleton"),
        sa.CheckConstraint("count >= 0 AND count <= 10", name="ck_presence_fakes_range"),
    )
    op.execute("INSERT INTO presence_fakes (id, count) VALUES (1, 0)")


def downgrade() -> None:
    op.drop_table("presence_fakes")
