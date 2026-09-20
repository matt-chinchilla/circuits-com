"""supplier_badges.speed — the pulsing founder badge's cycle length (owner, 2026-09-20).

Revision ID: 056
Revises: 055

`founder_badge_2` is the owner's "Pulsing Badge" design (`<glow-badge>`): scheme, glow and
a `speed` in seconds per cycle (1–6, default 2.6). Glow rides the existing `intensity`
column; speed gets its own so a holding can switch artwork and back without losing
either look. Constant server_default = no table rewrite.
"""

import sqlalchemy as sa
from alembic import op

revision = "056"
down_revision = "055"
branch_labels = None
depends_on = None

# Literal on purpose (a migration never imports app code); `app.models.badge`
# builds the same string from SPEED_RANGE and test_supplier_badges_model.py
# pins the two together on this file's source text.
SPEED_CHECK = "speed >= 1.0 AND speed <= 6.0"


def upgrade() -> None:
    op.add_column(
        "supplier_badges",
        sa.Column("speed", sa.Numeric(3, 1), nullable=False, server_default="2.6"),
    )
    op.create_check_constraint("ck_supplier_badges_speed", "supplier_badges", SPEED_CHECK)


def downgrade() -> None:
    op.drop_constraint("ck_supplier_badges_speed", "supplier_badges", type_="check")
    op.drop_column("supplier_badges", "speed")
