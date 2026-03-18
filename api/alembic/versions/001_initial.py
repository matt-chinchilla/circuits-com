"""Initial schema — create all tables

Revision ID: 001
Revises:
Create Date: 2026-03-18

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- categories ---
    op.create_table(
        "categories",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("slug", sa.String(100), nullable=False),
        sa.Column("icon", sa.String(10), nullable=True, server_default="⚡"),
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("categories.id"),
            nullable=True,
        ),
        sa.Column("sort_order", sa.Integer(), nullable=True, server_default="0"),
        sa.UniqueConstraint("slug", name="uq_categories_slug"),
    )

    # --- suppliers ---
    op.create_table(
        "suppliers",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("phone", sa.String(20), nullable=True),
        sa.Column("website", sa.String(200), nullable=True),
        sa.Column("email", sa.String(200), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("logo_url", sa.String(500), nullable=True),
    )

    # --- category_suppliers ---
    op.create_table(
        "category_suppliers",
        sa.Column(
            "category_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("categories.id"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "supplier_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("suppliers.id"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("is_featured", sa.Boolean(), nullable=True, server_default="false"),
        sa.Column("rank", sa.Integer(), nullable=True, server_default="0"),
    )

    # --- sponsors ---
    op.create_table(
        "sponsors",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "supplier_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("suppliers.id"),
            nullable=False,
        ),
        sa.Column(
            "category_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("categories.id"),
            nullable=True,
        ),
        sa.Column("keyword", sa.String(100), nullable=True),
        sa.Column("image_url", sa.String(500), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("tier", sa.String(10), nullable=True, server_default="gold"),
        sa.CheckConstraint(
            "(category_id IS NOT NULL AND keyword IS NULL) OR (category_id IS NULL AND keyword IS NOT NULL)",
            name="sponsor_category_or_keyword",
        ),
    )


def downgrade() -> None:
    op.drop_table("sponsors")
    op.drop_table("category_suppliers")
    op.drop_table("suppliers")
    op.drop_table("categories")
