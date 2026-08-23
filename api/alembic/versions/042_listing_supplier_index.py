"""Index part_listings.supplier_id — the one FK on the table that never had one.

`part_id` has been indexed since the table was created; `supplier_id` never
was. Every query that asks "what does this distributor carry" therefore read
the whole table. Measured on production (212,187 listings) before this landed:

    Parallel Seq Scan on part_listings  (rows removed by filter: 70,729 x3)
    Buffers: shared hit=3778
    Execution Time: 30.712 ms

...to count ONE supplier's listings — a query the supplier detail page runs on
every view, and which the eight-surface delete cascade runs several times.

041's `UNIQUE(part_id, supplier_id)` does NOT cover this. A composite index can
serve a predicate on its leading column, not on its second one alone.

Sized for the direction of travel: with one real distributor the scan was
survivable, but the whole point of the multi-distributor work is that
`part_listings` grows by roughly the catalog size per distributor added.

Revision ID: 042
Revises: 041
"""

from alembic import op

revision = "042"
down_revision = "041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_part_listings_supplier_id", "part_listings", ["supplier_id"])


def downgrade() -> None:
    op.drop_index("ix_part_listings_supplier_id", table_name="part_listings")
