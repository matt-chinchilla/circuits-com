"""Tests for alembic 022's auth-hardening schema (Task 1, P1 auth overhaul).

Scope: model metadata + ORM-level behavior only — this task adds schema, not
routes/services (later tasks build login/policy/enforcement on top of it).

The migration's truly Postgres-only piece (``ALTER TYPE user_role ADD VALUE``
in its own autocommit block) has no SQLite analogue at all, since the suite
builds tables straight from ``Base.metadata`` via ``create_all``
(tests/conftest.py) and never runs alembic — that piece is covered by
inspecting the migration file itself below, per CLAUDE.md's rule to assert
Postgres-only contracts on metadata rather than DB behavior.

The case-insensitive email uniqueness, however, DOES have a SQLite analogue:
SQLite honors functional/expression unique indexes the same as Postgres, and
``User.__table_args__`` declares the same ``lower(email)`` unique index the
migration creates — so ``create_all`` reproduces it for tests and the
duplicate-email test below exercises real DB behavior, not just structure.

``TestMigrationReplaySafety`` goes one step further and runs ``upgrade()``
itself — twice — against a THROWAWAY Postgres database it creates and drops
(never the dev database: only the host/credentials are borrowed, the database
name is always the throwaway one). It skips when no Postgres is reachable, so
the static guards in ``TestMigrationFile`` stay the everywhere-coverage.
"""

import ast
import os
import re
from pathlib import Path

import bcrypt
import pytest
import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError, OperationalError

from app.models import User

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "022_auth_hardening.py"
)

# Throwaway database for the live-Postgres replay test. Only the host/user of
# the URL below is used — the database name is ALWAYS replaced by this one, so
# the test can never touch a real database. Override the server with
# MIGRATION_TEST_DATABASE_URL (conftest pins DATABASE_URL to SQLite, so that
# variable is useless here).
REPLAY_DB_NAME = "circuits_mig022_replay_test"
DEFAULT_PG_URL = "postgresql://circuits:circuits@localhost:5432/postgres"

# Schema as of migration 021: email still nullable, no owner enum value, no
# must_change_password / password_changed_at columns.
PRE_022_SCHEMA = (
    "CREATE TYPE user_role AS ENUM ('admin', 'company')",
    """
    CREATE TABLE users (
        id uuid PRIMARY KEY,
        username varchar(100) UNIQUE NOT NULL,
        email varchar(255),
        password_hash varchar(200) NOT NULL,
        role user_role NOT NULL DEFAULT 'company',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    )
    """,
)


def _hash(pw: str = "testpass123") -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def _make_user(db, **overrides) -> User:
    defaults = dict(
        username="hardeneduser",
        password_hash=_hash(),
        role="admin",
        email="hardened@test.example",
    )
    defaults.update(overrides)
    user = User(**defaults)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


class TestModelMetadata:
    """`must_change_password` / `password_changed_at` / `email` contracts."""

    def test_new_columns_present(self):
        cols = User.__table__.c
        assert "must_change_password" in cols
        assert "password_changed_at" in cols

    def test_must_change_password_not_nullable(self):
        assert User.__table__.c.must_change_password.nullable is False

    def test_password_changed_at_nullable(self):
        assert User.__table__.c.password_changed_at.nullable is True

    def test_email_not_nullable(self):
        assert User.__table__.c.email.nullable is False

    def test_role_enum_includes_owner(self):
        assert "owner" in User.__table__.c.role.type.enums

    def test_email_lower_unique_index_declared(self):
        names = {ix.name for ix in User.__table__.indexes}
        assert "uq_users_email_lower" in names


class TestMustChangePasswordDefault:
    def test_defaults_false(self, db):
        user = _make_user(db, username="freshuser1", email="fresh1@test.example")
        assert user.must_change_password is False

    def test_can_be_set_true(self, db):
        user = _make_user(
            db,
            username="freshuser2",
            email="fresh2@test.example",
            must_change_password=True,
        )
        assert user.must_change_password is True


class TestPasswordChangedAtDefault:
    def test_defaults_none_on_new_row(self, db):
        user = _make_user(db, username="freshuser3", email="fresh3@test.example")
        assert user.password_changed_at is None


class TestOwnerRole:
    def test_owner_role_accepted(self, db):
        user = _make_user(db, username="owneruser", email="owner@test.example", role="owner")
        assert user.role == "owner"


class TestEmailRequired:
    def test_missing_email_rejected(self, db):
        user = User(username="noemail", password_hash=_hash(), role="admin")
        db.add(user)
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


class TestCaseInsensitiveEmailUniqueness:
    def test_duplicate_email_different_case_rejected(self, db):
        _make_user(db, username="userone", email="Someone@Example.com")

        db.add(
            User(
                username="usertwo",
                password_hash=_hash(),
                role="admin",
                email="someone@example.com",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()

    def test_distinct_emails_allowed(self, db):
        _make_user(db, username="userthree", email="three@test.example")
        # Should not raise.
        _make_user(db, username="userfour", email="four@test.example")


def _migration_source() -> str:
    assert MIGRATION_PATH.exists(), f"migration file not found: {MIGRATION_PATH}"
    return MIGRATION_PATH.read_text()


def _upgrade_ast() -> ast.FunctionDef:
    tree = ast.parse(_migration_source())
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "upgrade":
            return node
    raise AssertionError("migration 022 has no upgrade() function")


def _executed_sql() -> list[str]:
    """Every literal SQL string the migration hands to op.execute()."""
    return [
        node.args[0].value
        for node in ast.walk(_upgrade_ast())
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "execute"
        and node.args
        and isinstance(node.args[0], ast.Constant)
        and isinstance(node.args[0].value, str)
    ]


class TestMigrationFile:
    """Assert the Postgres-only pieces that have no SQLite/create_all
    analogue — see module docstring. These run everywhere; the live-Postgres
    behavior is in TestMigrationReplaySafety below."""

    def test_revision_chain(self):
        text = _migration_source()
        assert re.search(r'revision\s*=\s*"022"', text)
        assert re.search(r'down_revision\s*=\s*"021"', text)

    def test_owner_enum_value_added_inside_the_autocommit_block(self):
        # Structural, not substring: the ALTER TYPE must be a descendant of
        # the `with ... autocommit_block():` node. Outside it, `alembic
        # upgrade head` aborts on api container start and prod never comes up.
        first = _upgrade_ast().body[0]
        assert isinstance(first, ast.With), (
            "the autocommit block must be the FIRST statement of upgrade() — "
            "anything before it is committed while alembic_version is still "
            "unstamped, so a later failure makes the migration un-replayable"
        )
        ctx = first.items[0].context_expr
        assert isinstance(ctx, ast.Call) and ctx.func.attr == "autocommit_block"
        alter = [
            node.args[0].value
            for node in ast.walk(first)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "execute"
            and node.args
            and isinstance(node.args[0], ast.Constant)
        ]
        assert any("ALTER TYPE user_role ADD VALUE" in sql for sql in alter)
        assert any("'owner'" in sql for sql in alter)

    def test_every_ddl_statement_is_replay_safe(self):
        # Rule 2 of the docstring's replay-safety contract: re-running the
        # whole migration must never trip over an object it already created.
        for sql in _executed_sql():
            head = " ".join(sql.split())
            if head.startswith(("CREATE UNIQUE INDEX", "CREATE INDEX", "CREATE TABLE")):
                assert "IF NOT EXISTS" in head, f"not replay-safe: {head}"
            if "ADD COLUMN" in head or "ADD VALUE" in head:
                assert "IF NOT EXISTS" in head, f"not replay-safe: {head}"
        called = {
            node.func.attr
            for node in ast.walk(_upgrade_ast())
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        assert "add_column" not in called, (
            "op.add_column has no IF NOT EXISTS form — use raw ALTER TABLE ... "
            "ADD COLUMN IF NOT EXISTS so a replay is safe"
        )

    def test_email_not_null_guard_present(self):
        # Behavior is covered by the live-Postgres test; this just pins the
        # guard's query so it can't drift to a different emptiness rule.
        text = _migration_source()
        assert "RuntimeError" in text
        assert "email IS NULL OR email = ''" in text

    def test_unique_index_created(self):
        text = _migration_source()
        assert "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower" in text
        assert "lower(email)" in text

    def test_data_backfill_is_scoped_to_the_named_admins(self):
        # A WHERE-less UPDATE would flag EVERY account — including demo, which
        # would trap every "See Demo" prospect on the forced-reset screen.
        flag_stmts = [
            " ".join(sql.split()) for sql in _executed_sql() if "must_change_password = true" in sql
        ]
        assert flag_stmts, "the must_change_password backfill is gone"
        for sql in flag_stmts:
            assert "WHERE lower(username) IN ('anthony', 'daniel', 'ronald', 'matthew')" in sql
        role_stmts = [" ".join(sql.split()) for sql in _executed_sql() if "role = 'owner'" in sql]
        assert role_stmts, "the owner-role backfill is gone"
        for sql in role_stmts:
            assert "WHERE lower(username) = 'matthew'" in sql
        assert "'demo'" not in _migration_source().lower()  # demo must stay untouched

    def test_the_backfill_and_seed_py_agree_on_who_is_flagged(self):
        # Two homes for one contract: 022 catches up already-deployed rows,
        # seed.py holds it for fresh/reseeded databases. Desync = a prod admin
        # and a fresh-dev admin disagreeing about who the owner is.
        from app.db.seed import _FORCED_RESET_USERNAMES, _OWNER_USERNAME

        flagged_sql = " ".join(sql for sql in _executed_sql() if "must_change_password" in sql)
        for username in _FORCED_RESET_USERNAMES:
            assert f"'{username.lower()}'" in flagged_sql, username
        role_sql = " ".join(sql for sql in _executed_sql() if "role = 'owner'" in sql)
        assert f"lower(username) = '{_OWNER_USERNAME.lower()}'" in role_sql

    def test_password_changed_at_is_not_backfilled(self):
        # `= now()` here rejects every token minted before the deploy (task 3's
        # token_predates_password_change), i.e. it logs the whole team out on
        # the deploy that was supposed to leave sessions alone. NULL is the
        # value that means "no constraint".
        for sql in _executed_sql():
            assert not re.search(r"password_changed_at\s*=", sql), (
                f"password_changed_at must be left NULL by this migration: {sql}"
            )


# ---------------------------------------------------------------------------
# Live-Postgres replay test
# ---------------------------------------------------------------------------


def _throwaway_url(database: str):
    raw = os.getenv("MIGRATION_TEST_DATABASE_URL") or DEFAULT_PG_URL
    return make_url(raw).set(database=database)


def _load_migration_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location("alembic_mig_022", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_upgrade(engine) -> None:
    """Execute the migration's upgrade() against `engine`, as alembic would."""
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    with engine.connect() as conn:
        ctx = MigrationContext.configure(connection=conn)
        with Operations.context(ctx):
            _load_migration_module().upgrade()
        conn.commit()


@pytest.fixture(scope="module")
def pg_engine():
    """Engine on a throwaway Postgres database, or skip when none is reachable."""
    admin = sa.create_engine(
        _throwaway_url("postgres"),
        isolation_level="AUTOCOMMIT",
        connect_args={"connect_timeout": 2},
    )
    try:
        with admin.connect() as conn:
            conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{REPLAY_DB_NAME}"'))
            conn.execute(sa.text(f'CREATE DATABASE "{REPLAY_DB_NAME}"'))
    except OperationalError as exc:
        admin.dispose()
        pytest.skip(f"no Postgres for the migration-replay test: {exc}")
    engine = sa.create_engine(_throwaway_url(REPLAY_DB_NAME))
    try:
        yield engine
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{REPLAY_DB_NAME}"'))
        admin.dispose()


@pytest.fixture
def pre_022_db(pg_engine):
    """A fresh pre-022 `users` table with the real account mix on every test."""
    with pg_engine.begin() as conn:
        conn.execute(sa.text("DROP SCHEMA public CASCADE"))
        conn.execute(sa.text("CREATE SCHEMA public"))
        for stmt in PRE_022_SCHEMA:
            conn.execute(sa.text(stmt))
        conn.execute(
            sa.text(
                "INSERT INTO users (id, username, email, password_hash, role) VALUES "
                "(gen_random_uuid(), 'matthew', 'matthew@circuitcenter.ai', 'x', 'admin'), "
                "(gen_random_uuid(), 'Daniel', 'daniel@circuitcenter.ai', 'x', 'admin'), "
                "(gen_random_uuid(), 'demo', 'demo@circuitcenter.ai', 'x', 'admin')"
            )
        )
    return pg_engine


def _users(engine) -> dict:
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text(
                "SELECT username, role::text, must_change_password, password_changed_at FROM users"
            )
        ).fetchall()
    return {row[0]: row for row in rows}


class TestMigrationReplaySafety:
    """Run the real upgrade() against a throwaway Postgres database.

    The failure this guards is site-wide: a mid-migration commit (the
    autocommit block) plus a non-idempotent statement leaves 022 applied but
    unstamped, so the api entrypoint's `alembic upgrade head` crash-loops on
    the next container start and `/api/*` stays 502.
    """

    def test_upgrade_twice_is_safe(self, pre_022_db):
        _run_upgrade(pre_022_db)
        _run_upgrade(pre_022_db)  # replay after an unstamped run — must not raise

        users = _users(pre_022_db)
        assert users["matthew"][1] == "owner"
        assert users["matthew"][2] is True
        assert users["Daniel"][2] is True
        assert users["demo"][1] == "admin"
        assert users["demo"][2] is False

    def test_password_changed_at_is_left_null(self, pre_022_db):
        # Backfilling now() would 401 every session issued before the deploy.
        _run_upgrade(pre_022_db)
        assert all(row[3] is None for row in _users(pre_022_db).values())

    def test_email_becomes_not_null_and_case_insensitively_unique(self, pre_022_db):
        _run_upgrade(pre_022_db)
        with pre_022_db.connect() as conn:
            assert conn.execute(
                sa.text(
                    "SELECT attnotnull FROM pg_attribute "
                    "WHERE attrelid = 'users'::regclass AND attname = 'email'"
                )
            ).scalar()
            indexdef = conn.execute(
                sa.text("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_users_email_lower'")
            ).scalar()
        assert indexdef and "lower(" in indexdef.lower()

        with pytest.raises(sa.exc.IntegrityError):
            with pre_022_db.begin() as conn:
                conn.execute(
                    sa.text(
                        "INSERT INTO users (id, username, email, password_hash, role) VALUES "
                        "(gen_random_uuid(), 'clash', 'MATTHEW@circuitcenter.ai', 'x', 'admin')"
                    )
                )

    def test_a_row_without_an_email_aborts_the_migration(self, pre_022_db):
        with pre_022_db.begin() as conn:
            conn.execute(
                sa.text(
                    "INSERT INTO users (id, username, email, password_hash, role) VALUES "
                    "(gen_random_uuid(), 'noemail', NULL, 'x', 'admin')"
                )
            )
        with pytest.raises(RuntimeError, match="noemail"):
            _run_upgrade(pre_022_db)

    def test_downgrade_then_upgrade_round_trips(self, pre_022_db):
        _run_upgrade(pre_022_db)
        with pre_022_db.connect() as conn:
            from alembic.migration import MigrationContext
            from alembic.operations import Operations

            ctx = MigrationContext.configure(connection=conn)
            with Operations.context(ctx):
                _load_migration_module().downgrade()
            conn.commit()
        _run_upgrade(pre_022_db)
        assert _users(pre_022_db)["matthew"][1] == "owner"
