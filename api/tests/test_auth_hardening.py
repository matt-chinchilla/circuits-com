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
"""

import re
from pathlib import Path

import bcrypt
import pytest
from sqlalchemy.exc import IntegrityError

from app.models import User

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "022_auth_hardening.py"
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


class TestMigrationFile:
    """Assert the Postgres-only pieces that have no SQLite/create_all
    analogue — see module docstring."""

    def _read(self) -> str:
        assert MIGRATION_PATH.exists(), f"migration file not found: {MIGRATION_PATH}"
        return MIGRATION_PATH.read_text()

    def test_revision_chain(self):
        text = self._read()
        assert re.search(r'revision\s*=\s*"022"', text)
        assert re.search(r'down_revision\s*=\s*"021"', text)

    def test_owner_enum_value_added_in_autocommit_block(self):
        text = self._read()
        assert "autocommit_block" in text
        assert "ALTER TYPE user_role ADD VALUE" in text
        assert "'owner'" in text

    def test_email_not_null_guard_present(self):
        text = self._read()
        assert "RuntimeError" in text
        assert "email" in text.lower()

    def test_unique_index_created(self):
        text = self._read()
        assert "CREATE UNIQUE INDEX uq_users_email_lower" in text
        assert "lower(email)" in text

    def test_data_backfill_present(self):
        text = self._read()
        assert "must_change_password = true" in text
        assert "role = 'owner'" in text
        assert "'anthony'" in text.lower()
        assert "'demo'" not in text.lower()  # demo must stay untouched
