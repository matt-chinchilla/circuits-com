"""Regression guard for alembic 015: users.email column.

Account recovery (forgot-password / forgot-username) needs an address to mail.
The column is nullable (legacy admin rows + the demo user need no hard value)
and indexed for the case-insensitive lookup in the recovery routes.

SQLite (the test engine) ignores ``String(N)`` length AND index *performance*,
but the SQLAlchemy column metadata is dialect-agnostic and pins the schema
regardless of engine — same approach as the icon-length guard in
test_categories.py and the hot-column index guard in test_part_indexes.py.
"""

from app.models.user import User


def test_user_has_email_column():
    """User model exposes an `email` column."""
    assert "email" in User.__table__.c, (
        "User.email is missing — add `email = Column(String(255), nullable=True, "
        "index=True)` to api/app/models/user.py and CREATE it in alembic 015."
    )


def test_user_email_is_nullable():
    """email is nullable — legacy admin rows and the demo user may omit it."""
    assert User.__table__.c.email.nullable is True


def test_user_email_length_holds_an_address():
    """email column is wide enough for a real address (>=255)."""
    length = User.__table__.c.email.type.length
    assert length is not None and length >= 255, (
        f"User.email length must be >=255 (got {length!r})."
    )


def test_user_email_is_indexed():
    """email carries index=True for the recovery-route lookup."""
    assert User.__table__.c.email.index is True
