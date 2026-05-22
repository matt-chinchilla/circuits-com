"""Widen categories.icon to String(40) for Phosphor Light icon names

Revision ID: 005
Revises: 004
Create Date: 2026-05-22

Phosphor Light icon names (e.g. `arrows-counter-clockwise`, 24 chars) exceed
the original `String(10)` budget designed for single Unicode emoji glyphs.
This migration widens the column so seed.py can write the new names without
PG silently truncating to 10 chars. The seed itself is idempotent — running
./deploy.sh --reseed against prod after this migration flushes the old emoji
values and replaces them with Phosphor names from api/app/db/seed.py.

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "categories",
        "icon",
        existing_type=sa.String(length=10),
        type_=sa.String(length=40),
        existing_nullable=True,
    )


def downgrade() -> None:
    # Narrowing the column from String(40) → String(10) would silently
    # truncate any row whose icon name is >10 chars (true for ~60 of 90
    # seeded categories, e.g. "battery-charging-vertical" → "battery-ch").
    # Pre-truncate by remapping over-long Phosphor names back to the
    # original emoji default ("⚡") so downgrade is data-safe.
    op.execute("UPDATE categories SET icon = '⚡' WHERE LENGTH(icon) > 10")
    op.alter_column(
        "categories",
        "icon",
        existing_type=sa.String(length=40),
        type_=sa.String(length=10),
        existing_nullable=True,
    )
