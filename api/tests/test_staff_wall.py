"""The wall between customers and staff-only tooling.

Today's suite proves the INVERSE — test_auth_forced_password_change.py
::test_the_gate_is_role_agnostic_for_company_users shows a customer-role user
reaching an admin route. These tests pin the wall that stops it.
"""

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models import User
from app.models.roles import ADMIN_ROLES, CUSTOMER_ROLES, STAFF_ROLES, VIEWER_ROLES
from app.services.auth_service import (
    READ_ONLY_DETAIL,
    SAFE_METHODS,
    create_token,
    is_staff,
    is_viewer,
    require_account_user,
    require_console_user,
    require_staff,
    require_staff_reader,
)


def _req(method="GET"):
    """The only thing require_staff reads off the request is the verb."""
    return SimpleNamespace(method=method)


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
    assert require_staff(_req(), u) is u


def test_require_staff_refuses_a_customer():
    with pytest.raises(HTTPException) as exc:
        require_staff(_req(), _user("user"))
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


# ── viewer: read-only staff (alembic 051) ───────────────────────────────────


def test_viewer_is_staff_but_not_an_admin_role():
    """Console membership and acting-admin membership are different sets."""
    assert "viewer" in VIEWER_ROLES
    assert "viewer" in STAFF_ROLES
    assert "viewer" not in ADMIN_ROLES
    assert "viewer" not in CUSTOMER_ROLES
    assert is_staff(_user("viewer"))
    assert is_viewer(_user("viewer"))
    assert not is_viewer(_user("admin"))


@pytest.mark.parametrize("method", sorted(SAFE_METHODS))
def test_viewer_passes_the_wall_on_safe_verbs(method):
    u = _user("viewer")
    assert require_staff(_req(method), u) is u


@pytest.mark.parametrize("method", ["POST", "PATCH", "PUT", "DELETE"])
def test_viewer_is_refused_on_every_mutating_verb(method):
    with pytest.raises(HTTPException) as exc:
        require_staff(_req(method), _user("viewer"))
    assert exc.value.status_code == 403
    assert exc.value.detail == READ_ONLY_DETAIL


def test_the_verb_check_is_case_insensitive():
    """Starlette upper-cases methods, but a lowercase verb must not slip a
    write past a read-only account if that ever changes."""
    with pytest.raises(HTTPException):
        require_staff(_req("post"), _user("viewer"))


@pytest.mark.parametrize("role", ["admin", "owner"])
def test_acting_staff_are_never_verb_gated(role):
    u = _user(role)
    assert require_staff(_req("DELETE"), u) is u


def test_the_reader_wall_still_refuses_a_customer():
    """require_staff_reader drops the verb check, NOT the wall."""
    with pytest.raises(HTTPException) as exc:
        require_staff_reader(_user("user"))
    assert exc.value.status_code == 403
    assert exc.value.detail == "staff_only"


def test_viewer_is_never_gated_on_activation():
    u = _user("viewer", activated_at=None)
    assert require_console_user(u) is u


def _viewer_header(db):
    v = User(
        id=uuid.uuid4(),
        username="viewer@test.example",
        email="viewer@test.example",
        password_hash="x",
        role="viewer",
        email_verified_at=datetime.now(UTC),
    )
    db.add(v)
    db.commit()
    return {"Authorization": f"Bearer {create_token(str(v.id), 'viewer')}"}


def test_viewer_can_read_site_analytics_but_not_write(client, db, seeded_db, auth_header):
    """The whole point of the role: the reporting console opens, the
    mutation routes close — and the 403 comes from the wall, not the route
    (the same DELETE as an admin reaches the handler and 404s)."""
    viewer = _viewer_header(db)
    assert client.get("/api/dashboard/analytics", headers=viewer).status_code == 200
    assert client.get("/api/admin/expenses/", headers=viewer).status_code == 200

    missing = "/api/admin/expenses/00000000-0000-0000-0000-000000000000"
    refused = client.delete(missing, headers=viewer)
    assert refused.status_code == 403
    assert refused.json()["detail"] == READ_ONLY_DETAIL
    assert client.delete(missing, headers=auth_header()).status_code == 404


def test_viewer_may_send_the_presence_heartbeat(client, db, seeded_db):
    viewer = _viewer_header(db)
    assert client.post("/api/admin/presence/ping", headers=viewer).status_code == 200


def test_viewer_is_refused_the_lead_roster_on_reads(client, db, seeded_db):
    """The CRM holds real people's personal phones (internal-only by the
    owner's phone rule); a viewer is outside the company. Both doors."""
    from app.routes.admin_leads import NO_LEADS_ACCESS_DETAIL

    viewer = _viewer_header(db)
    for path in ("/api/admin/leads/", "/api/dashboard/leads/recent"):
        resp = client.get(path, headers=viewer)
        assert resp.status_code == 403, path
        assert resp.json()["detail"] == NO_LEADS_ACCESS_DETAIL, path
