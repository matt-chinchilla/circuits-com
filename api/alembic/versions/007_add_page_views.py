"""Add page_views table for site analytics

Revision ID: 007
Revises: 006
Create Date: 2026-05-26
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "page_views",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("path", sa.String(500), nullable=False, index=True),
        sa.Column("referrer", sa.String(1000), nullable=True),
        sa.Column("user_agent", sa.String(500), nullable=True),
        sa.Column("session_id", sa.String(64), nullable=False, index=True),
        sa.Column("ip_hash", sa.String(64), nullable=True),
        sa.Column("device_type", sa.String(20), nullable=True),
        sa.Column("browser", sa.String(50), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_page_views_created_at", "page_views", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_page_views_created_at", table_name="page_views")
    op.drop_table("page_views")
