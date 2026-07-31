"""Tests for account recovery routes + the 30-day remember-me TTL.

The seeded admin user (conftest) is username "admin" / email
"admin@test.example" / password "testpass123"; recovery tests that need a
different address set one in-test (the route's db is the same session as the
`db` fixture via the client override). Login itself is keyed on the email
address (P1 auth overhaul) — see test_auth_email_login.py.
"""

import jwt

from app.config import settings
from app.services import auth_service as svc


def _exp_window(token: str) -> int:
    p = jwt.decode(token, settings.ADMIN_SECRET_KEY, algorithms=["HS256"])
    return p["exp"] - p["iat"]


class TestRememberMe:
    def test_remember_true_issues_long_token(self, client, seeded_db):
        resp = client.post(
            "/api/auth/login",
            json={"email": "admin@test.example", "password": "testpass123", "remember": True},
        )
        assert resp.status_code == 200
        # 30 days, well beyond the 24h default
        assert _exp_window(resp.json()["token"]) > svc.TOKEN_EXPIRY_HOURS * 3600 * 2
        assert abs(_exp_window(resp.json()["token"]) - svc.REMEMBER_EXPIRY_HOURS * 3600) <= 5

    def test_remember_false_issues_24h_token(self, client, seeded_db):
        resp = client.post(
            "/api/auth/login",
            json={"email": "admin@test.example", "password": "testpass123", "remember": False},
        )
        assert abs(_exp_window(resp.json()["token"]) - svc.TOKEN_EXPIRY_HOURS * 3600) <= 5

    def test_remember_defaults_to_false(self, client, seeded_db):
        resp = client.post(
            "/api/auth/login", json={"email": "admin@test.example", "password": "testpass123"}
        )
        assert resp.status_code == 200
        assert abs(_exp_window(resp.json()["token"]) - svc.TOKEN_EXPIRY_HOURS * 3600) <= 5


class TestForgotPassword:
    def test_known_username_returns_generic_ok(self, client, db, seeded_db):
        seeded_db["admin_user"].email = "admin@example.com"
        db.commit()
        resp = client.post("/api/auth/forgot-password", json={"identifier": "admin"})
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}

    def test_known_email_returns_generic_ok(self, client, db, seeded_db):
        seeded_db["admin_user"].email = "admin@example.com"
        db.commit()
        resp = client.post(
            "/api/auth/forgot-password", json={"identifier": "ADMIN@example.com"}
        )
        assert resp.status_code == 200

    def test_unknown_identifier_returns_generic_ok(self, client, seeded_db):
        # Anti-enumeration: an unknown identifier is indistinguishable from a hit.
        resp = client.post("/api/auth/forgot-password", json={"identifier": "ghost"})
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}

    def test_blank_identifier_still_ok(self, client, seeded_db):
        resp = client.post("/api/auth/forgot-password", json={"identifier": "   "})
        assert resp.status_code == 200

    def test_reset_link_ignores_spoofed_host_header(self, client, db, seeded_db, monkeypatch):
        # Password-reset poisoning guard: the emailed link must use the trusted
        # APP_BASE_URL, never the attacker-controllable Host / X-Forwarded-Host.
        seeded_db["admin_user"].email = "admin@example.com"
        db.commit()
        captured = {}

        async def _capture(to_email, username, reset_url):
            captured["url"] = reset_url

        monkeypatch.setattr(
            "app.routes.auth.email_service.send_password_reset", _capture
        )
        resp = client.post(
            "/api/auth/forgot-password",
            json={"identifier": "admin"},
            headers={"Host": "evil.example.com", "X-Forwarded-Host": "evil.example.com"},
        )
        assert resp.status_code == 200
        # TestClient runs the BackgroundTask before returning → url is captured.
        assert "evil.example.com" not in captured["url"]
        assert captured["url"].startswith(
            settings.APP_BASE_URL.rstrip("/") + "/admin/reset-password?token="
        )


class TestResetPassword:
    def _reset_token(self, user):
        return svc.create_reset_token(str(user.id), user.password_hash)

    def test_valid_token_changes_password(self, client, db, seeded_db):
        token = self._reset_token(seeded_db["admin_user"])
        resp = client.post(
            "/api/auth/reset-password",
            json={"token": token, "new_password": "newpass99"},
        )
        assert resp.status_code == 200
        assert (
            client.post(
                "/api/auth/login", json={"email": "admin@test.example", "password": "newpass99"}
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/auth/login", json={"email": "admin@test.example", "password": "testpass123"}
            ).status_code
            == 401
        )

    def test_token_is_single_use(self, client, db, seeded_db):
        token = self._reset_token(seeded_db["admin_user"])
        first = client.post(
            "/api/auth/reset-password", json={"token": token, "new_password": "newpass99"}
        )
        assert first.status_code == 200
        # Reuse → fingerprint no longer matches the (changed) hash → 400.
        second = client.post(
            "/api/auth/reset-password", json={"token": token, "new_password": "another88"}
        )
        assert second.status_code == 400

    def test_short_password_rejected(self, client, db, seeded_db):
        token = self._reset_token(seeded_db["admin_user"])
        resp = client.post(
            "/api/auth/reset-password", json={"token": token, "new_password": "short"}
        )
        assert resp.status_code == 422

    def test_garbage_token_rejected(self, client, seeded_db):
        resp = client.post(
            "/api/auth/reset-password", json={"token": "not-a-jwt", "new_password": "newpass99"}
        )
        assert resp.status_code == 400

    def test_session_token_not_accepted_as_reset(self, client, db, seeded_db):
        session = svc.create_token(str(seeded_db["admin_user"].id), "admin")
        resp = client.post(
            "/api/auth/reset-password", json={"token": session, "new_password": "newpass99"}
        )
        assert resp.status_code == 400


class TestResetTokenNotABearer:
    def test_reset_token_rejected_by_me(self, client, seeded_db):
        user = seeded_db["admin_user"]
        reset = svc.create_reset_token(str(user.id), user.password_hash)
        resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {reset}"})
        assert resp.status_code == 401


class TestLoginEnumeration:
    def test_unknown_user_still_runs_bcrypt_equalizer(self, client, seeded_db, monkeypatch):
        # Guards the login timing oracle: the user-not-found path must still pay
        # the bcrypt cost (via verify_dummy_password) so latency can't reveal
        # which usernames exist.
        calls = {"n": 0}
        monkeypatch.setattr(
            "app.routes.auth.verify_dummy_password", lambda: calls.__setitem__("n", calls["n"] + 1)
        )
        resp = client.post(
            "/api/auth/login", json={"email": "ghost-user@test.example", "password": "whatever"}
        )
        assert resp.status_code == 401
        assert calls["n"] == 1

    def test_known_user_wrong_password_skips_equalizer(self, client, seeded_db, monkeypatch):
        # The found-user path already pays bcrypt via verify_password, so it must
        # NOT also call the equalizer (that would itself create a timing gap).
        calls = {"n": 0}
        monkeypatch.setattr(
            "app.routes.auth.verify_dummy_password", lambda: calls.__setitem__("n", calls["n"] + 1)
        )
        resp = client.post(
            "/api/auth/login", json={"email": "admin@test.example", "password": "wrongpass"}
        )
        assert resp.status_code == 401
        assert calls["n"] == 0


class TestForgotUsernameRetired:
    """Username recovery is retired: the username IS the email address now, so
    the route answers 410 Gone for every caller — a known address and an
    unknown one are still indistinguishable (anti-enumeration holds)."""

    def test_known_email_returns_410(self, client, db, seeded_db):
        seeded_db["admin_user"].email = "admin@example.com"
        db.commit()
        resp = client.post(
            "/api/auth/forgot-username", json={"email": "admin@example.com"}
        )
        assert resp.status_code == 410

    def test_unknown_email_returns_the_same_410(self, client, seeded_db):
        resp = client.post(
            "/api/auth/forgot-username", json={"email": "nobody@example.com"}
        )
        assert resp.status_code == 410

    def test_bodyless_call_still_410_not_422(self, client, seeded_db):
        # A pre-overhaul client posting anything at all gets the same answer;
        # the route takes no body, so it can never 422 on shape.
        resp = client.post("/api/auth/forgot-username", json={})
        assert resp.status_code == 410
        assert "email" in resp.json()["detail"].lower()

    def test_no_username_reminder_email_is_ever_sent(self, client, db, seeded_db, monkeypatch):
        seeded_db["admin_user"].email = "admin@example.com"
        db.commit()
        calls = {"n": 0}
        monkeypatch.setattr(
            "app.services.email.send_username_reminder",
            lambda *a, **k: calls.__setitem__("n", calls["n"] + 1),
        )
        client.post("/api/auth/forgot-username", json={"email": "admin@example.com"})
        assert calls["n"] == 0
