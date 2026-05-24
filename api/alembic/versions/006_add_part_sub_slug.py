"""Add parts.sub_slug — denormalized subcategory slug pointer

Revision ID: 006
Revises: 005
Create Date: 2026-05-24

The admin Parts table renders "Parent (Sub)" labels for the Category cell
(per the v5 Phosphor handoff). Currently `part_to_dict` walks Category +
Category.parent on every row to surface those slugs, which is fine for the
detail page but starts to bite on the paginated list. Storing the
subcategory slug directly on the Part lets the list endpoint skip the walk.

Backfill rule: when a Part's category_id points at a child Category (one
with non-null parent_id), set sub_slug = that child's slug. When it points
at a top-level Category (no parent), leave sub_slug NULL — the part is
classified at the parent level only, no sub.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("parts", sa.Column("sub_slug", sa.String(length=80), nullable=True))
    # Backfill — for every Part whose category_id points at a CHILD category
    # (parent_id IS NOT NULL), copy that child's slug into sub_slug. Single
    # UPDATE; no per-row Python loop.
    op.execute(
        """
        UPDATE parts
        SET sub_slug = c.slug
        FROM categories c
        WHERE parts.category_id = c.id
          AND c.parent_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_column("parts", "sub_slug")
