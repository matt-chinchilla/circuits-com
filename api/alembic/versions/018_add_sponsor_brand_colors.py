"""add sponsor brand color columns

Revision ID: 018
Revises: 017
Create Date: 2026-07-10
"""

from alembic import op
import sqlalchemy as sa

revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sponsors", sa.Column("brand_primary", sa.String(9), nullable=True))
    op.add_column("sponsors", sa.Column("brand_secondary", sa.String(9), nullable=True))


def downgrade() -> None:
    op.drop_column("sponsors", "brand_secondary")
    op.drop_column("sponsors", "brand_primary")
