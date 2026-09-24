"""leads.created_by — who typed a lead into the console (owner ask, 2026-09-23).

Revision ID: 058
Revises: 057

Salespeople can now add a lead from /admin (POST /api/admin/leads/); until
today the roster only ever arrived from leads.csv through the seed. The owner
asked for each hand-added row to say who added it.

A FREE-STRING username, exactly like ``lead_contacts.recorded_by`` and
``sponsors.sold_by``: NO foreign key to ``users``. ``users`` is inside the
``deploy.sh --reseed`` TRUNCATE CASCADE graph (via ``users.supplier_id``), and
TRUNCATE CASCADE follows every REFERENCING foreign key regardless of ON
DELETE — an FK here would enrol the whole CRM in a routine reseed. The census
in ``tests/test_leads_schema.py`` fails if one ever appears.

NO backfill: every existing row came from the roster import, and NULL is how
the console says "From the roster import". Nullable ADD COLUMN with no
default = a catalog-only change on Postgres, no table rewrite.
"""

import sqlalchemy as sa
from alembic import op

revision = "058"
down_revision = "057"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("leads", sa.Column("created_by", sa.String(120), nullable=True))


def downgrade() -> None:
    op.drop_column("leads", "created_by")
