"""Label the seeded PLACEHOLDER expense rows source='estimate'.

Migration 026 backfilled only the AWS estimate. The other three placeholders
the seed plants — Stripe, Anthropic, Hover — are estimates by their own
description ("PLACEHOLDER — …"), but pre-existing rows on a live database
still carry source='manual' from 026's server_default. Left that way, the
first synced 'Stripe fees' line lands NEXT TO the manual $30 stand-in and the
payment category double-counts; relabeled 'estimate', the supersede rule
retires the stand-in the moment a real figure arrives (2026-08-11 review
finding).

Guards mirror 026's discipline: category, vendor, AND the PLACEHOLDER
description prefix must all match, so a hand-entered row that merely shares a
vendor name is never relabeled into something a sync may delete.

Idempotent and replayable: the UPDATE matches only rows still labeled
'manual', so a partial `upgrade head` replay changes nothing the second time.

Revision ID: 027
Revises: 026
"""

from alembic import op

revision = "027"
down_revision = "026"
branch_labels = None
depends_on = None

_PLACEHOLDERS = (
    ("payment", "Stripe"),
    ("ai", "Anthropic"),
    ("email", "Hover"),
)


def upgrade() -> None:
    for category, vendor in _PLACEHOLDERS:
        op.execute(
            "UPDATE expenses SET source = 'estimate' "
            f"WHERE source = 'manual' AND category = '{category}' "
            f"AND vendor = '{vendor}' AND description LIKE 'PLACEHOLDER%'"
        )


def downgrade() -> None:
    for category, vendor in _PLACEHOLDERS:
        op.execute(
            "UPDATE expenses SET source = 'manual' "
            f"WHERE source = 'estimate' AND category = '{category}' "
            f"AND vendor = '{vendor}' AND description LIKE 'PLACEHOLDER%'"
        )
