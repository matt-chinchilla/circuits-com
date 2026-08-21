"""BOM tool part facts: package token, lifecycle truth-bit, upper(sku) index."""

import sqlalchemy as sa
from alembic import op

revision = "037"
down_revision = "036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("parts", sa.Column("package", sa.String(60), nullable=True))
    op.add_column(
        "parts", sa.Column("lifecycle_verified_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_index("ix_parts_sku_upper", "parts", [sa.text("upper(sku)")])


def downgrade() -> None:
    op.drop_index("ix_parts_sku_upper", table_name="parts")
    op.drop_column("parts", "lifecycle_verified_at")
    op.drop_column("parts", "package")
