"""Add sold_by (sales rep) column to sponsors table

Admin-only attribution field: which rep closed the sponsorship. Feeds the
dashboard's /api/dashboard/sales-reps rollup. Stored as a free string
(an admin User.username), NOT an FK, so removing/renaming a rep can never
orphan a sponsorship row.

Revision ID: 019
Revises: 018
Create Date: 2026-07-30
"""

from alembic import op
import sqlalchemy as sa

revision = "019"
down_revision = "018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sponsors", sa.Column("sold_by", sa.String(120), nullable=True))


def downgrade() -> None:
    op.drop_column("sponsors", "sold_by")
