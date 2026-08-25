"""Volume limits on the paths that mail a CALLER-CHOSEN address.

Signup and resend-verification both end in this site's SES relay sending mail
to whatever address was typed into a public form. Unbounded, that is an open
mail relay pointed at strangers — an abuse vector, and the fastest way to have
the SES account suspended, which would take every transactional mail on the
site down with it. Deletion is the third path: it re-authenticates from a
request BODY, so an unthrottled one is a password oracle for a stolen session.

Four rules, one per rule-class the limiter already knows how to express:

* creation volume per host      -> flat hour pause   (``limiter.pause``)
* enumeration, the slow walk    -> flat 24h pause    (``limiter.pause``)
* resend volume, address + host -> flat hour pause   (``limiter.pause``)
* wrong delete passwords        -> the login ladder  (``record_failure``)

Every test here asserts the REFUSAL SHAPE as well as the refusal: signup's 429
stays a 429, resend stays the byte-identical generic OK (it must never become
an existence oracle), delete stays a 401. A throttle that changes the reply
shape leaks the very thing the endpoint was written to hide.
"""

import uuid as uuid_mod
from datetime import UTC, datetime

from app.models import User
from app.services import email as email_service
from app.services import rate_limit
from app.services.auth_service import hash_password
from app.services.rate_limit import (
    CREATE_LOCK_SECONDS,
    CREATE_THRESHOLD,
    CREATE_WINDOW_SECONDS,
    PROBE_DISTINCT_THRESHOLD,
    PROBE_LOCK_SECONDS,
    PROBE_WIDE_DISTINCT_THRESHOLD,
    PROBE_WIDE_LOCK_SECONDS,
    PROBE_WIDE_WINDOW_SECONDS,
    RESEND_EMAIL_THRESHOLD,
    RESEND_IP_THRESHOLD,
    RESEND_LOCK_SECONDS,
    limiter,
    per_worker_threshold,
    reset_signup_counters,
)

PW = "Analytical1!"
GOOD = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@test.example", "password": PW}
IP = "203.0.113.7"
OTHER_IP = "198.51.100.9"


def setup_function():
    limiter.reset()
    reset_signup_counters()


class _FakeClock:
    """The module's ``_now`` seam — fast-forward instead of sleeping."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _signup(client, email: str, ip: str = IP):
    return client.post("/api/auth/signup", json={**GOOD, "email": email}, headers={"X-Real-IP": ip})


def _resend(client, email: str, ip: str = IP):
    return client.post(
        "/api/auth/resend-verification", json={"email": email}, headers={"X-Real-IP": ip}
    )


def _existing(db, email: str) -> User:
    """A registered account, minted directly — the route is not what is under
    test here and 25 bcrypt hashes would prove nothing about hashing."""
    user = User(id=uuid_mod.uuid4(), username=email, email=email, password_hash="x", role="user")
    db.add(user)
    db.commit()
    return user


def _unverified(db, email: str) -> User:
    """Registered, mailbox not yet proved — the only state resend mails."""
    return _existing(db, email)


def _mute_mail(monkeypatch) -> list[str]:
    """Capture verification mail instead of sending it; return the recipients.

    Not only for speed: the list IS the assertion. Every reply on this route is
    a constant, so "was mail sent" is the only observable that distinguishes a
    throttled call from a served one.
    """
    sent: list[str] = []

    async def _capture(to_email, first_name, verify_url):
        sent.append(to_email)
        return True

    monkeypatch.setattr(email_service, "send_verification_email", _capture)
    return sent


# ── (a) creation volume ─────────────────────────────────────────────────────
class TestCreationIsBounded:
    """A fresh address returns 202 and mails a stranger. Nothing counted that
    until now: the probe counter only ever fires on ALREADY-TAKEN addresses, so
    the entire happy path was unmetered."""

    def test_the_thresholds_are_the_ones_that_were_decided(self):
        assert CREATE_THRESHOLD == 10
        assert CREATE_WINDOW_SECONDS == 60 * 60
        assert CREATE_LOCK_SECONDS == 60 * 60

    def test_the_eleventh_account_from_one_host_is_refused(self, client, db, monkeypatch):
        sent = _mute_mail(monkeypatch)
        for i in range(CREATE_THRESHOLD):
            assert _signup(client, f"new{i}@test.example").status_code == 202
        assert len(sent) == CREATE_THRESHOLD

        r = _signup(client, "one-too-many@test.example")
        assert r.status_code == 429
        assert r.json()["detail"] == "too_many_requests"
        assert int(r.headers["Retry-After"]) == CREATE_LOCK_SECONDS
        # The refusal is real: no row, and no mail to the address that was typed.
        assert db.query(User).filter(User.email == "one-too-many@test.example").count() == 0
        assert len(sent) == CREATE_THRESHOLD

    def test_another_host_is_unaffected(self, client, monkeypatch):
        _mute_mail(monkeypatch)
        for i in range(CREATE_THRESHOLD + 1):
            _signup(client, f"new{i}@test.example")
        assert _signup(client, "elsewhere@test.example", ip=OTHER_IP).status_code == 202

    def test_the_count_is_per_hour_not_forever(self, client, monkeypatch):
        clock = _FakeClock()
        monkeypatch.setattr(rate_limit, "_now", clock)
        _mute_mail(monkeypatch)
        for i in range(CREATE_THRESHOLD - 1):
            assert _signup(client, f"early{i}@test.example").status_code == 202
        clock.t += CREATE_WINDOW_SECONDS + 1
        # The window has slid past all of them, so this host starts clean —
        # an office behind one NAT is not locked out for the rest of the year.
        for i in range(CREATE_THRESHOLD - 1):
            assert _signup(client, f"later{i}@test.example").status_code == 202

    def test_a_creation_flood_does_not_lock_the_host_out_of_signing_in(self, client, monkeypatch):
        # Why signup:* is a separate namespace at all.
        _mute_mail(monkeypatch)
        for i in range(CREATE_THRESHOLD + 1):
            _signup(client, f"new{i}@test.example")
        r = client.post(
            "/api/auth/login",
            json={"email": "someone@test.example", "password": PW},
            headers={"X-Real-IP": IP},
        )
        assert r.status_code == 401  # wrong credentials, NOT a lockout


# ── (b) the slow enumeration walk ───────────────────────────────────────────
class TestTheSlowWalkIsCaught:
    """The 8-in-15-minutes rule is a sprint detector. Seven distinct addresses
    per 16 minutes never trips it and still walks 26 an hour — which is exactly
    what an enumerator building a customer list would do."""

    def test_the_thresholds_are_the_ones_that_were_decided(self):
        assert PROBE_WIDE_DISTINCT_THRESHOLD == 25
        assert PROBE_WIDE_WINDOW_SECONDS == 60 * 60
        assert PROBE_WIDE_LOCK_SECONDS == 24 * 60 * 60

    def test_a_paced_walk_that_never_trips_the_sprint_rule_is_still_stopped(
        self, client, db, monkeypatch
    ):
        clock = _FakeClock()
        monkeypatch.setattr(rate_limit, "_now", clock)
        _mute_mail(monkeypatch)

        walked = 0
        while walked < PROBE_WIDE_DISTINCT_THRESHOLD:
            for _ in range(PROBE_DISTINCT_THRESHOLD - 1):  # 7 — one under the sprint rule
                if walked >= PROBE_WIDE_DISTINCT_THRESHOLD:
                    break
                email = f"taken{walked}@test.example"
                _existing(db, email)
                # Every one of these is served: the sprint rule never fires.
                assert _signup(client, email).status_code == 409
                walked += 1
            if walked < PROBE_WIDE_DISTINCT_THRESHOLD:
                clock.t += 16 * 60  # past the 15-minute window, inside the hour

        r = _signup(client, "after-the-walk@test.example")
        assert r.status_code == 429
        # A DAY, not the sprint rule's hour — the two penalties are distinct and
        # the longer one is the one that must be in force.
        assert int(r.headers["Retry-After"]) == PROBE_WIDE_LOCK_SECONDS
        assert PROBE_WIDE_LOCK_SECONDS > PROBE_LOCK_SECONDS

    def test_one_address_retried_forever_is_not_a_walk(self, client, db, monkeypatch):
        # The person who forgot they registered. Distinct values, not attempts.
        _mute_mail(monkeypatch)
        _existing(db, "ada@test.example")
        for _ in range(PROBE_WIDE_DISTINCT_THRESHOLD + 5):
            assert _signup(client, "ada@test.example").status_code == 409


# ── (c) resend volume ───────────────────────────────────────────────────────
class TestResendArmsItsBucket:
    """It used to READ the bucket signup arms and record nothing of its own, so
    a loop mail-bombed one registrant at whatever rate the network allowed."""

    def test_the_thresholds_are_the_ones_that_were_decided(self):
        assert RESEND_EMAIL_THRESHOLD == 5
        assert RESEND_IP_THRESHOLD == 20
        assert RESEND_LOCK_SECONDS == 60 * 60

    def test_one_address_stops_receiving_mail_after_the_fifth(self, client, db, monkeypatch):
        sent = _mute_mail(monkeypatch)
        user = _unverified(db, "ada@test.example")
        for _ in range(RESEND_EMAIL_THRESHOLD):
            assert _resend(client, user.email).status_code == 200
        assert len(sent) == RESEND_EMAIL_THRESHOLD

        r = _resend(client, user.email)
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}  # STILL generic — never an oracle
        assert len(sent) == RESEND_EMAIL_THRESHOLD  # and no sixth mail

    def test_the_address_lock_does_not_silence_a_different_registrant(
        self, client, db, monkeypatch
    ):
        sent = _mute_mail(monkeypatch)
        victim = _unverified(db, "ada@test.example")
        other = _unverified(db, "grace@test.example")
        for _ in range(RESEND_EMAIL_THRESHOLD + 1):
            _resend(client, victim.email)
        _resend(client, other.email)
        assert sent[-1] == other.email

    def test_the_host_stops_being_a_mailer_after_the_twentieth(self, client, db, monkeypatch):
        sent = _mute_mail(monkeypatch)
        # One attempt per address, so the per-address rule cannot fire first —
        # this isolates the per-HOST rule.
        for i in range(RESEND_IP_THRESHOLD):
            user = _unverified(db, f"reg{i}@test.example")
            assert _resend(client, user.email).status_code == 200
        assert len(sent) == RESEND_IP_THRESHOLD

        last = _unverified(db, "reg-last@test.example")
        r = _resend(client, last.email)
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}
        assert len(sent) == RESEND_IP_THRESHOLD

    def test_a_resend_flood_does_not_lock_the_host_out_of_signing_in(self, client, db, monkeypatch):
        _mute_mail(monkeypatch)
        for i in range(RESEND_IP_THRESHOLD + 1):
            user = _unverified(db, f"reg{i}@test.example")
            _resend(client, user.email)
        r = client.post(
            "/api/auth/login",
            json={"email": "someone@test.example", "password": PW},
            headers={"X-Real-IP": IP},
        )
        assert r.status_code == 401


# ── (d) the delete password ─────────────────────────────────────────────────
def _activated(db, email: str = "c@test.example") -> User:
    user = User(
        id=uuid_mod.uuid4(),
        username=email,
        email=email,
        password_hash=hash_password(PW),
        role="user",
        first_name="Ada",
        email_verified_at=datetime.now(UTC),
        activated_at=datetime.now(UTC),
    )
    db.add(user)
    db.commit()
    return user


def _auth(client, email: str = "c@test.example") -> dict[str, str]:
    r = client.post("/api/auth/login", json={"email": email, "password": PW})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _delete(client, headers, password=PW):
    return client.request("DELETE", "/api/account/me", json={"password": password}, headers=headers)


class TestDeleteIsThrottledLikeLogin:
    """It takes the current password in the body, so an unthrottled DELETE is a
    password oracle that /auth/login refuses to be."""

    def test_repeated_wrong_passwords_lock_the_endpoint(self, client, db):
        _activated(db)
        headers = _auth(client)
        for _ in range(per_worker_threshold()):
            assert _delete(client, headers, password="Wrong1!aa").status_code == 401

        # The CORRECT password now, and it is still refused — which is the whole
        # point: the lock has to hold shut for the attacker who eventually
        # guesses right.
        r = _delete(client, headers)
        assert r.status_code == 401
        assert r.json()["detail"] == "Invalid credentials"
        assert int(r.headers["Retry-After"]) > 0
        assert db.query(User).filter(User.email == "c@test.example").count() == 1

    def test_the_lock_is_per_account_not_per_host(self, client, db):
        _activated(db)
        other = _activated(db, "grace@test.example")
        headers = _auth(client)
        other_headers = _auth(client, other.email)
        for _ in range(per_worker_threshold()):
            _delete(client, headers, password="Wrong1!aa")
        # Same host, different account: their own Danger Zone still works.
        assert _delete(client, other_headers).status_code == 200

    def test_a_wrong_guess_below_the_threshold_does_not_break_the_success_path(self, client, db):
        _activated(db)
        headers = _auth(client)
        assert _delete(client, headers, password="Wrong1!aa").status_code == 401
        assert _delete(client, headers).status_code == 200
        assert db.query(User).filter(User.email == "c@test.example").count() == 0

    def test_a_delete_lockout_does_not_lock_the_account_out_of_signing_in(self, client, db):
        _activated(db)
        headers = _auth(client)
        for _ in range(per_worker_threshold() + 1):
            _delete(client, headers, password="Wrong1!aa")
        r = client.post("/api/auth/login", json={"email": "c@test.example", "password": PW})
        assert r.status_code == 200
