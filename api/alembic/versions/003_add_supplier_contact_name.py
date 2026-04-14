"""Add contact_name column to suppliers (sales rep tracking, admin-only)

Revision ID: 003
Revises: 002
Create Date: 2026-04-14

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "suppliers",
        sa.Column("contact_name", sa.String(120), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("suppliers", "contact_name")
