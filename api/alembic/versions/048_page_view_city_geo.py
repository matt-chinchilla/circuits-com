"""page_views city detail — region, city, and a centroid, from the same lookup.

Revision ID: 048
Revises: 047

Migration 040 added `country` and wrote down why it could never be backfilled:
`ip_hash` is one-way, so a row's address is gone the moment it is stored. That
holds here exactly as it did then — these four columns start empty and fill
forward, and every row written before this migration keeps a country and
nothing finer for the rest of its life. The analytics endpoint reports
`region_tracked_since` beside the existing `geo_tracked_since` so the map can
say when the finer data actually starts instead of implying it always had it.

Resolution depends on which database the container has: the committed
country-lite file yields `country` alone, and the city-lite file the image
downloads at build time fills the rest (see services/geoip.py).

`region` is the subdivision NAME ("New York"), not a code — DB-IP Lite ships
no subdivision iso_code — hence String(80) rather than String(2).

NULLABLE AND UNINDEXED, matching 040: NULL is the meaningful "unknown" value
here, and the aggregations that read these columns filter on `country` first,
which is itself unindexed. `page_views` is append-only and modest; adding
indexes on a write-hot table for panels that run once per dashboard load
would cost more than it saves.
"""

import sqlalchemy as sa
from alembic import op

revision = "048"
down_revision = "047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("page_views", sa.Column("region", sa.String(length=80), nullable=True))
    op.add_column("page_views", sa.Column("city", sa.String(length=80), nullable=True))
    op.add_column("page_views", sa.Column("latitude", sa.Float(), nullable=True))
    op.add_column("page_views", sa.Column("longitude", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("page_views", "longitude")
    op.drop_column("page_views", "latitude")
    op.drop_column("page_views", "city")
    op.drop_column("page_views", "region")
