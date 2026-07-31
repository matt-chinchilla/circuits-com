"""Auth hardening: email as unique login key, forced-reset flag, owner role

Task 1 of the P1 auth overhaul (see
``.superpowers/sdd/2026-07-31-p1-auth-overhaul-plan/``). Pure schema — lays
the groundwork later tasks build login, password policy, and enforcement on
top of. No auth routes/services touched here.

  - The ``user_role`` Postgres enum (created in 002) gains ``'owner'`` — a
    cross-mailbox tier above ``admin``. ``ALTER TYPE ... ADD VALUE`` cannot
    run inside the transaction block Alembic wraps a migration in (and even
    where PG allows the ALTER itself mid-transaction, the new value can't be
    *used* until that ALTER is committed), so it runs in its own autocommit
    block. That block is deliberately the **first** statement of
    ``upgrade()`` — see "Replay safety" below. Postgres enum values can never
    be dropped once added, so ``downgrade()`` leaves ``'owner'`` in the type
    permanently (same schema-only-reversal tradeoff already taken in this
    file's history, e.g. 016's downgrade docstring).
  - ``users.email`` -> NOT NULL + a case-insensitive unique index
    (``uq_users_email_lower``, ``lower(email)``) so login can move to
    email-as-identifier without two rows silently colliding on
    ``Foo@x.com`` / ``foo@x.com``. All 5 current rows already carry an
    address (verified against the running local DB); upgrade() re-asserts
    that itself and fails loudly instead of silently corrupting a row.
  - ``users.must_change_password`` (BOOLEAN NOT NULL DEFAULT false) — set
    true below for the accounts whose credentials this migration treats as
    "must rotate soon"; a later task enforces it at login.
  - ``users.password_changed_at`` (TIMESTAMPTZ, nullable) — added and left
    **NULL** on every existing row. NULL is what "no constraint" means here:
    the session check (task 3,
    ``auth_service.token_predates_password_change``) rejects any token whose
    ``iat`` predates this column, so backfilling ``now()`` would invalidate
    every live session the moment this deploy lands — the exact opposite of
    the intent, and for rows whose password was never actually changed the
    stamp would also be a lie. Only a real password change stamps it
    (task 4); the model default is intentionally None.
  - One-time data backfill (catch-up for already-deployed rows; ``seed.py``
    holds the same invariant for fresh/reseeded databases, where this
    ``UPDATE`` matches zero rows because ``users`` is still empty): the brief
    specified usernames lowercase (anthony/daniel/matthew/ronald), but the
    live rows are ``Anthony``/``Daniel``/``Ronald``/``matthew`` (seed.py's
    login lookup is case-sensitive, see its comment) — matched here via
    ``lower(username)`` so the intent holds regardless of which casing a
    given environment's rows actually have. Those 4 get
    ``must_change_password = true``; ``matthew`` additionally becomes
    ``role = 'owner'``. ``demo`` (the public demo login) is untouched.

Replay safety
-------------
``alembic/env.py`` configures no ``transaction_per_migration``, so an
``upgrade head`` run is ONE transaction — and ``autocommit_block()`` COMMITS
it on entry. Anything executed before that block is therefore committed
permanently while ``alembic_version`` is still unstamped, so a failure later
in this same migration would leave the DDL applied but the revision
unrecorded: the api entrypoint re-runs ``alembic upgrade head`` on the next
container start, 022 replays from the top, dies on an object that already
exists, and the api crash-loops with ``/api/*`` at 502 until someone
hand-edits ``alembic_version`` on the box. Two rules keep that from
happening, and BOTH must hold if a statement is ever added here:

  1. The autocommit block is the FIRST statement, so every later step shares
     one transaction with 022's own version stamp — a failure rolls all of it
     back and replay starts from a clean slate.
  2. Every statement is written idempotently anyway (``ADD VALUE IF NOT
     EXISTS`` / ``CREATE UNIQUE INDEX IF NOT EXISTS`` / ``ADD COLUMN IF NOT
     EXISTS``, ``SET NOT NULL`` and the ``UPDATE``s being naturally
     re-runnable), so a replay is safe even if rule 1 is ever broken. This is
     why the columns are added with raw SQL instead of ``op.add_column``,
     which has no IF NOT EXISTS form. See
     ``tests/test_auth_hardening.py::TestMigrationReplaySafety``, which runs
     ``upgrade()`` twice against a throwaway Postgres database.

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
    # --- user_role enum: add 'owner' ---------------------------------------
    # MUST stay the first statement — see "Replay safety" in the docstring.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'owner'")

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
    op.execute("ALTER TABLE users ALTER COLUMN email SET NOT NULL")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email))"
    )

    # --- must_change_password / password_changed_at -----------------------
    # Raw SQL, not op.add_column: only ADD COLUMN has an IF NOT EXISTS form.
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password "
        "BOOLEAN NOT NULL DEFAULT false"
    )
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at "
        "TIMESTAMP WITH TIME ZONE"
    )
    # password_changed_at is deliberately NOT backfilled — NULL means "no
    # constraint" to the session check. See the docstring.

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
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS password_changed_at")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS must_change_password")
    op.execute("DROP INDEX IF EXISTS uq_users_email_lower")
    op.execute("ALTER TABLE users ALTER COLUMN email DROP NOT NULL")
