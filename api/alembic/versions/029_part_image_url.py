"""Give parts a product-photo URL.

Distributor APIs (Digi-Key PhotoUrl, Mouser ImagePath) return an image link in
the same response that carries pricing, so the future price-feed sync can fill
this column at zero marginal cost. Nullable — the part page renders the
category icon as a package-drawing fallback when no image exists, so absence
is a first-class state, not an error.

Revision ID: 029
Revises: 028
"""

from alembic import op

revision = "029"
down_revision = "028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE parts ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)")


def downgrade() -> None:
    op.execute("ALTER TABLE parts DROP COLUMN IF EXISTS image_url")
