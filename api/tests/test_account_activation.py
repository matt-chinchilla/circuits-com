"""Activation is the whole authorization boundary in Project 1 (D17).

Because it is one condition rather than forty WHERE clauses, a test that
passes without it is measuring nothing — hence the mutation check in the
step below, which is part of this task, not a nicety.
"""

from datetime import UTC, datetime

import pytest
from fastapi import HTTPException

from app.models import User
from app.services.auth_service import require_account_user, require_console_user


def _customer(activated_at=None):
    return User(
        username="c@test.example",
        email="c@test.example",
        password_hash="x",
        role="user",
        activated_at=activated_at,
    )


def test_unactivated_is_refused_by_both_customer_gates():
    for gate in (require_account_user, require_console_user):
        with pytest.raises(HTTPException) as exc:
            gate(_customer())
        assert exc.value.detail == "account_not_activated"


def test_activation_admits():
    u = _customer(activated_at=datetime.now(UTC))
    assert require_account_user(u) is u
    assert require_console_user(u) is u


def test_activation_is_a_stamp_not_a_boolean():
    # The column records WHEN, so /admin/users can show how long someone
    # waited. A bool would have thrown that away.
    u = _customer(activated_at=datetime.now(UTC))
    assert isinstance(u.activated_at, datetime)
