"""lead_enrichment_searches — every Hunter search, kept (owner ask, 2026-09-25).

Revision ID: 060
Revises: 059

"Prevent people from searching companies that have already been searched for."
Each Hunter search spends a credit, and until now the only memory was a 24 h
in-process cache that died with the api container. A search's mapped answer
is now written once and read forever: one row per (kind, key), where kind is
'domain-search' (key = the company's domain) or 'email-finder' (key =
"domain|normalised full name").

No FK to leads on purpose — a company is searched once for ALL its branch
rows, and the table stays outside the reseed TRUNCATE graph. No backfill: the
old cache held nothing durable.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "060"
down_revision = "059"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "lead_enrichment_searches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("key", sa.String(400), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("searched_by", sa.String(120), nullable=True),
        sa.Column("searched_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("kind", "key", name="uq_lead_enrichment_searches_kind_key"),
    )


def downgrade() -> None:
    op.drop_table("lead_enrichment_searches")
