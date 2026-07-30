"""Add expenses table (monthly recurring operating costs)

Cost side of the admin dashboard P&L. Mirrors the `revenue` table's shape
(UUID PK, Numeric(10,2) amount, period_start/period_end date range) so both
feed the same month/day bucketing in routes/dashboard.py.

`category` is a plain VARCHAR, not a native Postgres ENUM: the category set is
expected to grow, and adding a value to an enum needs an ALTER TYPE (values can
never be removed). The allowed set is enforced at the API boundary instead
(schemas/expense.py Literal -> 422).

Revision ID: 020
Revises: 019
Create Date: 2026-07-30
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "expenses",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("category", sa.String(30), nullable=False),
        sa.Column("vendor", sa.String(120), nullable=True),
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
    # The dashboard buckets expenses by period_start (month + day-of-month).
    op.create_index("ix_expenses_period_start", "expenses", ["period_start"])


def downgrade() -> None:
    op.drop_index("ix_expenses_period_start", table_name="expenses")
    op.drop_table("expenses")
