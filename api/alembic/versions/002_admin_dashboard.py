"""Admin dashboard — new tables and timestamp columns

Revision ID: 002
Revises: 001
Create Date: 2026-04-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- users ---
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("username", sa.String(100), unique=True, nullable=False),
        sa.Column("password_hash", sa.String(200), nullable=False),
        sa.Column(
            "role",
            sa.Enum("admin", "company", name="user_role"),
            nullable=False,
            server_default="company",
        ),
        sa.Column(
            "supplier_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("suppliers.id"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # --- parts ---
    op.create_table(
        "parts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("mpn", sa.String(100), nullable=False, index=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("manufacturer_name", sa.String(200), nullable=False),
        sa.Column(
            "category_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("categories.id"),
            nullable=True,
        ),
        sa.Column("datasheet_url", sa.String(500), nullable=True),
        sa.Column(
            "lifecycle_status",
            sa.Enum("active", "nrnd", "obsolete", "unknown", name="lifecycle_status"),
            nullable=False,
            server_default="active",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # --- part_listings ---
    op.create_table(
        "part_listings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "part_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("parts.id"),
            nullable=False,
        ),
        sa.Column(
            "supplier_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("suppliers.id"),
            nullable=False,
        ),
        sa.Column("sku", sa.String(100), nullable=True),
        sa.Column("stock_quantity", sa.Integer(), server_default="0"),
        sa.Column("lead_time_days", sa.Integer(), nullable=True),
        sa.Column("unit_price", sa.Numeric(10, 4), nullable=False),
        sa.Column("currency", sa.String(3), server_default="'USD'"),
        sa.Column(
            "last_updated",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # --- price_breaks ---
    op.create_table(
        "price_breaks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "listing_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("part_listings.id"),
            nullable=False,
        ),
        sa.Column("min_quantity", sa.Integer(), nullable=False),
        sa.Column("unit_price", sa.Numeric(10, 4), nullable=False),
    )

    # --- revenue ---
    op.create_table(
        "revenue",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "supplier_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("suppliers.id"),
            nullable=False,
        ),
        sa.Column(
            "type",
            sa.Enum("sponsorship", "listing_fee", "featured", name="revenue_type"),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # --- Add timestamp columns to existing tables ---
    for table in ("suppliers", "categories"):
        op.add_column(
            table,
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.add_column(
            table,
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        )

    # Sponsors get timestamps + date range
    op.add_column(
        "sponsors",
        sa.Column("start_date", sa.Date(), nullable=True),
    )
    op.add_column(
        "sponsors",
        sa.Column("end_date", sa.Date(), nullable=True),
    )
    op.add_column(
        "sponsors",
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "sponsors",
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    # Drop timestamp columns from existing tables
    for table in ("sponsors", "categories", "suppliers"):
        op.drop_column(table, "updated_at")
        op.drop_column(table, "created_at")
    op.drop_column("sponsors", "end_date")
    op.drop_column("sponsors", "start_date")

    # Drop new tables
    op.drop_table("revenue")
    op.drop_table("price_breaks")
    op.drop_table("part_listings")
    op.drop_table("parts")
    op.drop_table("users")

    # Drop enums
    sa.Enum(name="revenue_type").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="lifecycle_status").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="user_role").drop(op.get_bind(), checkfirst=True)
