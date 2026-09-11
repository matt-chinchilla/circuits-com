"""parts.created_at index — the dashboard reads parts newest-first.

Revision ID: 052
Revises: 051

Measured on prod 2026-09-11 (570k parts, 566k of them created inside the
30-day window by the auto-import): GET /dashboard/activity sorted the whole
table to find its 10 newest rows (0.6s per dashboard load), and the trends
baseline count walked it too. ``created_at`` simply had no index — page_views
got one in 007 and lead_contacts in 036; parts never did.
"""

from alembic import op

revision = "052"
down_revision = "051"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_parts_created_at", "parts", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_parts_created_at", table_name="parts")
