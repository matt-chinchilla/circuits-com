"""parts.total_stock — the popular ordering as a column.

Revision ID: 053
Revises: 052

Measured on prod 2026-09-11 (115k connectors): the parent category page's
default "popular" sort summed every listing's stock for every part in the
category on EVERY request — an outer join, a GROUP BY over 115k parts and a
sort of the result, 1.1s warm — and the retired popular_parts block ran the
same aggregation a second time (1.3s) to return one row the client threw
away. The column holds that sum (`app/services/part_pricing.refresh_best_
prices` keeps it current on every write path, like the four price columns).
It is deliberately NOT indexed: the nightly feed moves stock on most of the
parts it touches, and an indexed column turns each of those row rewrites
from a HOT update into an entry in every index on `parts` (the write-waste
class CLAUDE.md records). The category page's popular sort is a bounded
top-N over the category's rows via ix_parts_category_id — ~50ms, not 1.1s.

The ADD COLUMN takes a fast default (PG11+: no table rewrite); the backfill
UPDATE does rewrite every part that has stock, once. Both run inside the
deploy's api-recreate window.
"""

import sqlalchemy as sa
from alembic import op

revision = "053"
down_revision = "052"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "parts",
        sa.Column("total_stock", sa.Integer(), nullable=False, server_default="0"),
    )
    op.execute(
        """
        UPDATE parts AS p
        SET total_stock = s.total
        FROM (
            SELECT part_id, COALESCE(SUM(stock_quantity), 0) AS total
            FROM part_listings
            GROUP BY part_id
        ) AS s
        WHERE s.part_id = p.id AND s.total <> 0
        """
    )


def downgrade() -> None:
    op.drop_column("parts", "total_stock")
