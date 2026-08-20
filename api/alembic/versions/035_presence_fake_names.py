"""presence_fakes.names — named-individual selection for circuits --fakeuser.

CSV of roster usernames shown IN ADDITION to the count-prefix. Empty = none.
Written only by scripts/fakeuser.sh (--name flag); read by admin_presence.
"""

import sqlalchemy as sa
from alembic import op

revision = "035"
down_revision = "034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "presence_fakes",
        sa.Column("names", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("presence_fakes", "names")
