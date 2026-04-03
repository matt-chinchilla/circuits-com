"""Tests for auth routes: login, logout, /me."""


class TestLogin:
    def test_login_valid_credentials(self, client, seeded_db):
        resp = client.post("/api/auth/login", json={
            "username": "admin",
            "password": "testpass123",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "token" in data
        assert data["user"]["username"] == "admin"
        assert data["user"]["role"] == "admin"
        assert data["user"]["supplier_id"] is None

    def test_login_company_user(self, client, seeded_db):
        resp = client.post("/api/auth/login", json={
            "username": "kennedy_user",
            "password": "testpass123",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["user"]["role"] == "company"
        assert data["user"]["supplier_id"] is not None

    def test_login_wrong_password(self, client, seeded_db):
        resp = client.post("/api/auth/login", json={
            "username": "admin",
            "password": "wrongpassword",
        })
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"

    def test_login_nonexistent_user(self, client, seeded_db):
        resp = client.post("/api/auth/login", json={
            "username": "nobody",
            "password": "testpass123",
        })
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"


class TestLogout:
    def test_logout_returns_ok(self, client):
        resp = client.post("/api/auth/logout")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


class TestMe:
    def _get_token(self, client, username="admin", password="testpass123"):
        resp = client.post("/api/auth/login", json={
            "username": username,
            "password": password,
        })
        return resp.json()["token"]

    def test_me_with_valid_token(self, client, seeded_db):
        token = self._get_token(client)
        resp = client.get("/api/auth/me", headers={
            "Authorization": f"Bearer {token}",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "admin"
        assert data["role"] == "admin"

    def test_me_without_token(self, client, seeded_db):
        resp = client.get("/api/auth/me")
        assert resp.status_code == 401

    def test_me_with_invalid_token(self, client, seeded_db):
        resp = client.get("/api/auth/me", headers={
            "Authorization": "Bearer invalidtoken123",
        })
        assert resp.status_code == 401

    def test_me_with_expired_token(self, client, seeded_db):
        import jwt
        from datetime import datetime, timezone, timedelta
        from app.config import settings

        payload = {
            "sub": str(seeded_db["admin_user"].id),
            "role": "admin",
            "exp": datetime.now(timezone.utc) - timedelta(hours=1),
            "iat": datetime.now(timezone.utc) - timedelta(hours=25),
        }
        expired_token = jwt.encode(payload, settings.ADMIN_SECRET_KEY, algorithm="HS256")
        resp = client.get("/api/auth/me", headers={
            "Authorization": f"Bearer {expired_token}",
        })
        assert resp.status_code == 401

    def test_me_company_user(self, client, seeded_db):
        token = self._get_token(client, "kennedy_user", "testpass123")
        resp = client.get("/api/auth/me", headers={
            "Authorization": f"Bearer {token}",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "kennedy_user"
        assert data["role"] == "company"
        assert data["supplier_id"] is not None
