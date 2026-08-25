"""Tests for the seeded admin users: emails, roles, forced resets.

The recovery flows need an email on each admin row, and email is the login key
since alembic 022, so every seeded account must carry one.

``_seed_admin_user`` is also the durable home of the account contract alembic
022 backfilled once (matthew is the ``owner``; the four named humans start
flagged for a forced password rotation). The migration only
matched rows that already existed when it ran, so without the same rules here a
fresh database or a ``./deploy.sh --reseed`` — which truncates ``users`` via the
suppliers FK cascade — would silently demote the owner and cancel every forced
rotation. See ``TestSeededAccountContract``.
"""

import bcrypt

from app.db.seed import _seed_admin_user
from app.models import User
from app.routes.auth import INVALID_CREDENTIALS_DETAIL


class TestSeedAdminUsers:
    def test_no_demo_account_is_seeded(self, db):
        """Alembic 044 retired it; the seed must not resurrect it.

        The seed re-runs on EVERY api container start, so a demo row put back
        here would return on the next deploy — and since the login-time refusal
        that used to block it is gone, it would return as a working admin
        login with a published password.
        """
        _seed_admin_user(db)
        db.commit()
        assert db.query(User).filter(User.username == "demo").count() == 0
        assert db.query(User).filter(
            User.email == "demo@circuitcenter.ai").count() == 0

    def test_named_admins_get_emails(self, db):
        _seed_admin_user(db)
        db.commit()
        expected = {
            "matthew": ("matthew@circuitcenter.ai", "owner"),
            "Daniel": ("daniel@circuitcenter.ai", "admin"),
            "Anthony": ("anthony@circuitcenter.ai", "admin"),
            "Ronald": ("ronald@circuitcenter.ai", "admin"),
        }
        for username, (email, role) in expected.items():
            u = db.query(User).filter(User.username == username).first()
            assert u is not None
            assert u.role == role
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
        # Login is keyed on the email address now — the seeded usernames are
        # mixed-case, the addresses are lowercase, and both are matched
        # case-insensitively.
        for username, email, password in (
            ("Daniel", "daniel@circuitcenter.ai", "DanmyfriendDan"),
            ("Anthony", "Anthony@CircuitCenter.ai", "AntmyfriendAnt"),
            ("Ronald", "ronald@circuitcenter.ai", "RonmyfriendRon"),
        ):
            resp = client.post("/api/auth/login", json={"email": email, "password": password})
            assert resp.status_code == 200, f"{username} login failed"
            assert resp.json()["user"]["username"] == username


    def test_idempotent_no_duplicates(self, db):
        _seed_admin_user(db)
        db.commit()
        _seed_admin_user(db)
        db.commit()
        assert db.query(User).filter(User.username == "matthew").count() == 1

    def test_backfills_email_on_legacy_row(self, db):
        # Simulate a row seeded before migration 015 (no email). Migration
        # 022 makes email NOT NULL, so a truly absent (None) email is no
        # longer representable in the DB — "" is the closest legacy-row
        # stand-in and still exercises the same falsy-email backfill branch
        # in _seed_admin_user (`if not existing.email:`).
        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()
        db.add(User(username="matthew", password_hash=hashed, role="admin", email=""))
        db.flush()
        _seed_admin_user(db)
        db.commit()
        u = db.query(User).filter(User.username == "matthew").first()
        assert u.email == "matthew@circuitcenter.ai"


class TestSeededAccountContract:
    """owner + forced-rotation flags survive a fresh DB and a --reseed.

    These lived ONLY in migration 022's one-shot data backfill, which matches
    zero rows on a database seeded after it was stamped — so every new
    environment, and every `./deploy.sh --reseed` (it truncates `users` through
    the suppliers FK cascade), used to hand matthew back a plain `admin` role
    and cancel all four forced rotations with no error anywhere.
    """

    def _seeded(self, db):
        _seed_admin_user(db)
        db.commit()
        return {u.username: u for u in db.query(User).all()}

    def test_matthew_is_seeded_as_the_owner(self, db):
        assert self._seeded(db)["matthew"].role == "owner"

    def test_the_four_named_humans_start_flagged_for_a_reset(self, db):
        users = self._seeded(db)
        for username in ("matthew", "Daniel", "Anthony", "Ronald"):
            assert users[username].must_change_password is True, username

    def test_a_reseed_does_not_re_flag_an_admin_who_already_rotated(self, db):
        # The one thing the seeder must NOT re-assert: re-stamping the flag
        # would trap an admin on the reset screen every time seed.py runs.
        self._seeded(db)
        daniel = db.query(User).filter(User.username == "Daniel").first()
        daniel.must_change_password = False
        db.commit()

        _seed_admin_user(db)
        db.commit()
        assert (
            db.query(User).filter(User.username == "Daniel").first().must_change_password is False
        )

    def test_a_reseed_re_asserts_the_owner_role(self, db):
        # A row created before matthew was promoted (or by an older seeder)
        # self-heals instead of leaving the owner demoted forever.
        hashed = bcrypt.hashpw(b"admin", bcrypt.gensalt()).decode()
        db.add(
            User(
                username="matthew",
                password_hash=hashed,
                role="admin",
                email="matthew@circuitcenter.ai",
            )
        )
        db.flush()

        _seed_admin_user(db)
        db.commit()
        assert db.query(User).filter(User.username == "matthew").first().role == "owner"

    def test_seeding_twice_leaves_one_owner(self, db):
        self._seeded(db)
        _seed_admin_user(db)
        db.commit()
        assert db.query(User).filter(User.role == "owner").count() == 1
