"""Give self-serve sponsor rows a Stripe owner id.

A self-serve Silver row is created by the webhook AFTER Stripe made the
subscription, so it cannot carry sponsor_id in the subscription metadata. The
first cut resolved its later lifecycle events by the buyer-typed company name
plus placement — both PUBLIC on the board, so a stranger could pay $100 under
a live sponsor's name and cancel that sponsor's placement. This column is the
fix: the subscription id Stripe controls, matched exactly, is the only owner.

Nullable — rep-quoted sponsorships keep resolving by metadata sponsor_id and
leave it NULL. A partial unique index (Postgres) makes a redelivered checkout
a clean no-op while leaving every NULL row free; SQLite honors the same
predicate for the test suite.

Revision ID: 028
Revises: 027
"""

from alembic import op

revision = "028"
down_revision = "027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE sponsors ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(64)")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_sponsor_stripe_subscription "
        "ON sponsors (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_sponsor_stripe_subscription")
    op.execute("ALTER TABLE sponsors DROP COLUMN IF EXISTS stripe_subscription_id")
