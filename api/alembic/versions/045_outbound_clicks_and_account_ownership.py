"""Referral clicks, per-account ownership of expenses/leads, the console KPI.

Revision ID: 045
Revises: 044

Three unrelated-looking pieces, one customer-console foundation:

a. ``outbound_clicks`` — one row per visitor who left a public part page for a
   distributor's own site. The only per-supplier demand signal this site can
   honestly produce (we never see the distributor's basket), so the console
   panel is labelled Referral Clicks and never Revenue.
b. ``expenses.user_id`` / ``leads.user_id`` — NULL means the row is Circuit
   Center's OWN (every row that exists today), a uuid means it belongs to a
   customer and is private to their console.
c. ``users.dashboard_kpi`` — which KPI the customer picked for their chart
   tile. NULL = the registry default.

*** NONE OF THESE COLUMNS TAKES A FOREIGN KEY, and that is the design, not an
oversight. ***

``deploy.sh --reseed`` runs ``TRUNCATE sponsors, category_suppliers,
categories, suppliers CASCADE``. TRUNCATE CASCADE is TABLE-level and
TRANSITIVE — it follows every REFERENCING foreign key and ignores ON DELETE
entirely — and both ``suppliers`` and ``users`` (via ``users.supplier_id``) are
already inside that graph. So an FK from ``outbound_clicks.supplier_id``,
``expenses.user_id`` or ``leads.user_id`` into it would silently enrol those
three tables in the cascade: a routine reseed would wipe the whole click
history, the entire cost book and the entire CRM, and nothing would fail. The
census in ``api/tests/test_leads_schema.py`` pins exactly which tables that
cascade reaches and what ``deploy.sh`` must carry across, so an accidental FK
here fails that test rather than a production deploy.

Referential validity is enforced at the WRITE SITES instead: the click beacon
(``routes/analytics.record_outbound_click``) inserts only a (part, supplier)
pair an EXISTS on ``part_listings`` confirms, and ``DELETE /api/admin/users/
{id}`` deletes the departing customer's expense and lead rows by hand because
no cascade will do it for them.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "045"
down_revision = "044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "outbound_clicks",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("part_id", UUID(as_uuid=True), nullable=True),
        sa.Column("supplier_id", UUID(as_uuid=True), nullable=False),
        sa.Column("clicked_at", sa.DateTime(timezone=True), nullable=False),
    )
    # The one question this table answers is "this supplier's clicks over this
    # window", so the index leads with supplier_id and carries the timestamp.
    op.create_index(
        "ix_outbound_clicks_supplier_clicked",
        "outbound_clicks",
        ["supplier_id", "clicked_at"],
    )

    op.add_column("expenses", sa.Column("user_id", UUID(as_uuid=True), nullable=True))
    op.create_index("ix_expenses_user_id", "expenses", ["user_id"])
    op.add_column("leads", sa.Column("user_id", UUID(as_uuid=True), nullable=True))
    op.create_index("ix_leads_user_id", "leads", ["user_id"])

    op.add_column("users", sa.Column("dashboard_kpi", sa.String(40), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "dashboard_kpi")
    op.drop_index("ix_leads_user_id", table_name="leads")
    op.drop_column("leads", "user_id")
    op.drop_index("ix_expenses_user_id", table_name="expenses")
    op.drop_column("expenses", "user_id")
    op.drop_index("ix_outbound_clicks_supplier_clicked", table_name="outbound_clicks")
    op.drop_table("outbound_clicks")
