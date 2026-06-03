"""Sponsorship single source of truth

Drop CategorySupplier.is_featured/rank (the banner now reads Featured sponsorships
from the `sponsors` table), and make `sponsors` ACID-consistent:
- UNIQUE(supplier_id, category_id) and UNIQUE(supplier_id, keyword) — a company
  sponsors any category/keyword at most once (NULLs are SQL-distinct, so its many
  keyword rows and many category rows coexist; the ≤15 + ≤75 caps fall out of the
  taxonomy size).
- Trigger enforcing tier↔placement: Featured⟺top-level, Platinum/Gold⟺child,
  keyword⟺Silver/Gold/Platinum.

Backfill + dedup first so the constraints apply to existing (pre-reseed) data.

Revision ID: 011
Revises: 010
Create Date: 2026-06-03
"""

from alembic import op
import sqlalchemy as sa

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


TRIGGER_FN = """
CREATE OR REPLACE FUNCTION sponsor_tier_placement_check() RETURNS trigger AS $$
DECLARE
  is_top_level boolean;
  t text := lower(coalesce(NEW.tier, ''));
BEGIN
  IF NEW.category_id IS NOT NULL THEN
    SELECT (parent_id IS NULL) INTO is_top_level FROM categories WHERE id = NEW.category_id;
    IF is_top_level THEN
      IF t <> 'featured' THEN
        RAISE EXCEPTION 'Top-level category sponsorship must be Featured (got %)', NEW.tier;
      END IF;
    ELSE
      IF t NOT IN ('platinum', 'gold') THEN
        RAISE EXCEPTION 'Subcategory sponsorship must be Platinum or Gold (got %)', NEW.tier;
      END IF;
    END IF;
  ELSIF NEW.keyword IS NOT NULL THEN
    IF t NOT IN ('silver', 'gold', 'platinum') THEN
      RAISE EXCEPTION 'Keyword sponsorship must be Silver, Gold, or Platinum (got %)', NEW.tier;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    # --- Reconcile existing data so the new constraints/trigger accept it -----
    # A top-level category sponsor must be Featured (legacy seed used 'gold').
    op.execute(
        """
        UPDATE sponsors SET tier = 'Featured'
        WHERE category_id IN (SELECT id FROM categories WHERE parent_id IS NULL)
          AND lower(coalesce(tier, '')) <> 'featured'
        """
    )
    # Defensive dedup (keep the newest) so the unique constraints can be created
    # even if pre-existing data has duplicates. No-op on clean data.
    op.execute(
        """
        DELETE FROM sponsors a USING sponsors b
        WHERE a.category_id IS NOT NULL
          AND a.supplier_id = b.supplier_id AND a.category_id = b.category_id
          AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
        """
    )
    op.execute(
        """
        DELETE FROM sponsors a USING sponsors b
        WHERE a.keyword IS NOT NULL
          AND a.supplier_id = b.supplier_id AND a.keyword = b.keyword
          AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
        """
    )

    # --- Single source of truth: drop the CategorySupplier featured flags ------
    op.drop_column("category_suppliers", "is_featured")
    op.drop_column("category_suppliers", "rank")

    # --- ACID: uniqueness + tier↔placement trigger ----------------------------
    op.create_unique_constraint(
        "uq_sponsor_supplier_category", "sponsors", ["supplier_id", "category_id"]
    )
    op.create_unique_constraint(
        "uq_sponsor_supplier_keyword", "sponsors", ["supplier_id", "keyword"]
    )
    op.execute(TRIGGER_FN)
    op.execute(
        """
        CREATE TRIGGER sponsor_tier_placement_check_trg
        BEFORE INSERT OR UPDATE ON sponsors
        FOR EACH ROW EXECUTE FUNCTION sponsor_tier_placement_check()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS sponsor_tier_placement_check_trg ON sponsors")
    op.execute("DROP FUNCTION IF EXISTS sponsor_tier_placement_check()")
    op.drop_constraint("uq_sponsor_supplier_keyword", "sponsors", type_="unique")
    op.drop_constraint("uq_sponsor_supplier_category", "sponsors", type_="unique")
    op.add_column(
        "category_suppliers",
        sa.Column("rank", sa.Integer(), nullable=True, server_default="0"),
    )
    op.add_column(
        "category_suppliers",
        sa.Column("is_featured", sa.Boolean(), nullable=True, server_default=sa.false()),
    )
