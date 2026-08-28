"""Miles-from-HQ on the Leads roster.

Revision ID: 047
Revises: 046

`leads.distance_miles` = straight-line miles from the company's own address
(79 Creighton Ave, Lake Ronkonkoma, NY 11779) to the lead's ZIP-code centroid,
one decimal. It backs the Location column's "City, ST | N miles" render and
the list endpoint's distance sort/filter.

NO BACKFILL HERE, deliberately: computing it needs `lead_distance` and its
committed centroid dataset, and no migration in this repo imports app code.
The seed drains NULLs on the next container start (`seed_leads` backfill pass,
the same division of labor as `manufacturer_id`), which also covers rows added
later from new CSV drops.

Nullable and unindexed: NULL means "ZIP absent or unknown" (renders as an
em-dash, excluded from distance filters), and 359 rows need no index to sort.
"""

import sqlalchemy as sa
from alembic import op

revision = "047"
down_revision = "046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("leads", sa.Column("distance_miles", sa.Numeric(7, 1), nullable=True))


def downgrade() -> None:
    op.drop_column("leads", "distance_miles")
