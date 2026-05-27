"""Add description column to categories table for SEO content

Revision ID: 009
Revises: 007
Create Date: 2026-05-27
"""

from alembic import op
import sqlalchemy as sa

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("categories", sa.Column("description", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("categories", "description")
