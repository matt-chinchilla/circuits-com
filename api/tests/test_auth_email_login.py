"""Email-keyed login + session invalidation (Task 3, P1 auth overhaul).

Three contracts live here:

1. **The login identifier is the email address**, matched case-insensitively on
   ``lower(email)`` — the same expression the ``uq_users_email_lower`` unique
   index covers. Usernames no longer authenticate for ANY account.
2. **Sessions die on password change.** ``create_token`` stamps ``iat``;
   ``get_current_user`` rejects a token minted before the user's
   ``password_changed_at`` with 401 "Session expired". NULL means "no
   constraint" — fresh rows have no stamp and must never be logged out.
3. **Anti-enumeration is preserved**: unknown address, wrong password and a
   retired-username attempt all return the identical 401 body.
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


def _login(client, email=ADMIN_EMAIL, password=ADMIN_PASSWORD, **extra):
    return client.post("/api/auth/login", json={"email": email, "password": password, **extra})


def _me(client, token):
    return client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})


def _craft_token(user_id, *, iat, exp_hours=1):
    """A signed session token with an explicit iat (no purpose claim)."""
    payload = {
        "sub": str(user_id),
        "role": "admin",
        "exp": datetime.now(UTC) + timedelta(hours=exp_hours),
        "iat": iat,
    }
    return jwt.encode(payload, settings.ADMIN_SECRET_KEY, algorithm="HS256")


class TestLoginByEmail:
    def test_exact_email_succeeds(self, client, seeded_db):
        resp = _login(client)
        assert resp.status_code == 200
        assert resp.json()["user"]["username"] == "admin"

    @pytest.mark.parametrize(
        "variant",
        ["ADMIN@TEST.EXAMPLE", "Admin@Test.Example", "aDmIn@tEsT.eXaMpLe"],
    )
    def test_mixed_case_email_succeeds(self, client, seeded_db, variant):
        resp = _login(client, email=variant)
        assert resp.status_code == 200, variant
        assert resp.json()["user"]["username"] == "admin"

    def test_surrounding_whitespace_is_tolerated(self, client, seeded_db):
        # Copy/paste from a mail client routinely drags a space along.
        assert _login(client, email="  admin@test.example  ").status_code == 200

    def test_customer_user_logs_in_by_email(self, client, seeded_db):
        resp = _login(client, email="kennedy_user@test.example")
        assert resp.status_code == 200
        data = resp.json()
        assert data["user"]["role"] == "user"
        assert data["user"]["supplier_id"] is not None

    def test_username_no_longer_authenticates(self, client, seeded_db):
        # The whole point of the overhaul: "admin" is not a login key anymore.
        resp = _login(client, email="admin")
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"

    def test_email_field_is_required(self, client, seeded_db):
        resp = client.post("/api/auth/login", json={"password": ADMIN_PASSWORD})
        assert resp.status_code == 422

    def test_legacy_username_body_is_rejected_not_silently_accepted(self, client, seeded_db):
        # A pre-overhaul client posting {"username": ...} must fail loudly (422),
        # never fall through to some username-matching path.
        resp = client.post(
            "/api/auth/login", json={"username": "admin", "password": ADMIN_PASSWORD}
        )
        assert resp.status_code == 422

    def test_remember_still_extends_the_ttl(self, client, seeded_db):
        token = _login(client, remember=True).json()["token"]
        payload = jwt.decode(token, settings.ADMIN_SECRET_KEY, algorithms=["HS256"])
        delta = payload["exp"] - payload["iat"]
        assert abs(delta - svc.REMEMBER_EXPIRY_HOURS * 3600) <= 5


class TestLoginAntiEnumeration:
    def test_wrong_password_and_unknown_email_are_indistinguishable(self, client, seeded_db):
        wrong_pw = _login(client, password="nope")
        unknown = _login(client, email="ghost@test.example")
        assert wrong_pw.status_code == unknown.status_code == 401
        assert wrong_pw.json() == unknown.json() == {"detail": "Invalid credentials"}

    def test_retired_username_attempt_looks_like_any_other_miss(self, client, seeded_db):
        # "admin" exists as a username; the 401 must not differ from a total miss.
        by_username = _login(client, email="admin")
        unknown = _login(client, email="ghost@test.example")
        assert by_username.json() == unknown.json()

    def test_unknown_email_still_burns_the_bcrypt_equalizer(self, client, seeded_db, monkeypatch):
        calls = {"n": 0}
        monkeypatch.setattr(
            "app.routes.auth.verify_dummy_password",
            lambda: calls.__setitem__("n", calls["n"] + 1),
        )
        assert _login(client, email="ghost@test.example").status_code == 401
        assert calls["n"] == 1

    def test_blank_email_burns_the_equalizer_too(self, client, seeded_db, monkeypatch):
        # The empty-identifier short circuit must not skip the timing equalizer.
        calls = {"n": 0}
        monkeypatch.setattr(
            "app.routes.auth.verify_dummy_password",
            lambda: calls.__setitem__("n", calls["n"] + 1),
        )
        resp = _login(client, email="   ")
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"
        assert calls["n"] == 1

    def test_known_email_wrong_password_skips_the_equalizer(self, client, seeded_db, monkeypatch):
        calls = {"n": 0}
        monkeypatch.setattr(
            "app.routes.auth.verify_dummy_password",
            lambda: calls.__setitem__("n", calls["n"] + 1),
        )
        assert _login(client, password="nope").status_code == 401
        assert calls["n"] == 0


class TestMustChangePasswordFlag:
    def test_login_response_carries_the_flag_false_by_default(self, client, seeded_db):
        assert _login(client).json()["must_change_password"] is False

    def test_login_response_carries_the_flag_when_set(self, client, db, seeded_db):
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        assert _login(client).json()["must_change_password"] is True

    def test_me_reports_the_flag_and_the_role(self, client, db, seeded_db):
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        token = _login(client).json()["token"]
        body = _me(client, token).json()
        assert body["must_change_password"] is True
        assert body["role"] == "admin"
        assert body["username"] == "admin"

    def test_me_reports_false_for_an_unflagged_user(self, client, seeded_db):
        token = _login(client).json()["token"]
        assert _me(client, token).json()["must_change_password"] is False

    def test_owner_role_surfaces_verbatim(self, client, db, seeded_db):
        # matthew is `owner` after migration 022 — auth must not flatten the
        # role to "admin" anywhere in the login/me payloads.
        seeded_db["admin_user"].role = "owner"
        db.commit()
        login = _login(client)
        assert login.json()["user"]["role"] == "owner"
        assert _me(client, login.json()["token"]).json()["role"] == "owner"


class TestSessionInvalidation:
    def test_token_minted_before_a_password_change_is_rejected(self, client, db, seeded_db):
        user = seeded_db["admin_user"]
        stale = _craft_token(user.id, iat=datetime.now(UTC) - timedelta(hours=1))
        assert _me(client, stale).status_code == 200  # no stamp yet → still valid

        user.password_changed_at = datetime.now(UTC)
        db.commit()

        resp = _me(client, stale)
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Session expired"

    def test_token_minted_after_the_change_is_accepted(self, client, db, seeded_db):
        seeded_db["admin_user"].password_changed_at = datetime.now(UTC) - timedelta(hours=1)
        db.commit()
        token = _login(client).json()["token"]
        assert _me(client, token).status_code == 200

    def test_null_password_changed_at_never_invalidates(self, client, db, seeded_db):
        # Fresh rows carry no stamp (migration 022 backfilled only pre-existing
        # users) — a NULL must read as "no constraint", not "changed at epoch".
        assert seeded_db["admin_user"].password_changed_at is None
        very_old = _craft_token(
            seeded_db["admin_user"].id, iat=datetime.now(UTC) - timedelta(days=365)
        )
        assert _me(client, very_old).status_code == 200

    def test_same_second_token_survives_the_grace_window(self, client, db, seeded_db):
        # The realistic case: a password change stamps microseconds while the
        # token it hands back carries a second-truncated iat. Without the 1s
        # grace, that fresh token would invalidate itself.
        user = seeded_db["admin_user"]
        token = svc.create_token(str(user.id), user.role)
        user.password_changed_at = datetime.now(UTC)
        db.commit()
        assert _me(client, token).status_code == 200

    def test_reset_password_kills_pre_reset_sessions(self, client, db, seeded_db):
        user = seeded_db["admin_user"]
        # A session opened an hour ago (crafted iat — a token minted in the same
        # second as the reset is intentionally spared by the 1s grace window).
        token = _craft_token(user.id, iat=datetime.now(UTC) - timedelta(hours=1))
        assert _me(client, token).status_code == 200

        reset = svc.create_reset_token(str(user.id), user.password_hash)
        assert (
            client.post(
                "/api/auth/reset-password",
                json={"token": reset, "new_password": "Newpass99!"},
            ).status_code
            == 200
        )
        assert user.password_changed_at is not None

        resp = _me(client, token)
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Session expired"
        # ...and the new credential works, minting a token that survives.
        fresh = _login(client, password="Newpass99!")
        assert fresh.status_code == 200
        assert _me(client, fresh.json()["token"]).status_code == 200

    def test_reset_password_clears_the_forced_change_flag(self, client, db, seeded_db):
        # The route now enforces the SAME policy /change-password does, so a
        # completed reset IS the rotation the flag demands — and it is the only
        # exit for an admin whose password was rotated out from under them
        # (no current_password to give /change-password). A weak password is
        # rejected outright, so this can't satisfy a rotation cheaply; see
        # test_auth_recovery.TestResetPasswordClearsTheForcedChangeFlag.
        user = seeded_db["admin_user"]
        user.must_change_password = True
        db.commit()
        reset = svc.create_reset_token(str(user.id), user.password_hash)
        resp = client.post(
            "/api/auth/reset-password", json={"token": reset, "new_password": "Newpass99!"}
        )
        assert resp.status_code == 200
        db.refresh(user)
        assert user.must_change_password is False


class TestTokenPredatesPasswordChange:
    """Unit tests for the comparison helper (no DB, no HTTP)."""

    def _payload(self, dt):
        return {"iat": int(dt.timestamp())}

    def test_null_stamp_means_no_constraint(self):
        old = self._payload(datetime.now(UTC) - timedelta(days=100))
        assert svc.token_predates_password_change(old, None) is False

    def test_older_token_is_stale(self):
        changed = datetime.now(UTC)
        old = self._payload(changed - timedelta(hours=1))
        assert svc.token_predates_password_change(old, changed) is True

    def test_newer_token_is_fresh(self):
        changed = datetime.now(UTC) - timedelta(hours=1)
        new = self._payload(datetime.now(UTC))
        assert svc.token_predates_password_change(new, changed) is False

    def test_naive_stamp_is_treated_as_utc(self):
        # SQLite hands back naive datetimes for DateTime(timezone=True); an
        # aware/naive comparison would raise TypeError instead of answering.
        changed_naive = datetime.now(UTC).replace(tzinfo=None)
        old = self._payload(datetime.now(UTC) - timedelta(hours=1))
        assert svc.token_predates_password_change(old, changed_naive) is True
        new = self._payload(datetime.now(UTC) + timedelta(hours=1))
        assert svc.token_predates_password_change(new, changed_naive) is False

    def test_within_grace_is_fresh(self):
        changed = datetime.now(UTC)
        # Truncated to the same second → a fraction "older" than the stamp.
        same_second = {"iat": int(changed.timestamp())}
        assert svc.token_predates_password_change(same_second, changed) is False

    def test_grace_is_exactly_one_second(self):
        assert svc.SESSION_IAT_GRACE_SECONDS == 1
        changed = datetime.now(UTC)
        just_outside = {"iat": (changed - timedelta(seconds=2)).timestamp()}
        assert svc.token_predates_password_change(just_outside, changed) is True

    def test_missing_iat_cannot_prove_freshness(self):
        assert svc.token_predates_password_change({}, datetime.now(UTC)) is True

    @pytest.mark.parametrize("bad", ["not-a-number", None, {}, [1]])
    def test_unparseable_iat_loses(self, bad):
        payload = {"iat": bad} if bad is not None else {}
        assert svc.token_predates_password_change(payload, datetime.now(UTC)) is True

    def test_missing_iat_with_no_stamp_is_still_fine(self):
        # NULL wins over everything: no stamp, no constraint.
        assert svc.token_predates_password_change({}, None) is False


