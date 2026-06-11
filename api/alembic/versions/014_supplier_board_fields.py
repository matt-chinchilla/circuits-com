"""Supplier board fields — contact_role / coverage_hours / brand colors

The 2026-06-11 sponsor tier boards (Platinum/Gold/Silver) render four supplier
attributes the model lacked:

  - ``contact_role`` ``String(120)`` — job title under the contact name
    (Silver chips + Gold card + Platinum board).
  - ``coverage_hours`` ``String(60)`` — sales hours under the phone (Platinum).
  - ``brand_primary`` / ``brand_secondary`` ``String(9)`` — hex brand-takeover
    colors for the Platinum energize-wave (nullable → CsFx falls back to the
    locked platinum palette).

All nullable ``ADD COLUMN`` (PG-only; SQLite tests build from the models via
``create_all``).

Revision ID: 014
Revises: 013
Create Date: 2026-06-11
"""

import sqlalchemy as sa
from alembic import op

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("suppliers", sa.Column("contact_role", sa.String(120), nullable=True))
    op.add_column("suppliers", sa.Column("coverage_hours", sa.String(60), nullable=True))
    op.add_column("suppliers", sa.Column("brand_primary", sa.String(9), nullable=True))
    op.add_column("suppliers", sa.Column("brand_secondary", sa.String(9), nullable=True))


def downgrade() -> None:
    op.drop_column("suppliers", "brand_secondary")
    op.drop_column("suppliers", "brand_primary")
    op.drop_column("suppliers", "coverage_hours")
    op.drop_column("suppliers", "contact_role")
