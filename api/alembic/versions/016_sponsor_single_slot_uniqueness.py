"""Single-slot sponsor uniqueness — BLOCK, not supersede (2026-06-22).

At most ONE active sponsor may hold a single-occupant placement:
  - Platinum on a top-level category (``parent_id IS NULL``),
  - Gold on a subcategory (``parent_id IS NOT NULL``).

The admin API blocks a second one with 409 (``_reject_if_slot_taken``); these
PARTIAL UNIQUE INDEXES are the un-bypassable DB backstop, covering the seed /
raw-SQL / concurrent-insert paths the API check can't. "Active" = status
``'Active'`` OR ``NULL`` (legacy seed rows omit status; NULL is treated as active
everywhere — a naive ``status <> 'Expired'`` would skip them under SQL
three-valued logic).

ORDER IS LOAD-BEARING in ``upgrade()``: the unique indexes cannot be built while
an active duplicate exists, so we first CLEAN UP the existing data, THEN create
them. Per the 2026-06-22 product decision — incumbent (oldest active) wins, removed
rows are HARD-DELETED (not soft-expired):
  (1) de-dup active occupants: keep the OLDEST active per (category, tier), delete
      the newer actives;
  (2) purge the Expired single-slot history rows (the admin-list "duplicates").

Postgres-only (partial indexes + a window-function DELETE). The test suite builds
the schema from the models via ``create_all`` and skips migrations, so the
API-level block is what it exercises — exactly like the tier-placement trigger
from migration 013. ``downgrade()`` drops the indexes; the data deletes are not
reversed.

Revision ID: 016
Revises: 015
Create Date: 2026-06-22
"""

from alembic import op

revision = "016"
down_revision = "015"
branch_labels = None
depends_on = None

# Visible/active sponsor predicate — must mirror the app
# (``category_service._active_sponsor`` / ``admin_sponsors._reject_if_slot_taken``).
_ACTIVE = "(status = 'Active' OR status IS NULL)"


def upgrade() -> None:
    # (1) De-duplicate ACTIVE single-slot occupants: keep the OLDEST active per
    #     (category_id, tier), hard-delete any newer actives. The incumbent wins.
    #     (No active duplicates exist on prod today — the write-path supersede kept
    #     one — so this is a defensive backstop for seed / raw-SQL drift.)
    op.execute(
        f"""
        DELETE FROM sponsors WHERE id IN (
            SELECT id FROM (
                SELECT id, row_number() OVER (
                    PARTITION BY category_id, lower(tier)
                    ORDER BY created_at ASC, id ASC
                ) AS rn
                FROM sponsors
                WHERE category_id IS NOT NULL
                  AND lower(coalesce(tier, '')) IN ('platinum', 'gold')
                  AND {_ACTIVE}
            ) ranked
            WHERE rn > 1
        )
        """
    )

    # (2) Purge the Expired single-slot history rows (the admin-list clutter the
    #     cleanup targets — e.g. PMICs' 5 superseded Platinum rows).
    op.execute(
        """
        DELETE FROM sponsors
        WHERE category_id IS NOT NULL
          AND lower(coalesce(tier, '')) IN ('platinum', 'gold')
          AND status = 'Expired'
        """
    )

    # (3) DB backstop: at most one ACTIVE Platinum per (top-level) category and one
    #     ACTIVE Gold per (sub)category. Keyed on category_id alone is exact —
    #     Platinum only lands on top-level cats and Gold only on children (the
    #     tier-placement trigger from migration 013 enforces that). Silver
    #     (directory) and keyword placements are deliberately excluded → still many.
    op.execute(
        f"""
        CREATE UNIQUE INDEX uq_active_platinum_per_category
        ON sponsors (category_id)
        WHERE category_id IS NOT NULL AND lower(tier) = 'platinum' AND {_ACTIVE}
        """
    )
    op.execute(
        f"""
        CREATE UNIQUE INDEX uq_active_gold_per_category
        ON sponsors (category_id)
        WHERE category_id IS NOT NULL AND lower(tier) = 'gold' AND {_ACTIVE}
        """
    )


def downgrade() -> None:
    # Indexes are reversible; the data cleanup (deletes) is not.
    op.execute("DROP INDEX IF EXISTS uq_active_gold_per_category")
    op.execute("DROP INDEX IF EXISTS uq_active_platinum_per_category")
