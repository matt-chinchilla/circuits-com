"""Tests for the seeded admin users: emails + the demo/demo account.

The recovery flows need an email on each admin row, and the redesigned login
advertises a working demo/demo account.
"""

import bcrypt

from app.db.seed import _seed_admin_user
from app.models import User


class TestSeedAdminUsers:
    def test_demo_user_seeded_with_email(self, db):
        _seed_admin_user(db)
        db.commit()
        demo = db.query(User).filter(User.username == "demo").first()
        assert demo is not None
        assert demo.role == "admin"
        assert demo.email == "demo@circuitcenter.ai"

    def test_named_admins_get_emails(self, db):
        _seed_admin_user(db)
        db.commit()
        expected = {
            "matthew": "matthew@circuitcenter.ai",
            "Daniel": "daniel@circuitcenter.ai",
            "Anthony": "anthony@circuitcenter.ai",
            "Ronald": "ronald@circuitcenter.ai",
        }
        for username, email in expected.items():
            u = db.query(User).filter(User.username == username).first()
            assert u is not None
            assert u.role == "admin"
            assert u.email == email

    def test_former_partners_not_seeded(self, db):
        # Mike and John parted ways — their logins are no longer seeded.
        _seed_admin_user(db)
        db.commit()
        for username in ("mike", "john"):
            assert db.query(User).filter(User.username == username).first() is None

    def test_new_team_credentials_authenticate(self, client, db, monkeypatch):
        # Passwords now come from env vars (real values live in the gitignored
        # prod .env); set them here so the test still proves the seeded users
        # authenticate with their real, non-fallback credentials.
        monkeypatch.setenv("SEED_PW_DANIEL", "DanmyfriendDan")
        monkeypatch.setenv("SEED_PW_ANTHONY", "AntmyfriendAnt")
        monkeypatch.setenv("SEED_PW_RONALD", "RonmyfriendRon")
        _seed_admin_user(db)
        db.commit()
        for username, password in (
            ("Daniel", "DanmyfriendDan"),
            ("Anthony", "AntmyfriendAnt"),
            ("Ronald", "RonmyfriendRon"),
        ):
            resp = client.post(
                "/api/auth/login", json={"username": username, "password": password}
            )
            assert resp.status_code == 200, f"{username} login failed"
            assert resp.json()["user"]["username"] == username

    def test_demo_credentials_authenticate(self, client, db):
        _seed_admin_user(db)
        db.commit()
        resp = client.post(
            "/api/auth/login", json={"username": "demo", "password": "demo"}
        )
        assert resp.status_code == 200
        assert resp.json()["user"]["username"] == "demo"

    def test_idempotent_no_duplicates(self, db):
        _seed_admin_user(db)
        db.commit()
        _seed_admin_user(db)
        db.commit()
        assert db.query(User).filter(User.username == "demo").count() == 1

    def test_backfills_email_on_legacy_row(self, db):
        # Simulate a row seeded before migration 015 (no email).
        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()
        db.add(User(username="matthew", password_hash=hashed, role="admin"))
        db.flush()
        _seed_admin_user(db)
        db.commit()
        u = db.query(User).filter(User.username == "matthew").first()
        assert u.email == "matthew@circuitcenter.ai"
