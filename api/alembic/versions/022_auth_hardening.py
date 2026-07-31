"""Auth hardening: email as unique login key, forced-reset flag, owner role

Task 1 of the P1 auth overhaul (see
``.superpowers/sdd/2026-07-31-p1-auth-overhaul-plan/``). Pure schema — lays
the groundwork later tasks build login, password policy, and enforcement on
top of. No auth routes/services touched here.

  - ``users.email`` -> NOT NULL + a case-insensitive unique index
    (``uq_users_email_lower``, ``lower(email)``) so login can move to
    email-as-identifier without two rows silently colliding on
    ``Foo@x.com`` / ``foo@x.com``. All 5 current rows already carry an
    address (verified against the running local DB); upgrade() re-asserts
    that itself and fails loudly instead of silently corrupting a row.
  - ``users.must_change_password`` (BOOLEAN NOT NULL DEFAULT false) — set
    true below for the accounts whose credentials this migration treats as
    "must rotate soon"; a later task enforces it at login.
  - ``users.password_changed_at`` (TIMESTAMPTZ, nullable) — backfilled to
    ``now()`` for every existing row so this deploy does not mass-invalidate
    anything a later task keys off this column (e.g. token-issued-before
    checks). New rows get NULL until an actual password change stamps it
    (task 4); the model default is intentionally None, not now().
  - The ``user_role`` Postgres enum (created in 002) gains ``'owner'`` — a
    cross-mailbox tier above ``admin``. ``ALTER TYPE ... ADD VALUE`` cannot
    run inside the transaction block Alembic wraps a migration in (and even
    where PG allows the ALTER itself mid-transaction, the new value can't be
    *used* until that ALTER is committed), so it runs in its own
    autocommit block — committed on its own before the rest of this
    migration's statements execute, so the data backfill below can safely
    reference ``'owner'`` in the same run. Postgres enum values can never be
    dropped once added, so ``downgrade()`` leaves ``'owner'`` in the type
    permanently (same schema-only-reversal tradeoff already taken in this
    file's history, e.g. 016's downgrade docstring).
  - One-time data backfill (not idempotent, not reapplied by seed.py — this
    is a migration-time event, not an app invariant): the brief specified
    usernames lowercase (anthony/daniel/matthew/ronald), but the live rows
    are ``Anthony``/``Daniel``/``Ronald``/``matthew`` (seed.py's login
    lookup is case-sensitive, see its comment) — matched here via
    ``lower(username)`` so the intent holds regardless of which casing a
    given environment's rows actually have. Those 4 get
    ``must_change_password = true``; ``matthew`` additionally becomes
    ``role = 'owner'``. ``demo`` (the public demo login) is untouched.

SQLite test note: the suite builds tables via ``Base.metadata.create_all``
(tests/conftest.py), never runs migrations — so the ``ALTER TYPE`` piece has
no SQLite analogue at all, and per CLAUDE.md such Postgres-only contracts
get asserted on model metadata, not DB behavior. The functional unique index
is the one piece that genuinely *does* have a SQLite analogue (SQLite honors
expression/unique indexes same as Postgres), so it's declared on
``User.__table_args__`` too rather than left migration-only — create_all
reproduces the identical constraint for tests. See
``tests/test_auth_hardening.py``.

Revision ID: 022
Revises: 021
Create Date: 2026-07-31
"""

from alembic import op
import sqlalchemy as sa

revision = "022"
down_revision = "021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- email: assert clean, then tighten --------------------------------
    conn = op.get_bind()
    empty_or_null = conn.execute(
        sa.text("SELECT username FROM users WHERE email IS NULL OR email = ''")
    ).fetchall()
    if empty_or_null:
        usernames = ", ".join(row[0] for row in empty_or_null)
        raise RuntimeError(
            "Cannot enforce users.email NOT NULL — row(s) with no email: "
            f"{usernames}. Backfill their email, then re-run this migration."
        )
    op.alter_column(
        "users",
        "email",
        existing_type=sa.String(length=255),
        nullable=False,
        existing_nullable=True,
    )
    op.execute("CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email))")

    # --- must_change_password / password_changed_at -----------------------
    op.add_column(
        "users",
        sa.Column(
            "must_change_password",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "users",
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE users SET password_changed_at = now()")

    # --- user_role enum: add 'owner' ---------------------------------------
    # Must run as its own autocommit-ed statement — see module docstring.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'owner'")

    # --- one-time data backfill ---------------------------------------------
    op.execute(
        "UPDATE users SET must_change_password = true "
        "WHERE lower(username) IN ('anthony', 'daniel', 'ronald', 'matthew')"
    )
    op.execute("UPDATE users SET role = 'owner' WHERE lower(username) = 'matthew'")


def downgrade() -> None:
    # Schema-only reversal — the 'owner' enum value is permanent (Postgres
    # can't drop enum values) and the data backfill above is a one-time
    # event, not reverted here. See module docstring.
    op.drop_column("users", "password_changed_at")
    op.drop_column("users", "must_change_password")
    op.execute("DROP INDEX IF EXISTS uq_users_email_lower")
    op.alter_column(
        "users",
        "email",
        existing_type=sa.String(length=255),
        nullable=True,
        existing_nullable=False,
    )
