"""suppliers.founder → badges catalogue + supplier_badges holdings (owner, 2026-09-18).

Revision ID: 055
Revises: 054

Creates the catalogue with the two founder keys (fixed here so the backfill can join on
them), moves every founder=true supplier onto a founder_badge_1 holding with the design's
default look, then drops the flag. Downgrade re-adds the column from the enabled
founder-family holdings and drops both tables.

`gen_random_uuid()` is built into Postgres 13+ (the prod image is newer), so the catalogue
rows and the backfill need no pgcrypto extension.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "055"
down_revision = "054"
branch_labels = None
depends_on = None

SCHEMES = "'red','orange','yellow','green','blue','indigo','violet','white','black'"


def postgresql_uuid():
    return postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "badges",
        sa.Column("id", postgresql_uuid(), primary_key=True),
        sa.Column("key", sa.String(40), nullable=False, unique=True),
        sa.Column("family", sa.String(40), nullable=False),
        sa.Column("label", sa.String(80), nullable=False),
        sa.Column("available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_table(
        "supplier_badges",
        sa.Column("id", postgresql_uuid(), primary_key=True),
        sa.Column(
            "supplier_id",
            postgresql_uuid(),
            sa.ForeignKey("suppliers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "badge_id",
            postgresql_uuid(),
            sa.ForeignKey("badges.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("family", sa.String(40), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("scheme", sa.String(12), nullable=False, server_default="orange"),
        sa.Column("intensity", sa.Numeric(3, 2), nullable=False, server_default="1.00"),
        sa.Column("opacity", sa.Numeric(3, 2), nullable=False, server_default="0.75"),
        sa.Column("sparks", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "granted_by",
            postgresql_uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "granted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("supplier_id", "family", name="uq_supplier_badges_family"),
        sa.CheckConstraint(f"scheme IN ({SCHEMES})", name="ck_supplier_badges_scheme"),
        sa.CheckConstraint(
            "intensity >= 0.3 AND intensity <= 2", name="ck_supplier_badges_intensity"
        ),
        sa.CheckConstraint("opacity >= 0.2 AND opacity <= 1", name="ck_supplier_badges_opacity"),
    )
    op.create_index("ix_supplier_badges_supplier_id", "supplier_badges", ["supplier_id"])
    op.execute(
        """
        INSERT INTO badges (id, key, family, label, available, sort_order) VALUES
          (gen_random_uuid(), 'founder_badge_1', 'founder', 'Founding distributor', true, 0),
          (gen_random_uuid(), 'founder_badge_2', 'founder', 'Founding distributor (alternate)', false, 1)
        ON CONFLICT (key) DO NOTHING"""
    )
    op.execute(
        """
        INSERT INTO supplier_badges (id, supplier_id, badge_id, family)
        SELECT gen_random_uuid(), s.id, b.id, 'founder'
        FROM suppliers s JOIN badges b ON b.key = 'founder_badge_1'
        WHERE s.founder"""
    )
    op.drop_column("suppliers", "founder")


def downgrade() -> None:
    op.add_column(
        "suppliers",
        sa.Column("founder", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        """UPDATE suppliers s SET founder = true
           FROM supplier_badges sb
           WHERE sb.supplier_id = s.id AND sb.family = 'founder' AND sb.enabled"""
    )
    op.drop_index("ix_supplier_badges_supplier_id", table_name="supplier_badges")
    op.drop_table("supplier_badges")
    op.drop_table("badges")
