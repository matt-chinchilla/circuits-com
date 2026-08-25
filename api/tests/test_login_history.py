"""Sign-in history stamps (alembic 024).

The admin Settings page used to print a hardcoded ``2026-04-25 08:42 EDT`` and
``from 73.142.18.4``. These are the contracts that replaced it:

1. **The console shows the sign-in BEFORE the current one.** Each login shifts
   ``last_* -> prev_*`` then stamps itself. "You signed in four seconds ago" is
   not information; "the session before this came from that address" is how
   someone notices access that was not theirs.
2. **The recorded address is one WE control.** It is read from ``X-Real-IP``
   (nginx overwrites it with ``$remote_addr``), never the caller-supplied
   ``X-Forwarded-For``. A spoofable stamp is worse than no stamp: it is evidence
   pointing wherever an attacker chose to point it.
3. **Recording never costs a valid credential its session.** A failure writing
   the stamp is swallowed, not 500-ed back at a login that already succeeded.
4. **Failed logins leave no trace**, so a brute-force run cannot overwrite the
   very record someone would use to notice it.
"""

from datetime import UTC, datetime

import pytest

from app.models import User

ADMIN_EMAIL = "admin@test.example"
ADMIN_PASSWORD = "testpass123"


def _login(client, *, headers=None, email=ADMIN_EMAIL, password=ADMIN_PASSWORD):
    return client.post(
        "/api/auth/login",
        json={"email": email, "password": password},
        headers=headers or {},
    )


def _me(client, token):
    return client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})


def _admin(db):
    return db.query(User).filter(User.email == ADMIN_EMAIL).first()


class TestStampShifting:
    def test_first_login_records_itself_and_leaves_previous_empty(self, client, db, seeded_db):
        assert _login(client).status_code == 200

        user = _admin(db)
        db.refresh(user)
        assert user.last_login_at is not None
        # Nothing came before, so the console has nothing to show — and must
        # say so rather than invent a date.
        assert user.prev_login_at is None
        assert user.prev_login_ip is None

    def test_second_login_shifts_the_first_into_previous(self, client, db, seeded_db):
        _login(client, headers={"X-Real-IP": "203.0.113.7"})
        user = _admin(db)
        db.refresh(user)
        first_at = user.last_login_at

        _login(client, headers={"X-Real-IP": "198.51.100.22"})
        db.refresh(user)

        assert user.prev_login_at == first_at
        assert user.prev_login_ip == "203.0.113.7"
        assert user.last_login_ip == "198.51.100.22"

    def test_failed_login_records_nothing(self, client, db, seeded_db):
        _login(client, headers={"X-Real-IP": "203.0.113.7"})
        user = _admin(db)
        db.refresh(user)
        before = (user.last_login_at, user.last_login_ip, user.prev_login_at)

        assert _login(client, password="wrong").status_code == 401
        db.refresh(user)

        # A brute-force run must not be able to push the real sign-in out of
        # the record someone would use to notice the brute-force run.
        assert (user.last_login_at, user.last_login_ip, user.prev_login_at) == before


class TestAddressIsNotSpoofable:
    def test_x_forwarded_for_is_ignored(self, client, db, seeded_db):
        # The header a caller can set at will must never become the stamp.
        _login(client, headers={"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "9.9.9.9"})
        user = _admin(db)
        db.refresh(user)
        assert user.last_login_ip == "203.0.113.7"
        assert user.last_login_ip != "9.9.9.9"

    def test_only_the_rightmost_forwarded_hop_is_trusted(self, client, db, seeded_db):
        """With no X-Real-IP, the RIGHTMOST X-Forwarded-For hop is the record.

        nginx APPENDS `$remote_addr`, so everything left of the last comma is a
        string the caller typed. Recording the leftmost hop would let an
        attacker write whatever address they liked into the audit line.
        """
        _login(client, headers={"X-Forwarded-For": "9.9.9.9, 203.0.113.7"})
        user = _admin(db)
        db.refresh(user)
        assert user.last_login_ip == "203.0.113.7"
        assert user.last_login_ip != "9.9.9.9"

    @pytest.mark.parametrize(
        ("sent", "recorded"),
        [
            # IPv4 — the common case — is stored exactly as observed.
            ("203.0.113.7", "203.0.113.7"),
            # An IPv4-mapped v6 address is the SAME host as its v4 form and
            # canonicalizes to it, so the console cannot show one person's
            # sign-in under two different spellings.
            ("0000:0000:0000:0000:0000:ffff:203.0.113.7", "203.0.113.7"),
            # Real IPv6 collapses to its /64 network. That is `client_ip`'s
            # rate-limit bucketing (one allowance per network, not per address
            # in a /64 an attacker can walk) reused here on purpose: the
            # X-Real-IP precedence above is the part that must not diverge, so
            # there is ONE implementation of it. The console showing a network
            # rather than a host is a privacy gain, not a loss.
            ("2001:db8::1", "2001:db8::/64"),
        ],
    )
    def test_address_is_canonicalized_the_same_way_the_limiter_buckets(
        self, client, db, seeded_db, sent, recorded
    ):
        _login(client, headers={"X-Real-IP": sent})
        user = _admin(db)
        db.refresh(user)
        assert user.last_login_ip == recorded

    def test_column_is_wide_enough_for_any_address(self):
        # SQLite ignores String(N), so assert on the metadata the way the rest
        # of this suite does for length contracts.
        assert User.__table__.c.last_login_ip.type.length >= 45
        assert User.__table__.c.prev_login_ip.type.length >= 45


class TestMeExposesIt:
    def test_me_returns_previous_login_and_real_email(self, client, seeded_db):
        _login(client, headers={"X-Real-IP": "203.0.113.7"})
        token = _login(client, headers={"X-Real-IP": "198.51.100.22"}).json()["token"]

        body = _me(client, token).json()
        assert body["previous_login_ip"] == "203.0.113.7"
        assert body["previous_login_at"] is not None
        # The address is real now, not the hardcoded `matt@` the console shipped.
        assert body["email"] == ADMIN_EMAIL

    def test_me_reports_null_before_a_second_login(self, client, seeded_db):
        token = _login(client).json()["token"]
        body = _me(client, token).json()
        assert body["previous_login_at"] is None
        assert body["previous_login_ip"] is None

    def test_previous_login_survives_a_reload(self, client, seeded_db):
        """The value must come from the database, not from the login payload.

        A reloaded tab only calls /auth/me — if `previous_*` were derived from
        what the login response happened to carry, it would go blank on refresh.
        """
        _login(client, headers={"X-Real-IP": "203.0.113.7"})
        token = _login(client, headers={"X-Real-IP": "198.51.100.22"}).json()["token"]

        first = _me(client, token).json()
        second = _me(client, token).json()
        assert first["previous_login_ip"] == second["previous_login_ip"] == "203.0.113.7"


class TestRecordingNeverBreaksSignIn:
    def test_login_succeeds_even_if_the_stamp_write_fails(
        self, client, db, seeded_db, monkeypatch
    ):
        from app.routes import auth as auth_routes

        def _explode(request):
            raise RuntimeError("no address available")

        monkeypatch.setattr(auth_routes, "client_ip", _explode)

        # A valid credential must still get its session; the stamp is a nicety.
        resp = _login(client)
        assert resp.status_code == 200
        assert resp.json()["token"]


class TestModelDefaults:
    def test_a_fresh_user_has_no_history(self, db):
        user = User(
            username="nobody",
            email="nobody@test.example",
            password_hash="x",
            role="admin",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        assert user.last_login_at is None
        assert user.last_login_ip is None
        assert user.prev_login_at is None
        assert user.prev_login_ip is None

    def test_column_declares_timezone_awareness(self):
        """Assert the CONTRACT on metadata, not the value.

        SQLite has no timezone-aware type, so `DateTime(timezone=True)` round
        trips as naive here no matter what Postgres does — comparing a stored
        value against an aware `now()` would only ever test the test database.
        The declaration is what production honours, so that is what is asserted.
        """
        assert User.__table__.c.last_login_at.type.timezone is True
        assert User.__table__.c.prev_login_at.type.timezone is True

    def test_stamp_is_recent(self, client, db, seeded_db):
        _login(client)
        user = _admin(db)
        db.refresh(user)
        stamped = user.last_login_at
        assert stamped is not None
        # Normalize both sides: see the note above on SQLite's naive round trip.
        now = datetime.now(UTC).replace(tzinfo=None)
        assert abs((now - stamped.replace(tzinfo=None)).total_seconds()) < 60
