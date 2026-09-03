"""user_role gains 'viewer' — read-only staff.

Revision ID: 051
Revises: 050

Owner ask 2026-09-03: a prospective partner should be able to see the whole
admin console (reporting included) without being able to change anything.
Nothing in the schema enforced "read-only" — the customer/staff wall admits a
role or refuses it — so the role is a new enum value and the enforcement is
in code: `auth_service.require_staff` admits a viewer on GET/HEAD/OPTIONS and
refuses every other verb with 403 read_only.

Same shape as 022's 'owner': ``ALTER TYPE ... ADD VALUE`` cannot be USED in
the transaction that adds it, so it runs in its own autocommit block, and it
is written ``IF NOT EXISTS`` so a replay is a no-op. No row is changed here —
promoting an account is a one-off UPDATE by the owner, never a migration
(the seed creates nobody as a viewer).

Postgres cannot drop an enum value, so ``downgrade()`` leaves it in the type
(harmless: no code path assigns it once this revision is rolled back).
"""

from alembic import op

revision = "051"
down_revision = "050"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return  # SQLite builds the enum CHECK from the model (create_all)
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'viewer'")


def downgrade() -> None:
    # Schema-only reversal — a Postgres enum value is permanent.
    pass
