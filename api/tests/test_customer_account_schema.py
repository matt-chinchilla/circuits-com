"""The 043 schema, asserted on metadata.

SQLite ignores VARCHAR lengths, so length contracts are asserted on the
column type rather than by inserting an over-long value.
"""
from app.models import Message, User


def test_role_enum_has_user_not_company():
    values = set(User.__table__.c.role.type.enums)
    assert values == {"admin", "user", "owner"}
    assert User.__table__.c.role.default.arg == "user"


def test_username_is_wide_enough_for_an_email():
    # username = lower(email) for customers; email is String(255).
    assert User.__table__.c.username.type.length >= 255
    assert User.__table__.c.username.nullable is False


def test_new_user_columns_exist_and_are_nullable():
    cols = User.__table__.c
    for name in (
        "first_name",
        "last_name",
        "email_verified_at",
        "activated_at",
        "signup_ip",
        "signup_country",
        "manufacturer_id",
    ):
        assert name in cols, f"missing column {name}"
        assert cols[name].nullable is True, f"{name} must be nullable"


def test_verified_and_activated_are_distinct_columns():
    # D17: proving mailbox control is not the same as staff approval.
    assert "email_verified_at" in User.__table__.c
    assert "activated_at" in User.__table__.c


def test_messages_carry_an_optional_owner():
    col = Message.__table__.c.user_id
    assert col.nullable is True  # NULL = the shared staff inbox
    assert [fk.column.table.name for fk in col.foreign_keys] == ["users"]
