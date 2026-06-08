"""Index the hot category-page query columns

Phase 2 of the category-page performance work. Adds plain B-tree indexes on the
columns that drive every category nav: the per-page Part.category_id scan, the
denormalized Part.sub_slug filter, and the batched price-break joins
(PartListing.part_id, PriceBreak.listing_id, PriceBreak.min_quantity). Before
this, all five were unindexed -> sequential scans on ~3.6K parts / 41K listings /
164K price breaks.

Index-only migration — no column/constraint/trigger DDL — so it carries only a
brief lock during the api restart window and CANNOT deadlock a --reseed against a
heavy-DDL migration (the 011 hazard).

Revision ID: 012
Revises: 011
Create Date: 2026-06-07
"""

from alembic import op

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_parts_category_id", "parts", ["category_id"], unique=False
    )
    op.create_index("ix_parts_sub_slug", "parts", ["sub_slug"], unique=False)
    op.create_index(
        "ix_part_listings_part_id", "part_listings", ["part_id"], unique=False
    )
    op.create_index(
        "ix_price_breaks_listing_id", "price_breaks", ["listing_id"], unique=False
    )
    op.create_index(
        "ix_price_breaks_min_quantity",
        "price_breaks",
        ["min_quantity"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_price_breaks_min_quantity", table_name="price_breaks")
    op.drop_index("ix_price_breaks_listing_id", table_name="price_breaks")
    op.drop_index("ix_part_listings_part_id", table_name="part_listings")
    op.drop_index("ix_parts_sub_slug", table_name="parts")
    op.drop_index("ix_parts_category_id", table_name="parts")
