"""suppliers.founder — the founding-distributor incentive flag.

Revision ID: 054
Revises: 053

Owner ask, 2026-09-17, verbatim: "add an attribute to the `suppliers` table
called `founder`. It will be a boolean that will remain `True` until the
monthly-income we get from sponsors is over $5,000/month OR until I decide.
This will be `False` for every single supplier in the DataBase right now
because none of them are paying-customers yet."

Nothing here automates that $5,000/month sunset — the rule is recorded, not
implemented. The flag is set by hand from /admin (staff-only through the
existing require_staff wall) and read publicly off SupplierResponse.

NOT NULL with a constant server_default is exactly the "False for every
supplier right now" the owner asked for: on PG11+ the value is stored in the
catalog (attmissingval) and every existing row reads back false WITHOUT a
table rewrite, so the ADD COLUMN is a metadata-only operation inside the
deploy's api-recreate window.

The column is PER-ENVIRONMENT operational state, so `circuits pull/push` must
never carry it (both transfer scripts skip it) and `./deploy.sh --reseed`
TRUNCATEs it away with the rest of the suppliers table.
"""

import sqlalchemy as sa
from alembic import op

revision = "054"
down_revision = "053"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "suppliers",
        sa.Column("founder", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("suppliers", "founder")
