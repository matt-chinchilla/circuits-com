"""Forced password change + server-side enforcement (Task 4, P1 auth overhaul).

Four contracts live here:

1. **The 403 gate is the real enforcement.** ``get_current_user`` — which every
   admin route already depends on — returns 403 ``password_change_required``
   whenever ``must_change_password`` is set. The admin screen is only its front
   end; deleting the screen would not open the console.
2. **Exactly three endpoints are exempt**: ``/auth/change-password`` (the way
   out), ``/auth/me`` (how the client learns to show the screen) and
   ``/auth/logout`` (which takes no auth at all).
3. **``POST /auth/change-password``** verifies the current password, enforces
   the password policy (422 listing the unmet rule keys), refuses a no-op
   rotation, stamps ``password_changed_at``, clears the flag, and hands back a
   FRESH token — without which the caller would log itself out by succeeding.
4. **The demo account is retired** (alembic 044). The
   username fallback it replaced is GONE — email is the only login key, for
   every account including demo.
"""

from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
import pytest

from app.config import settings
from app.models import User
from app.services import auth_service as svc

ADMIN_EMAIL = "admin@test.example"
ADMIN_PASSWORD = "testpass123"
# Satisfies all four rules: 8-24 chars, uppercase, digit, symbol.
GOOD_PASSWORD = "Newpass99!"

# A representative admin route (list sponsors) and a second one from a
# different router — the gate must cover the routers, not one endpoint.
ADMIN_ROUTE = "/api/admin/sponsors/"
OTHER_ADMIN_ROUTE = "/api/dashboard/stats"


def _login(client, email=ADMIN_EMAIL, password=ADMIN_PASSWORD, **extra):
    return client.post("/api/auth/login", json={"email": email, "password": password, **extra})


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


def _me(client, token):
    return client.get("/api/auth/me", headers=_bearer(token))


def _change(client, token, current=ADMIN_PASSWORD, new=GOOD_PASSWORD):
    return client.post(
        "/api/auth/change-password",
        json={"current_password": current, "new_password": new},
        headers=_bearer(token),
    )


def _seed_demo(db, password="demo", email="demo@circuitcenter.ai"):
    user = User(
        username="demo",
        password_hash=bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
        role="admin",
        email=email,
    )
    db.add(user)
    db.commit()
    return user


class TestForcedChangeGate:
    """403 password_change_required — the enforcement the UI merely fronts."""

    def test_flagged_user_is_blocked_from_an_admin_route(self, client, db, seeded_db):
        token = _login(client).json()["token"]
        assert client.get(ADMIN_ROUTE, headers=_bearer(token)).status_code == 200

        seeded_db["admin_user"].must_change_password = True
        db.commit()

        resp = client.get(ADMIN_ROUTE, headers=_bearer(token))
        assert resp.status_code == 403
        assert resp.json()["detail"] == "password_change_required"

    def test_the_gate_is_not_one_route_deep(self, client, db, seeded_db):
        # Different router, same gate — because both depend on get_current_user.
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        token = _login(client).json()["token"]
        assert client.get(OTHER_ADMIN_ROUTE, headers=_bearer(token)).status_code == 403

    def test_flagged_user_can_still_read_me(self, client, db, seeded_db):
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        token = _login(client).json()["token"]
        resp = _me(client, token)
        assert resp.status_code == 200
        assert resp.json()["must_change_password"] is True

    def test_flagged_user_can_still_log_out(self, client, db, seeded_db):
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        assert client.post("/api/auth/logout").status_code == 200

    def test_flagged_user_can_still_change_password(self, client, db, seeded_db):
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        token = _login(client).json()["token"]
        assert _change(client, token).status_code == 200

    def test_route_opens_again_after_a_successful_change(self, client, db, seeded_db):
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        token = _login(client).json()["token"]
        assert client.get(ADMIN_ROUTE, headers=_bearer(token)).status_code == 403

        fresh = _change(client, token).json()["token"]
        assert client.get(ADMIN_ROUTE, headers=_bearer(fresh)).status_code == 200

    def test_unflagged_user_is_untouched(self, client, seeded_db):
        token = _login(client).json()["token"]
        assert client.get(ADMIN_ROUTE, headers=_bearer(token)).status_code == 200

    def test_the_gate_is_role_agnostic_for_company_users(self, client, db, seeded_db):
        user = db.query(User).filter(User.username == "kennedy_user").first()
        user.must_change_password = True
        db.commit()
        token = _login(client, email="kennedy_user@test.example").json()["token"]
        resp = client.get(ADMIN_ROUTE, headers=_bearer(token))
        assert resp.status_code == 403
        assert resp.json()["detail"] == "password_change_required"

    def test_owner_role_is_gated_when_flagged(self, client, db, seeded_db):
        seeded_db["admin_user"].role = "owner"
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        assert (
            client.get(ADMIN_ROUTE, headers=_bearer(_login(client).json()["token"])).status_code
            == 403
        )

    def test_owner_role_is_not_locked_out_when_unflagged(self, client, db, seeded_db):
        # A gate written as role == "admin" would 403 the owner forever. The
        # gate checks must_change_password ONLY.
        seeded_db["admin_user"].role = "owner"
        db.commit()
        token = _login(client).json()["token"]
        assert client.get(ADMIN_ROUTE, headers=_bearer(token)).status_code == 200

    def test_gate_does_not_replace_authentication(self, client, seeded_db):
        # No token is still 401, not 403 — the gate runs after auth.
        assert client.get(ADMIN_ROUTE).status_code == 401

    def test_detail_constant_is_the_wire_string(self):
        # The admin client keys its redirect off this exact literal.
        assert svc.PASSWORD_CHANGE_REQUIRED_DETAIL == "password_change_required"


class TestChangePassword:
    def test_happy_path_clears_the_flag_and_stamps_the_change(self, client, db, seeded_db):
        user = seeded_db["admin_user"]
        user.must_change_password = True
        db.commit()
        token = _login(client).json()["token"]

        resp = _change(client, token)
        assert resp.status_code == 200
        body = resp.json()
        assert body["must_change_password"] is False
        assert body["user"]["username"] == "admin"
        assert body["token"]

        db.refresh(user)
        assert user.must_change_password is False
        assert user.password_changed_at is not None

    def test_the_returned_token_authenticates_immediately(self, client, db, seeded_db):
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        fresh = _change(client, _login(client).json()["token"]).json()["token"]
        # Both an exempt route and a gated one — the new token must clear both.
        assert _me(client, fresh).status_code == 200
        assert client.get(ADMIN_ROUTE, headers=_bearer(fresh)).status_code == 200

    def test_the_new_password_works_on_login(self, client, seeded_db):
        _change(client, _login(client).json()["token"])
        assert _login(client, password=GOOD_PASSWORD).status_code == 200
        assert _login(client, password=ADMIN_PASSWORD).status_code == 401

    def test_other_sessions_die(self, client, db, seeded_db):
        user = seeded_db["admin_user"]
        # A session opened an hour ago on another device.
        stale = jwt.encode(
            {
                "sub": str(user.id),
                "role": user.role,
                "exp": datetime.now(UTC) + timedelta(hours=1),
                "iat": datetime.now(UTC) - timedelta(hours=1),
            },
            settings.ADMIN_SECRET_KEY,
            algorithm="HS256",
        )
        assert _me(client, stale).status_code == 200

        _change(client, _login(client).json()["token"])

        resp = _me(client, stale)
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Session expired"

    def test_wrong_current_password_is_rejected(self, client, db, seeded_db):
        token = _login(client).json()["token"]
        resp = _change(client, token, current="not-my-password")
        assert resp.status_code == 400
        assert "current password" in resp.json()["detail"].lower()
        # ...and nothing moved.
        db.refresh(seeded_db["admin_user"])
        assert seeded_db["admin_user"].password_changed_at is None
        assert _login(client).status_code == 200

    def test_wrong_current_password_does_not_clear_the_flag(self, client, db, seeded_db):
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        token = _login(client).json()["token"]
        assert _change(client, token, current="nope").status_code == 400
        db.refresh(seeded_db["admin_user"])
        assert seeded_db["admin_user"].must_change_password is True

    @pytest.mark.parametrize(
        "new_password,unmet",
        [
            ("Ab1!", ["length"]),
            ("A" + "b1!" * 8, ["length"]),  # 25 chars — over the max
            ("newpass99!", ["uppercase"]),
            ("Newpassword!", ["digit"]),
            ("Newpass999", ["symbol"]),
            ("abcdefgh", ["uppercase", "digit", "symbol"]),
            ("abc", ["length", "uppercase", "digit", "symbol"]),
        ],
    )
    def test_policy_violations_return_422_with_the_unmet_keys(
        self, client, seeded_db, new_password, unmet
    ):
        resp = _change(client, _login(client).json()["token"], new=new_password)
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert detail["code"] == "password_policy"
        assert detail["unmet"] == unmet
        assert detail["message"]

    def test_policy_violation_leaves_the_password_alone(self, client, db, seeded_db):
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        assert _change(client, _login(client).json()["token"], new="weak").status_code == 422
        db.refresh(seeded_db["admin_user"])
        assert seeded_db["admin_user"].must_change_password is True
        assert _login(client).status_code == 200

    def test_reusing_the_current_password_is_rejected(self, client, db, seeded_db):
        # Give the account a policy-valid password first, so the reuse attempt
        # reaches the equality check instead of failing the policy.
        token = _change(client, _login(client).json()["token"]).json()["token"]
        resp = _change(client, token, current=GOOD_PASSWORD, new=GOOD_PASSWORD)
        assert resp.status_code == 400
        assert "different" in resp.json()["detail"].lower()

    def test_reuse_rejection_does_not_clear_a_forced_flag(self, client, db, seeded_db):
        user = seeded_db["admin_user"]
        user.password_hash = svc.hash_password(GOOD_PASSWORD)
        user.must_change_password = True
        db.commit()
        token = _login(client, password=GOOD_PASSWORD).json()["token"]
        assert _change(client, token, current=GOOD_PASSWORD, new=GOOD_PASSWORD).status_code == 400
        db.refresh(user)
        assert user.must_change_password is True

    def test_requires_authentication(self, client, seeded_db):
        resp = client.post(
            "/api/auth/change-password",
            json={"current_password": ADMIN_PASSWORD, "new_password": GOOD_PASSWORD},
        )
        assert resp.status_code == 401

    def test_missing_fields_are_422(self, client, seeded_db):
        token = _login(client).json()["token"]
        resp = client.post(
            "/api/auth/change-password",
            json={"new_password": GOOD_PASSWORD},
            headers=_bearer(token),
        )
        assert resp.status_code == 422

    def test_a_reset_token_cannot_be_replayed_here(self, client, db, seeded_db):
        # Reset tokens carry purpose="pwreset" and are refused as session bearers.
        user = seeded_db["admin_user"]
        reset = svc.create_reset_token(str(user.id), user.password_hash)
        assert _change(client, reset).status_code == 401


class TestUsernameLoginIsFullyRetired:
    """Email is the ONLY login key — including for demo (owner decision)."""

    def test_demo_username_no_longer_authenticates(self, client, db, seeded_db):
        _seed_demo(db)
        resp = client.post("/api/auth/login", json={"email": "demo", "password": "demo"})
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"


    def test_the_retired_fallback_leaks_nothing(self, client, db, seeded_db):
        _seed_demo(db)
        by_username = client.post("/api/auth/login", json={"email": "demo", "password": "demo"})
        unknown = client.post(
            "/api/auth/login", json={"email": "ghost@test.example", "password": "demo"}
        )
        assert by_username.status_code == unknown.status_code == 401
        assert by_username.json() == unknown.json()
