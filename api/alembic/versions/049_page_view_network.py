"""page_views.network — the AS organization behind the visitor's address.

Revision ID: 049
Revises: 048

The same forward-only story as 040 and 048, for the same unavoidable reason:
`ip_hash` is one-way, so no row written before this migration can ever learn
which network it came from. The column starts empty and fills forward.

It is resolved at track time from `data/dbip-asn-lite.mmdb`, a THIRD DB-IP
file the API image downloads at build time. That file has no committed
fallback, so on an image built without it every row stores NULL — which is
indistinguishable from pre-049 history in a query, and deliberately so: both
mean "we do not know", and the map panel has no business claiming otherwise.

String(120) because AS organization names are registry free-text
("Comcast Cable Communications, LLC"); the parser truncates to the same width.

NULLABLE AND UNINDEXED, matching 040 and 048: NULL is the meaningful value
here, and the per-city network breakdown that reads this column filters on
`country`/`city` first, which are themselves unindexed on an append-only
table that is modest in size.
"""

import sqlalchemy as sa
from alembic import op

revision = "049"
down_revision = "048"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("page_views", sa.Column("network", sa.String(length=120), nullable=True))


def downgrade() -> None:
    op.drop_column("page_views", "network")
