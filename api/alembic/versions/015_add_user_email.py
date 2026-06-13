"""User.email — recovery address for forgot-password / forgot-username

The 2026-06-13 admin login redesign adds real account recovery. Both flows need
an address to mail, which the ``users`` table lacked.

  - ``email`` ``String(255)`` nullable — legacy admin rows and the demo user may
    omit it; the recovery routes treat "no match" and "no email" identically
    (anti-enumeration), so nullability is safe.
  - ``ix_users_email`` — index for the case-insensitive lookup in
    ``/api/auth/forgot-password`` and ``/api/auth/forgot-username``.

Nullable ``ADD COLUMN`` (PG-only; SQLite tests build from the models via
``create_all`` and pick up the column + index flag directly).

Revision ID: 015
Revises: 014
Create Date: 2026-06-13
"""

import sqlalchemy as sa
from alembic import op

revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("email", sa.String(255), nullable=True))
    op.create_index("ix_users_email", "users", ["email"])


def downgrade() -> None:
    op.drop_index("ix_users_email", table_name="users")
    op.drop_column("users", "email")
