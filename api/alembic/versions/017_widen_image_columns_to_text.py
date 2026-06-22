"""widen image columns to text

Revision ID: 017
Revises: 016
Create Date: 2026-06-22

Base64 data-URLs (uploaded logos/icons) exceed the old String(500) cap.
varchar(500)->text is a metadata-only, non-destructive widening on Postgres.
"""

from alembic import op
import sqlalchemy as sa

revision = "017"
down_revision = "016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "sponsors", "image_url",
        existing_type=sa.String(length=500), type_=sa.Text(), existing_nullable=True,
    )
    op.alter_column(
        "suppliers", "logo_url",
        existing_type=sa.String(length=500), type_=sa.Text(), existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "suppliers", "logo_url",
        existing_type=sa.Text(), type_=sa.String(length=500), existing_nullable=True,
    )
    op.alter_column(
        "sponsors", "image_url",
        existing_type=sa.Text(), type_=sa.String(length=500), existing_nullable=True,
    )
