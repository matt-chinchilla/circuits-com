"""leads.photo_url — a contact's profile picture (owner ask, 2026-09-25).

Revision ID: 059
Revises: 058

"We need a way to upload profile pictures for leads." The picture is stored
the way every other admin image is: a base64 raster data-URL in the row
(the admin cropper's 256×256 WebP/JPEG, ≤ 64 KB) or a pasted http(s) URL.
The api container has no volume mount, so a file on its disk would be wiped
by the next rebuild; the database has a volume. TEXT, not VARCHAR — the
same reason migration 017 widened sponsors.image_url / suppliers.logo_url.

Nullable ADD COLUMN with no default = a catalog-only change on Postgres, no
table rewrite, and NO backfill: no lead has had a picture before today.
`leads` stays outside the reseed TRUNCATE graph (a plain column, no FK).
"""

import sqlalchemy as sa
from alembic import op

revision = "059"
down_revision = "058"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("leads", sa.Column("photo_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("leads", "photo_url")
