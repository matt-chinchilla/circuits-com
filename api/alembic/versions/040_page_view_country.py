"""page_views.country — ISO alpha-2 resolved at track-time (DB-IP Lite).

NULL means unknown: every row written before this column existed stays NULL
forever (ip_hash is one-way, history cannot be geolocated), as does any view
whose lookup failed. The analytics endpoint reports those separately as
geo_unknown_views rather than pretending coverage.

Revision ID: 040
Revises: 039
"""

import sqlalchemy as sa
from alembic import op

revision = "040"
down_revision = "039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("page_views", sa.Column("country", sa.String(length=2), nullable=True))


def downgrade() -> None:
    op.drop_column("page_views", "country")
