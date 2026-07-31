"""Regression guard for alembic 015 (+ 022): users.email column.

Account recovery (forgot-password / forgot-username) needs an address to mail,
and (alembic 022, 2026-07-31) email became the case-insensitive login
identifier — every row must carry one, and duplicates (differing only by
case) are rejected via a functional unique index. It's indexed for the
lookup in the recovery routes.

SQLite (the test engine) ignores ``String(N)`` length, but the SQLAlchemy
column metadata is dialect-agnostic and pins the schema regardless of
engine — same approach as the icon-length guard in test_categories.py and
the hot-column index guard in test_part_indexes.py. The NOT NULL + unique
constraints, unlike length, ARE genuinely enforced under SQLite too — see
tests/test_auth_hardening.py for behavioral (not just metadata) coverage.
"""

from app.models.user import User


def test_user_has_email_column():
    """User model exposes an `email` column."""
    assert "email" in User.__table__.c, (
        "User.email is missing — add `email = Column(String(255), nullable=False, "
        "index=True)` to api/app/models/user.py and CREATE it in alembic 015."
    )


def test_user_email_is_not_nullable():
    """email is required (alembic 022 — was nullable pre-2026-07-31; every
    live row already carries an address and email is now the login key)."""
    assert User.__table__.c.email.nullable is False


def test_user_email_length_holds_an_address():
    """email column is wide enough for a real address (>=255)."""
    length = User.__table__.c.email.type.length
    assert length is not None and length >= 255, (
        f"User.email length must be >=255 (got {length!r})."
    )


def test_user_email_is_indexed():
    """email carries index=True for the recovery-route lookup."""
    assert User.__table__.c.email.index is True
