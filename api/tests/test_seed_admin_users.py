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
        for username in ("matthew", "mike", "john"):
            u = db.query(User).filter(User.username == username).first()
            assert u is not None
            assert u.email == f"{username}@circuitcenter.ai"

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
