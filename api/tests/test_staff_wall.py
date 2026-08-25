"""The wall between customers and staff-only tooling.

Today's suite proves the INVERSE — test_auth_forced_password_change.py
::test_the_gate_is_role_agnostic_for_company_users shows a customer-role user
reaching an admin route. These tests pin the wall that stops it.
"""

import pytest
from fastapi import HTTPException

from app.models import User
from app.models.roles import ADMIN_ROLES, CUSTOMER_ROLES
from app.services.auth_service import (
    require_account_user,
    require_console_user,
    require_staff,
)


def _user(role, activated_at=None):
    return User(
        username="x",
        email="x@test.example",
        password_hash="x",
        role=role,
        activated_at=activated_at,
    )


def test_customer_role_is_not_an_admin_role():
    assert "user" in CUSTOMER_ROLES
    assert "user" not in ADMIN_ROLES


@pytest.mark.parametrize("role", ["admin", "owner"])
def test_require_staff_admits_staff(role):
    u = _user(role)
    assert require_staff(u) is u


def test_require_staff_refuses_a_customer():
    with pytest.raises(HTTPException) as exc:
        require_staff(_user("user"))
    assert exc.value.status_code == 403
    assert exc.value.detail == "staff_only"


def test_require_account_user_refuses_an_unactivated_customer():
    with pytest.raises(HTTPException) as exc:
        require_account_user(_user("user", activated_at=None))
    assert exc.value.status_code == 403
    assert exc.value.detail == "account_not_activated"


def test_require_account_user_admits_an_activated_customer():
    from datetime import UTC, datetime

    u = _user("user", activated_at=datetime.now(UTC))
    assert require_account_user(u) is u


def test_require_account_user_refuses_staff():
    with pytest.raises(HTTPException):
        require_account_user(_user("admin"))


@pytest.mark.parametrize("role", ["admin", "owner"])
def test_staff_are_never_gated_on_activation(role):
    # activated_at is None for every staff row and must stay irrelevant.
    u = _user(role, activated_at=None)
    assert require_console_user(u) is u


def test_console_admits_an_activated_customer():
    from datetime import UTC, datetime

    u = _user("user", activated_at=datetime.now(UTC))
    assert require_console_user(u) is u


def test_console_refuses_an_unactivated_customer():
    with pytest.raises(HTTPException) as exc:
        require_console_user(_user("user"))
    assert exc.value.detail == "account_not_activated"
