"""Add amount and status columns to sponsors table for admin CRUD

Revision ID: 010
Revises: 009
Create Date: 2026-05-28
"""

from alembic import op
import sqlalchemy as sa

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sponsors", sa.Column("amount", sa.Numeric(10, 2), nullable=True))
    op.add_column("sponsors", sa.Column("status", sa.String(20), nullable=True))


def downgrade() -> None:
    op.drop_column("sponsors", "status")
    op.drop_column("sponsors", "amount")
