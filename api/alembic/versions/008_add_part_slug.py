"""Add slug column to parts for SEO-friendly URLs

Revision ID: 008
Revises: 007
Create Date: 2026-05-27
"""

from alembic import op
import sqlalchemy as sa

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("parts", sa.Column("slug", sa.String(200), nullable=True))
    op.create_index("ix_parts_slug", "parts", ["slug"], unique=False)

    op.execute(
        """
        UPDATE parts
        SET slug = TRIM(BOTH '-' FROM
            REGEXP_REPLACE(
                REGEXP_REPLACE(LOWER(sku), '[^a-z0-9]+', '-', 'g'),
                '-+', '-', 'g'
            )
        )
        """
    )


def downgrade() -> None:
    op.drop_index("ix_parts_slug", table_name="parts")
    op.drop_column("parts", "slug")
