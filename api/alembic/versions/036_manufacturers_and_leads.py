"""Manufacturers + Leads CRM (admin-only sales tooling).

Five FK-isolated tables + the one supplier bridge column + parts resolution
column. FK DIRECTION IS THE RESEED-SAFETY DESIGN: nothing here references
{suppliers, users, categories, sponsors, parts, category_suppliers}, so
deploy.sh --reseed's TRUNCATE ... CASCADE can never reach sales data.
Own deploy — never run alongside --reseed (DDL/TRUNCATE deadlock gotcha).
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "036"
down_revision = "035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "manufacturers",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("slug", sa.String(220), nullable=False, unique=True),
        sa.Column("canonical_key", sa.String(220), nullable=False),
        sa.Column("website", sa.String(300), nullable=True),
        sa.Column("logo_url", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("external_part_count", sa.Integer(), nullable=True),
        sa.Column("external_part_count_source", sa.String(40), nullable=True),
        sa.Column("external_part_count_as_of", sa.Date(), nullable=True),
        sa.Column("catalog_part_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("source", sa.String(20), nullable=False, server_default="catalog"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("uq_manufacturers_canonical_key", "manufacturers", ["canonical_key"], unique=True)
    op.create_index("ix_manufacturers_name_lower", "manufacturers", ["name"])

    op.create_table(
        "manufacturer_aliases",
        sa.Column("manufacturer_id", UUID(as_uuid=True),
                  sa.ForeignKey("manufacturers.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("alias_canon", sa.String(220), primary_key=True),
        sa.Column("alias", sa.String(200), nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("confidence", sa.String(10), nullable=False),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_manufacturer_aliases_mid", "manufacturer_aliases", ["manufacturer_id"])
    op.create_index("uq_manufacturer_aliases_canon", "manufacturer_aliases", ["alias_canon"], unique=True)

    op.create_table(
        "manufacturer_merge_candidates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("left_manufacturer_id", UUID(as_uuid=True),
                  sa.ForeignKey("manufacturers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("right_alias", sa.String(200), nullable=False),
        sa.Column("rule", sa.String(30), nullable=False),
        sa.Column("evidence", sa.Text(), nullable=True),
        sa.Column("status", sa.String(12), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_merge_candidates_left", "manufacturer_merge_candidates", ["left_manufacturer_id"])

    op.create_table(
        "leads",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("source_key", sa.String(300), nullable=False),
        sa.Column("company_name", sa.String(200), nullable=False),
        sa.Column("branch_label", sa.String(80), nullable=True),
        sa.Column("company_slug", sa.String(220), nullable=False),
        sa.Column("manufacturer_id", UUID(as_uuid=True),
                  sa.ForeignKey("manufacturers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("tier", sa.String(1), nullable=True),
        sa.Column("ring", sa.String(12), nullable=True),
        sa.Column("street", sa.String(200), nullable=True),
        sa.Column("city", sa.String(80), nullable=True),
        sa.Column("state", sa.String(2), nullable=True),
        sa.Column("postal_code", sa.String(10), nullable=True),
        sa.Column("main_phone", sa.String(24), nullable=True),
        sa.Column("website", sa.String(200), nullable=True),
        sa.Column("sales_email", sa.String(200), nullable=True),
        sa.Column("contact_name", sa.String(120), nullable=True),
        sa.Column("needs_enrichment", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("contact_title", sa.String(120), nullable=True),
        sa.Column("direct_phone", sa.String(24), nullable=True),
        sa.Column("contact_email", sa.String(200), nullable=True),
        sa.Column("linkedin_url", sa.String(300), nullable=True),
        sa.Column("hours_tz", sa.String(40), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("last_outcome", sa.String(12), nullable=True),
        sa.Column("last_contacted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("contact_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("uq_leads_source_key", "leads", ["source_key"], unique=True)
    op.create_index("ix_leads_company_slug", "leads", ["company_slug"])
    op.create_index("ix_leads_last_outcome", "leads", ["last_outcome"])
    op.create_index("ix_leads_manufacturer_id", "leads", ["manufacturer_id"])

    op.create_table(
        "lead_contacts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("lead_id", UUID(as_uuid=True),
                  sa.ForeignKey("leads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("outcome", sa.String(12), nullable=False),
        sa.Column("sale_tier", sa.String(10), nullable=True),
        sa.Column("note", sa.String(500), nullable=True),
        sa.Column("recorded_by", sa.String(120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_lead_contacts_lead_id", "lead_contacts", ["lead_id"])
    op.create_index("ix_lead_contacts_created_at", "lead_contacts", ["created_at"])

    op.add_column("suppliers", sa.Column("manufacturer_id", UUID(as_uuid=True),
                  sa.ForeignKey("manufacturers.id", ondelete="SET NULL"), nullable=True))
    op.create_index("uq_suppliers_manufacturer", "suppliers", ["manufacturer_id"],
                    unique=True, postgresql_where=sa.text("manufacturer_id IS NOT NULL"))

    op.add_column("parts", sa.Column("manufacturer_id", UUID(as_uuid=True),
                  sa.ForeignKey("manufacturers.id", ondelete="SET NULL"), nullable=True))
    op.create_index("ix_parts_manufacturer_id", "parts", ["manufacturer_id"])
    op.create_index("ix_parts_manufacturer_name", "parts", ["manufacturer_name"])


def downgrade() -> None:
    op.drop_index("ix_parts_manufacturer_name", table_name="parts")
    op.drop_index("ix_parts_manufacturer_id", table_name="parts")
    op.drop_column("parts", "manufacturer_id")
    op.drop_index("uq_suppliers_manufacturer", table_name="suppliers")
    op.drop_column("suppliers", "manufacturer_id")
    op.drop_table("lead_contacts")
    op.drop_table("leads")
    op.drop_table("manufacturer_merge_candidates")
    op.drop_table("manufacturer_aliases")
    op.drop_table("manufacturers")
