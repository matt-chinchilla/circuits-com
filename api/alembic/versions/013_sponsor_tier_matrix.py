"""Sponsor tier matrix — platinum top / gold+silver sub / silver+gold keyword

Rewrites the tier↔placement matrix introduced in migration 011 for the
2026-06-11 tier-boards redesign:

  - Top-level category (``parent_id IS NULL``) ⇒ **platinum** (was Featured).
  - Subcategory (child) ⇒ **gold** or **silver** (was platinum/gold).
  - Keyword ⇒ **silver** or **gold** (platinum dropped — top-level-only now).

ORDER IS LOAD-BEARING in ``upgrade()``: the old trigger would REJECT the
backfill UPDATEs (e.g. setting a top-level row to 'platinum' raises under the
011 trigger that demands 'featured'), so we (1) DROP the old trigger + function,
(2) backfill, (3) CREATE the new function + trigger.

``downgrade()`` restores the migration-011 trigger verbatim after dropping the
new one (it does NOT reverse the data backfill — the old trigger accepts the
new-matrix data only for child platinum→… mappings, so a clean downgrade of
data is not attempted; the trigger restoration is the contract).

Revision ID: 013
Revises: 012
Create Date: 2026-06-11
"""

from alembic import op

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


# New matrix trigger function (2026-06-11): platinum top, gold/silver child,
# silver/gold keyword.
TRIGGER_FN = """
CREATE OR REPLACE FUNCTION sponsor_tier_placement_check() RETURNS trigger AS $$
DECLARE
  is_top_level boolean;
  t text := lower(coalesce(NEW.tier, ''));
BEGIN
  IF NEW.category_id IS NOT NULL THEN
    SELECT (parent_id IS NULL) INTO is_top_level FROM categories WHERE id = NEW.category_id;
    IF is_top_level THEN
      IF t <> 'platinum' THEN
        RAISE EXCEPTION 'Top-level category sponsorship must be Platinum (got %)', NEW.tier;
      END IF;
    ELSE
      IF t NOT IN ('gold', 'silver') THEN
        RAISE EXCEPTION 'Subcategory sponsorship must be Gold or Silver (got %)', NEW.tier;
      END IF;
    END IF;
  ELSIF NEW.keyword IS NOT NULL THEN
    IF t NOT IN ('silver', 'gold') THEN
      RAISE EXCEPTION 'Keyword sponsorship must be Silver or Gold (got %)', NEW.tier;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""


# Migration-011 trigger function, restored verbatim by downgrade(): featured
# top, platinum/gold child, silver/gold/platinum keyword.
TRIGGER_FN_011 = """
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
    # (1) Drop the old trigger + function FIRST — the 011 matrix would reject
    #     the backfill UPDATEs below (e.g. a top-level row going to 'platinum').
    op.execute("DROP TRIGGER IF EXISTS sponsor_tier_placement_check_trg ON sponsors")
    op.execute("DROP FUNCTION IF EXISTS sponsor_tier_placement_check()")

    # (2) Backfill existing rows to the new tiers.
    #   - top-level Featured → platinum
    op.execute(
        """
        UPDATE sponsors SET tier = 'platinum'
        WHERE category_id IN (SELECT id FROM categories WHERE parent_id IS NULL)
          AND lower(coalesce(tier, '')) <> 'platinum'
        """
    )
    #   - child platinum (or any non gold/silver) → gold
    op.execute(
        """
        UPDATE sponsors SET tier = 'gold'
        WHERE category_id IN (SELECT id FROM categories WHERE parent_id IS NOT NULL)
          AND lower(coalesce(tier, '')) NOT IN ('gold', 'silver')
        """
    )
    #   - keyword platinum (or any non silver/gold) → gold
    op.execute(
        """
        UPDATE sponsors SET tier = 'gold'
        WHERE keyword IS NOT NULL
          AND lower(coalesce(tier, '')) NOT IN ('silver', 'gold')
        """
    )

    # (3) Create the new function + trigger.
    op.execute(TRIGGER_FN)
    op.execute(
        """
        CREATE TRIGGER sponsor_tier_placement_check_trg
        BEFORE INSERT OR UPDATE ON sponsors
        FOR EACH ROW EXECUTE FUNCTION sponsor_tier_placement_check()
        """
    )


def downgrade() -> None:
    # Restore the migration-011 trigger verbatim. Drop the new one first so the
    # old function body would reject any new-matrix data on the next write.
    op.execute("DROP TRIGGER IF EXISTS sponsor_tier_placement_check_trg ON sponsors")
    op.execute("DROP FUNCTION IF EXISTS sponsor_tier_placement_check()")
    op.execute(TRIGGER_FN_011)
    op.execute(
        """
        CREATE TRIGGER sponsor_tier_placement_check_trg
        BEFORE INSERT OR UPDATE ON sponsors
        FOR EACH ROW EXECUTE FUNCTION sponsor_tier_placement_check()
        """
    )
