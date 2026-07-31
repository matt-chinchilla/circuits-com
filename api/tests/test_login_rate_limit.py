"""Login + recovery rate limiting (Task 5, P1 auth overhaul).

The API had NO rate limiting before this; ``app.services.rate_limit`` is the
whole story. Four contracts are asserted here:

1. **It actually locks.** Five failures arm a lock; further locks on the same
   key double, capped at 15 minutes; the key forgets everything after a
   success or a quiet decay window.
2. **A lockout is not an oracle.** A locked-out attempt returns the byte-identical
   generic 401 a wrong password returns — only a ``Retry-After`` header differs,
   and that header is armed by the CALLER's own volume, identically for an
   address that has no account.
3. **Blast radius is bounded.** Keys are per-IP AND per-account, so one host's
   lockout never touches another's, and the ``login:*`` / ``recovery:*``
   namespaces are separate so a sign-in lockout can never suppress the password
   reset email that resolves it.
4. **The demo account still works.** ``POST /auth/demo`` honors an existing
   login lockout (no back door) but never escalates one, and clicking it all
   day never locks a prospect out.

Time is fast-forwarded through the ``rate_limit._now`` seam — no test sleeps.
The client IP is steered with ``X-Forwarded-For``, which uvicorn's
ProxyHeadersMiddleware (mounted with ``trusted_hosts="*"`` in app.main)
rewrites into ``request.client.host`` exactly as nginx does in production.
"""

import bcrypt
import pytest

from app.models import User
from app.services import rate_limit
from app.services.rate_limit import RateLimiter

ADMIN_EMAIL = "admin@test.example"
ADMIN_PASSWORD = "testpass123"
WRONG_PASSWORD = "not-the-password"
THRESHOLD = rate_limit.FAILURE_THRESHOLD

GENERIC_401 = {"detail": "Invalid credentials"}


class FakeClock:
    """Monotonic-shaped clock the tests drive by hand."""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def advance(self, seconds: float) -> None:
        self.t += seconds

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock(monkeypatch):
    """Freeze the limiter's clock. The autouse limiter reset in conftest runs
    first, so no counter can be carrying a real-monotonic timestamp into a
    faked timeline."""
    fake = FakeClock()
    monkeypatch.setattr(rate_limit, "_now", fake)
    return fake


def _login(client, *, email=ADMIN_EMAIL, password=ADMIN_PASSWORD, ip=None):
    headers = {"X-Forwarded-For": ip} if ip else None
    return client.post(
        "/api/auth/login",
        json={"email": email, "password": password},
        headers=headers,
    )


def _fail_login(client, *, n=THRESHOLD, email=ADMIN_EMAIL, ip=None):
    """Burn n wrong-password attempts; return the last response."""
    resp = None
    for _ in range(n):
        resp = _login(client, email=email, password=WRONG_PASSWORD, ip=ip)
    return resp


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


# ── The limiter itself ──────────────────────────────────────────────────────


class TestRateLimiterUnit:
    """Mechanism, isolated from HTTP."""

    def test_opens_clean(self, clock):
        limiter = RateLimiter()
        assert limiter.retry_after("k") == 0

    def test_locks_at_the_threshold_not_before(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD - 1):
            limiter.record_failure("k")
        assert limiter.retry_after("k") == 0
        limiter.record_failure("k")
        assert limiter.retry_after("k") == rate_limit.BASE_LOCK_SECONDS

    def test_retry_after_counts_down_and_rounds_up(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD):
            limiter.record_failure("k")
        clock.advance(30.5)
        # 29.5s left must never round DOWN to 29 and certainly not to 0 — an
        # active lock always reads as at least 1 second.
        assert limiter.retry_after("k") == 30
        clock.advance(29.4)
        assert limiter.retry_after("k") == 1

    def test_unlocks_when_the_window_passes(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD):
            limiter.record_failure("k")
        clock.advance(rate_limit.BASE_LOCK_SECONDS)
        assert limiter.retry_after("k") == 0

    def test_backoff_doubles_and_caps(self, clock):
        limiter = RateLimiter()
        seen = []
        for _ in range(8):
            for _ in range(THRESHOLD):
                limiter.record_failure("k")
            seen.append(limiter.retry_after("k"))
            clock.advance(seen[-1])  # ride out the lock, then offend again
        assert seen[:4] == [60, 120, 240, 480]
        assert seen[4:] == [rate_limit.MAX_LOCK_SECONDS] * 4

    def test_success_clears_the_key(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD - 1):
            limiter.record_failure("k")
        limiter.clear("k")
        for _ in range(THRESHOLD - 1):
            limiter.record_failure("k")
        assert limiter.retry_after("k") == 0

    def test_clear_also_drops_the_escalation_level(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD):
            limiter.record_failure("k")
        assert limiter.retry_after("k") == 60
        clock.advance(60)
        limiter.clear("k")
        for _ in range(THRESHOLD):
            limiter.record_failure("k")
        # Back to the base delay, not the doubled one.
        assert limiter.retry_after("k") == 60

    def test_a_quiet_key_decays(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD - 1):
            limiter.record_failure("k")
        clock.advance(rate_limit.FAILURE_DECAY_SECONDS + 1)
        # The stale failures are forgotten, so this is failure #1 of 5.
        limiter.record_failure("k")
        assert limiter.retry_after("k") == 0

    def test_decay_never_cancels_an_active_lock(self, clock):
        # A 15 min lock is exactly as long as the decay window; a failure
        # arriving inside it must not be read as "quiet key, start over".
        limiter = RateLimiter(base_lock_seconds=3600, max_lock_seconds=3600, decay_seconds=10)
        for _ in range(THRESHOLD):
            limiter.record_failure("k")
        clock.advance(600)
        limiter.record_failure("k")
        assert limiter.retry_after("k") == 3000

    def test_keys_are_independent(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD):
            limiter.record_failure("a")
        assert limiter.retry_after("a") > 0
        assert limiter.retry_after("b") == 0

    def test_retry_after_reports_the_longest_lock(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD * 2):
            limiter.record_failure("a")  # a is on its second, doubled lock
        for _ in range(THRESHOLD):
            limiter.record_failure("b")
        assert limiter.retry_after("a", "b") == limiter.retry_after("a") == 120

    def test_none_keys_are_ignored(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD):
            limiter.record_failure(None, "k")
        assert limiter.retry_after(None) == 0
        assert limiter.retry_after(None, "k") > 0

    def test_reset_wipes_everything(self, clock):
        limiter = RateLimiter()
        for _ in range(THRESHOLD):
            limiter.record_failure("k")
        limiter.reset()
        assert limiter.retry_after("k") == 0

    def test_flooding_new_keys_cannot_evict_an_active_lock(self, clock):
        # The table's eviction pass only drops expired+decayed buckets, so an
        # attacker cannot wash out their own lockout by spraying fresh keys.
        limiter = RateLimiter(max_keys=8)
        for _ in range(THRESHOLD):
            limiter.record_failure("victim")
        for i in range(200):
            limiter.record_failure(f"flood-{i}")
        assert limiter.retry_after("victim") > 0

    def test_key_table_stays_bounded(self, clock):
        limiter = RateLimiter(max_keys=8, decay_seconds=1)
        for i in range(100):
            limiter.record_failure(f"k-{i}")
            clock.advance(5)  # each key goes stale before the next arrives
        assert len(limiter._buckets) <= 8


# ── POST /api/auth/login ────────────────────────────────────────────────────


class TestLoginLockout:
    def test_n_failures_then_lockout(self, client, seeded_db, clock):
        for _ in range(THRESHOLD - 1):
            assert _login(client, password=WRONG_PASSWORD).status_code == 401
        # Not locked yet: the correct password still works one attempt before
        # the threshold.
        assert _login(client).status_code == 200

        _fail_login(client)
        # Now the RIGHT password is refused — proof the limiter, not the
        # credential check, is answering.
        assert _login(client).status_code == 401

    def test_lockout_returns_the_generic_error(self, client, seeded_db, clock):
        wrong = _login(client, password=WRONG_PASSWORD)
        _fail_login(client, n=THRESHOLD - 1)
        locked = _login(client)
        assert locked.status_code == wrong.status_code == 401
        assert locked.json() == wrong.json() == GENERIC_401

    def test_lockout_sets_retry_after(self, client, seeded_db, clock):
        _fail_login(client)
        locked = _login(client)
        assert locked.headers["Retry-After"] == str(rate_limit.BASE_LOCK_SECONDS)

    def test_a_plain_wrong_password_has_no_retry_after(self, client, seeded_db, clock):
        # Only a REAL lock advertises a delay; a normal miss must look normal.
        assert "Retry-After" not in _login(client, password=WRONG_PASSWORD).headers

    def test_an_unknown_address_locks_out_identically(self, client, seeded_db, clock):
        # If only real accounts scored failures, the lockout would itself be an
        # account-existence oracle. Same threshold, same body, same header.
        ghost = "ghost@test.example"
        for _ in range(THRESHOLD):
            _login(client, email=ghost, password=WRONG_PASSWORD)
        locked = _login(client, email=ghost, password=WRONG_PASSWORD)
        assert locked.status_code == 401
        assert locked.json() == GENERIC_401
        assert locked.headers["Retry-After"] == str(rate_limit.BASE_LOCK_SECONDS)

    def test_fast_forward_unlocks(self, client, seeded_db, clock):
        _fail_login(client)
        assert _login(client).status_code == 401
        clock.advance(rate_limit.BASE_LOCK_SECONDS)
        assert _login(client).status_code == 200

    def test_success_resets_the_counter(self, client, seeded_db, clock):
        _fail_login(client, n=THRESHOLD - 1)
        assert _login(client).status_code == 200
        # A clean login wiped both keys, so the next four misses start over.
        for _ in range(THRESHOLD - 1):
            assert _login(client, password=WRONG_PASSWORD).status_code == 401
        assert _login(client).status_code == 200

    def test_second_lockout_is_longer(self, client, seeded_db, clock):
        _fail_login(client)
        assert _login(client).headers["Retry-After"] == "60"
        clock.advance(60)
        _fail_login(client)
        assert _login(client).headers["Retry-After"] == "120"


class TestLockoutBlastRadius:
    def test_a_fresh_ip_is_unaffected(self, client, seeded_db, clock):
        # Lock 10.0.0.1 out against a throwaway address so only the per-IP key
        # is armed, then check a different host is untouched.
        _fail_login(client, email="ghost@test.example", ip="10.0.0.1")
        assert _login(client, ip="10.0.0.1").status_code == 401
        assert _login(client, ip="10.0.0.2").status_code == 200

    def test_a_sprayed_address_locks_across_ips(self, client, seeded_db, clock):
        # The per-account key is what catches a botnet: one failure per host,
        # all aimed at the same address.
        for i in range(THRESHOLD):
            _login(client, password=WRONG_PASSWORD, ip=f"10.0.1.{i}")
        assert _login(client, ip="10.0.1.99").status_code == 401
        # ...and a DIFFERENT account from that fresh host is still fine.
        assert _login(client, email="kennedy_user@test.example", ip="10.0.1.99").status_code == 200

    def test_one_accounts_lockout_does_not_lock_another(self, client, seeded_db, clock):
        _fail_login(client, email="ghost@test.example", ip="10.0.2.1")
        # Same host is locked (per-IP), but a fresh host reaches the other
        # account normally — the address key stayed clean.
        assert _login(client, email="kennedy_user@test.example", ip="10.0.2.9").status_code == 200

    def test_casing_and_whitespace_share_one_bucket(self, client, seeded_db, clock):
        # The key normalizes like the login lookup does, so retyping the
        # address in caps must not mint a fresh allowance.
        for _ in range(THRESHOLD):
            _login(client, email="  ADMIN@TEST.EXAMPLE  ", password=WRONG_PASSWORD)
        assert _login(client).status_code == 401


class TestDemoEndpoint:
    def test_demo_honors_a_login_lockout(self, client, db, seeded_db, clock):
        _seed_demo(db)
        _fail_login(client, ip="10.0.3.1")
        resp = client.post("/api/auth/demo", headers={"X-Forwarded-For": "10.0.3.1"})
        assert resp.status_code == 401
        assert resp.json() == GENERIC_401

    def test_demo_never_escalates_the_lockout(self, client, db, seeded_db, clock):
        # The marketing button takes no credentials and so cannot "fail":
        # hammering it must never lock a prospect out of the demo.
        _seed_demo(db)
        for _ in range(THRESHOLD * 3):
            assert client.post("/api/auth/demo").status_code == 200
        # ...and it did not poison the real sign-in path either.
        assert _login(client).status_code == 200

    def test_demo_works_from_an_ip_that_never_offended(self, client, db, seeded_db, clock):
        _seed_demo(db)
        _fail_login(client, ip="10.0.4.1")
        assert (
            client.post("/api/auth/demo", headers={"X-Forwarded-For": "10.0.4.2"}).status_code
            == 200
        )

    def test_the_demo_account_can_still_sign_in_normally(self, client, db, seeded_db, clock):
        # The global constraint: demo/demo keeps working. Its own failures
        # score like anyone's, but a clean run is untouched by the limiter.
        _seed_demo(db)
        for _ in range(THRESHOLD * 2):
            resp = client.post(
                "/api/auth/login",
                json={"email": "demo@circuitcenter.ai", "password": "demo"},
            )
            assert resp.status_code == 200


# ── Recovery endpoints ──────────────────────────────────────────────────────


def _forgot(client, identifier=ADMIN_EMAIL, ip=None):
    headers = {"X-Forwarded-For": ip} if ip else None
    return client.post(
        "/api/auth/forgot-password", json={"identifier": identifier}, headers=headers
    )


def _reset(client, token="not-a-jwt", password="Newpass99!", ip=None):
    headers = {"X-Forwarded-For": ip} if ip else None
    return client.post(
        "/api/auth/reset-password",
        json={"token": token, "new_password": password},
        headers=headers,
    )


class TestForgotPasswordThrottle:
    def test_throttles_after_the_threshold(self, client, seeded_db, clock, monkeypatch):
        sent = []
        monkeypatch.setattr(
            "app.services.email.send_password_reset",
            lambda *a, **k: sent.append(a),
        )
        for _ in range(THRESHOLD):
            assert _forgot(client).status_code == 200
        assert len(sent) == THRESHOLD

        throttled = _forgot(client)
        # Byte-identical to the unthrottled answer — this endpoint's response
        # is a constant by design — but no mail left the building.
        assert throttled.status_code == 200
        assert throttled.json() == {"status": "ok"}
        assert throttled.headers["Retry-After"] == str(rate_limit.BASE_LOCK_SECONDS)
        assert len(sent) == THRESHOLD

    def test_fast_forward_restores_sending(self, client, seeded_db, clock, monkeypatch):
        sent = []
        monkeypatch.setattr(
            "app.services.email.send_password_reset",
            lambda *a, **k: sent.append(a),
        )
        for _ in range(THRESHOLD + 1):
            _forgot(client)
        assert len(sent) == THRESHOLD
        clock.advance(rate_limit.BASE_LOCK_SECONDS)
        _forgot(client)
        assert len(sent) == THRESHOLD + 1

    def test_a_fresh_ip_and_target_are_unaffected(self, client, seeded_db, clock):
        for _ in range(THRESHOLD):
            _forgot(client, identifier="ghost@test.example", ip="10.0.5.1")
        assert (
            "Retry-After" in _forgot(client, identifier="ghost@test.example", ip="10.0.5.1").headers
        )
        assert (
            "Retry-After"
            not in _forgot(client, identifier="other@test.example", ip="10.0.5.2").headers
        )


class TestNamespacesAreSeparate:
    """A sign-in lockout must never suppress the email that resolves it."""

    def test_a_login_lockout_does_not_throttle_recovery(
        self, client, seeded_db, clock, monkeypatch
    ):
        sent = []
        monkeypatch.setattr(
            "app.services.email.send_password_reset",
            lambda *a, **k: sent.append(a),
        )
        _fail_login(client, ip="10.0.6.1")
        assert _login(client, ip="10.0.6.1").status_code == 401

        resp = _forgot(client, ip="10.0.6.1")
        assert resp.status_code == 200
        assert "Retry-After" not in resp.headers
        assert len(sent) == 1

    def test_recovery_traffic_does_not_throttle_login(self, client, seeded_db, clock):
        for _ in range(THRESHOLD * 2):
            _forgot(client, ip="10.0.6.2")
        assert _login(client, ip="10.0.6.2").status_code == 200


class TestResetPasswordThrottle:
    def test_bad_tokens_lock_out_with_429(self, client, seeded_db, clock):
        for _ in range(THRESHOLD):
            assert _reset(client, ip="10.0.7.1").status_code == 400
        locked = _reset(client, ip="10.0.7.1")
        assert locked.status_code == 429
        assert locked.headers["Retry-After"] == str(rate_limit.BASE_LOCK_SECONDS)

    def test_fast_forward_unlocks(self, client, seeded_db, clock):
        for _ in range(THRESHOLD + 1):
            _reset(client, ip="10.0.7.2")
        clock.advance(rate_limit.BASE_LOCK_SECONDS)
        assert _reset(client, ip="10.0.7.2").status_code == 400

    def test_a_valid_reset_clears_the_login_lockout(self, client, db, seeded_db, clock):
        """Forgetting your password is exactly what locks you out, so the reset
        flow has to be the way BACK IN — not a new password you still can't use
        for fifteen minutes."""
        from app.services.auth_service import create_reset_token

        user = seeded_db["admin_user"]
        token = create_reset_token(str(user.id), user.password_hash)

        _fail_login(client, ip="10.0.8.1")
        assert _login(client, ip="10.0.8.1").status_code == 401

        assert _reset(client, token=token, password="Newpass99!", ip="10.0.8.1").status_code == 200
        resp = _login(client, password="Newpass99!", ip="10.0.8.1")
        assert resp.status_code == 200
