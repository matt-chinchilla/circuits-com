"""Add expenses.source + expenses.updated_at (automated cost sync)

The Cost Breakdown showed one AWS number and it was a list-price ESTIMATE
(app/services/aws_cost.py) planted by the seed. This column is what lets real
actuals — AWS Cost Explorer, Stripe settlement fees — land in the SAME table
without ever colliding with what a person typed:

  manual    a human wrote it in /admin/expenses. NEVER touched by a sync.
  estimate  the seed's computed AWS figure. Kept as the fallback, and DELETED
            for a month once an 'aws' actual for that month arrives (two rows
            for one bill is a double count, not a cross-check).
  aws       Cost Explorer, per Application tag.
  stripe    settlement fees summed from balance transactions.

`updated_at` is the staleness clock for the sync job. Each GetCostAndUsage call
costs $0.01, so the job asks "is the newest aws row older than 22 hours?"
before spending one; without a per-row timestamp it would either call hourly or
keep that state somewhere outside the database.

Both columns are added with ADD COLUMN IF NOT EXISTS and a server_default for
the same reason 022-025 use raw idempotent SQL: alembic/env.py sets no
`transaction_per_migration`, so a failure partway through `upgrade head` leaves
the api entrypoint replaying this file on the next container start — and a
migration that dies on "column already exists" crash-loops the api with /api/*
at 502. The NOT NULL on `source` is safe on a populated table precisely because
the DEFAULT is supplied in the same statement: existing rows are all human-
entered or seeded, and 'manual' is the correct, conservative answer for them
(it means "a sync will leave this alone").

No index: `expenses` holds tens of rows, and the job's `WHERE source = 'aws'`
against a table that small is a sequential scan either way.

SQLite test note: the suite builds tables with `Base.metadata.create_all` and
never runs migrations, so the contract is declared on the model too
(app/models/expense.py) — that is what tests/test_cost_sync.py exercises.

Revision ID: 026
Revises: 025
Create Date: 2026-08-11
"""

from alembic import op

revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None


ADD_SOURCE = """
ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual'
"""

ADD_UPDATED_AT = """
ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
"""

# One-time backfill of EXISTING rows, in the spirit of 022's promotion.
#
# Without it this migration is quietly wrong on every populated database: the
# AWS rows the seed already planted default to 'manual' along with everything
# else, so the first real Cost Explorer sync would NOT supersede them — it
# would add an actual next to an estimate that now claims to be hand-entered,
# and infrastructure spend would read roughly double. `--reseed` does not fix
# it either: `expenses` is outside the TRUNCATE graph and `_seed_expenses`
# returns early when any row exists.
#
# Scoped as tightly as the data allows — category, vendor AND the exact opening
# of the description string, which only db/seed.py writes. A row a person typed
# cannot match all three by accident, and mislabelling one 'estimate' would
# mean a later sync DELETES it.
BACKFILL_ESTIMATES = """
UPDATE expenses
   SET source = 'estimate'
 WHERE source = 'manual'
   AND category = 'infrastructure'
   AND vendor = 'Amazon Web Services'
   AND description LIKE 'ESTIMATE (list price, not an invoice)%'
"""


def upgrade() -> None:
    op.execute(ADD_SOURCE)
    op.execute(ADD_UPDATED_AT)
    op.execute(BACKFILL_ESTIMATES)


def downgrade() -> None:
    op.execute("ALTER TABLE expenses DROP COLUMN IF EXISTS updated_at")
    op.execute("ALTER TABLE expenses DROP COLUMN IF EXISTS source")
