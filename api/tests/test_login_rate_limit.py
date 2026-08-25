"""Login + recovery rate limiting (Task 5, P1 auth overhaul).

The API had NO rate limiting before this; ``app.services.rate_limit`` is the
whole story. Six contracts are asserted here:

1. **It actually locks.** Five failures arm a lock; further locks on the same
   key double, capped at 15 minutes; the key forgets everything after a
   success or a quiet decay window.
2. **A lockout is not an oracle.** A locked-out attempt returns the byte-identical
   generic 401 a wrong password returns — only a ``Retry-After`` header differs,
   and that header is armed by the CALLER's own volume, identically for an
   address that has no account. Asserted on BOTH lockout branches (per-IP, in
   the dependency; per-account, inside the route) by full response equality —
   status, body AND header set — against a plain wrong-password answer.
3. **Blast radius is bounded.** Keys are per-IP AND per-account, so one host's
   lockout never touches another's, and the ``login:*`` / ``recovery:*``
   namespaces are separate so a sign-in lockout can never suppress the password
   reset email that resolves it.
4. **The IP key is not attacker-controlled.** The address is taken from a hop
   nginx wrote, so a forged ``X-Forwarded-For`` can neither mint a virgin
   bucket (bypass) nor arm a lockout against a stranger (remote DoS).
5. **The recovery-by-identifier cooldown never escalates.** That key is named by
   the CALLER, so a doubling backoff on it is a third-party denial of password
   recovery. It re-arms the same flat 60s every time.
6. (Retired, alembic 044: ``POST /auth/demo`` used to honor an existing
   login lockout (no back door) but never escalates one, and clicking it all
   day never locks a prospect out.

Time is fast-forwarded through the ``rate_limit._now`` seam — no test sleeps.
The client IP is steered with ``X-Real-IP``, which is what nginx sets from
``$remote_addr`` (``proxy_set_header`` REPLACES any client-sent copy) in every
``/api/`` location of both nginx configs — i.e. the header the limiter trusts.
``X-Forwarded-For`` appears here only as the attacker's tool: it is
caller-supplied and nginx merely APPENDS to it.
"""

import bcrypt
import pytest
from starlette.requests import Request as StarletteRequest

from app.config import settings
from app.models import User
from app.services import rate_limit
from app.services.rate_limit import RateLimiter, client_ip

ADMIN_EMAIL = "admin@test.example"
ADMIN_PASSWORD = "testpass123"
WRONG_PASSWORD = "not-the-password"
THRESHOLD = rate_limit.FAILURE_THRESHOLD

GENERIC_401 = {"detail": "Invalid credentials"}

# Headers a response may legitimately differ on without leaking anything about
# an account: Retry-After is armed by the caller's own volume, the rest are
# transport noise.
_VOLATILE_HEADERS = {"retry-after", "date", "server"}


def _fingerprint(resp):
    """Everything a caller can observe EXCEPT the advisory delay — status, body
    and the full header set. Two responses with equal fingerprints are
    indistinguishable, which is the anti-enumeration contract."""
    return (
        resp.status_code,
        resp.json(),
        {k.lower(): v for k, v in resp.headers.items() if k.lower() not in _VOLATILE_HEADERS},
    )


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


def _headers(ip=None, forged_forwarded_for=None):
    """Request headers. ``ip`` goes in X-Real-IP (the hop nginx writes and the
    limiter trusts); ``forged_forwarded_for`` is the caller-supplied header an
    attacker would use to try to move their own bucket."""
    headers = {}
    if ip:
        headers["X-Real-IP"] = ip
    if forged_forwarded_for:
        headers["X-Forwarded-For"] = forged_forwarded_for
    return headers or None


def _login(client, *, email=ADMIN_EMAIL, password=ADMIN_PASSWORD, ip=None, forged=None):
    return client.post(
        "/api/auth/login",
        json={"email": email, "password": password},
        headers=_headers(ip, forged),
    )


def _fail_login(client, *, n=THRESHOLD, email=ADMIN_EMAIL, ip=None, forged=None):
    """Burn n wrong-password attempts; return the last response."""
    resp = None
    for _ in range(n):
        resp = _login(client, email=email, password=WRONG_PASSWORD, ip=ip, forged=forged)
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

    def test_a_full_key_table_still_locks_new_keys(self, clock):
        # Fail-CLOSED when full. The table holds max_keys live-but-unlocked
        # counters and a brand-new address arrives: it must still be tracked
        # (evicting the least-recently-failed UNLOCKED bucket), not silently
        # skipped — skipping is the limiter turning itself off for everyone new
        # exactly while it is under load.
        limiter = RateLimiter(max_keys=8)
        for i in range(8):
            limiter.record_failure(f"filler-{i}")
        for _ in range(THRESHOLD):
            limiter.record_failure("late-arrival")
        assert limiter.retry_after("late-arrival") > 0
        assert len(limiter._buckets) <= 8

    def test_an_active_lock_outranks_a_full_table(self, clock):
        # ...but eviction never touches a LIVE lockout, even when that means
        # refusing to track the newcomer.
        limiter = RateLimiter(max_keys=2)
        for _ in range(THRESHOLD):
            limiter.record_failure("victim-a")
        for _ in range(THRESHOLD):
            limiter.record_failure("victim-b")
        for i in range(50):
            limiter.record_failure(f"flood-{i}")
        assert limiter.retry_after("victim-a") > 0
        assert limiter.retry_after("victim-b") > 0


class TestFlatCooldownNamespace:
    """Keys named by the CALLER must never ride the escalating backoff."""

    def test_a_recovery_identifier_key_never_escalates(self, clock):
        limiter = RateLimiter(flat_prefixes=rate_limit.FLAT_COOLDOWN_PREFIXES)
        key = rate_limit.recovery_identifier_key("victim@test.example")
        seen = []
        for _ in range(6):
            for _ in range(THRESHOLD):
                limiter.record_failure(key)
            seen.append(limiter.retry_after(key))
            clock.advance(seen[-1])
        assert seen == [rate_limit.FLAT_COOLDOWN_SECONDS] * 6

    def test_the_carve_out_is_namespaced_not_global(self, clock):
        # The per-IP recovery key is armed by the caller's OWN volume, so it
        # keeps doubling — that is what makes sustaining the attack expensive.
        limiter = RateLimiter(flat_prefixes=rate_limit.FLAT_COOLDOWN_PREFIXES)
        seen = []
        for _ in range(3):
            for _ in range(THRESHOLD):
                limiter.record_failure("recovery:ip:203.0.113.9")
            seen.append(limiter.retry_after("recovery:ip:203.0.113.9"))
            clock.advance(seen[-1])
        assert seen == [60, 120, 240]

    def test_the_shared_limiter_carries_the_carve_out(self):
        assert rate_limit.RECOVERY_IDENTIFIER_PREFIX in rate_limit.limiter._flat_prefixes
        assert rate_limit.recovery_identifier_key("x@y.example").startswith(
            rate_limit.RECOVERY_IDENTIFIER_PREFIX
        )


class TestWorkerAwareThresholds:
    """The counters are per PROCESS, so the threshold is a per-process share."""

    def test_a_single_worker_is_exact(self):
        assert rate_limit.per_worker_threshold(5, 1) == 5

    def test_it_divides_by_the_worker_count(self):
        assert rate_limit.per_worker_threshold(8, 4) == 2

    def test_it_never_drops_below_two(self):
        # A per-worker threshold of 1 would lock a real user on their first typo.
        assert rate_limit.per_worker_threshold(5, 10) == 2

    def test_it_reads_the_configured_worker_count(self, monkeypatch):
        monkeypatch.setattr(settings, "API_WORKERS", 4)
        assert rate_limit.per_worker_threshold() == 2

    def test_the_shipped_limiter_matches_the_deployed_process_count(self):
        # Whatever docker-compose.prod.yml runs, the live limiter is scaled for
        # it — the module docstring's premise, asserted.
        assert rate_limit.limiter._threshold == rate_limit.per_worker_threshold()
        assert settings.API_WORKERS >= 1


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
        # Byte-identical, not merely "both 401": same body AND same header set.
        assert locked.status_code == 401
        assert locked.json() == GENERIC_401
        assert _fingerprint(locked) == _fingerprint(wrong)
        assert set(locked.headers) - set(wrong.headers) == {"retry-after"}

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
        # all aimed at the same address. Every request here comes from a
        # DIFFERENT host, so no per-IP key ever reaches the threshold and only
        # the per-email key can be answering.
        for i in range(THRESHOLD):
            _login(client, password=WRONG_PASSWORD, ip=f"10.0.1.{i}")
        locked = _login(client, ip="10.0.1.99")
        assert locked.status_code == 401
        # ...and a DIFFERENT account from that fresh host is still fine, which
        # is what proves the fresh host itself is not throttled.
        assert _login(client, email="kennedy_user@test.example", ip="10.0.1.99").status_code == 200

    def test_the_per_account_lockout_is_byte_identical_to_a_wrong_password(
        self, client, seeded_db, clock
    ):
        """The route's own per-email branch (not the per-IP dependency) must be
        indistinguishable from an ordinary miss.

        This is the branch a future "too many attempts, try again in 5 minutes"
        message would land on — and that message would be an
        account-enumeration oracle, because a locked address is by definition
        one somebody has been attacking. Asserting only `status_code == 401`
        here (as this file used to) lets that regression through: a mutant
        returning a different `detail` plus an `X-Lockout-Scope` header stayed
        green across the whole auth suite.
        """
        # A plain wrong password from a clean host — the reference answer.
        baseline = _login(
            client, email="ghost@test.example", password=WRONG_PASSWORD, ip="10.0.1.150"
        )
        # Arm ONLY the per-email key: one failure each from THRESHOLD hosts.
        for i in range(THRESHOLD):
            _login(client, password=WRONG_PASSWORD, ip=f"10.0.1.{100 + i}")
        # Correct password, host that never failed => the per-email lock is the
        # only thing that can refuse this.
        locked = _login(client, ip="10.0.1.199")
        assert locked.status_code == 401
        assert locked.json() == GENERIC_401
        assert _fingerprint(locked) == _fingerprint(baseline)
        assert set(locked.headers) - set(baseline.headers) == {"retry-after"}
        assert locked.headers["Retry-After"] == str(rate_limit.BASE_LOCK_SECONDS)

    def test_one_accounts_lockout_does_not_lock_another(self, client, seeded_db, clock):
        _fail_login(client, email="ghost@test.example", ip="10.0.2.1")
        # Same host is locked (per-IP), but a fresh host reaches the other
        # account normally — the address key stayed clean.
        assert _login(client, email="kennedy_user@test.example", ip="10.0.2.9").status_code == 200

    def test_casing_and_whitespace_share_one_bucket(self, client, seeded_db, clock):
        # The key normalizes like the login lookup does, so retyping the
        # address in caps must not mint a fresh allowance.
        #
        # Every failure comes from a DIFFERENT host on purpose: fire them all
        # from one IP (as this test used to) and the per-IP key locks the
        # account out regardless, so the test passes even with normalization
        # deleted. Here only the email key can reach the threshold.
        spellings = [
            "  ADMIN@TEST.EXAMPLE  ",
            "Admin@Test.Example",
            "ADMIN@test.example",
            " admin@TEST.example",
            "admin@test.EXAMPLE ",
        ]
        assert len(spellings) == THRESHOLD, "one spelling per allowed failure"
        for i, spelling in enumerate(spellings):
            assert (
                _login(
                    client, email=spelling, password=WRONG_PASSWORD, ip=f"10.0.10.{i}"
                ).status_code
                == 401
            )
        # Canonical spelling, correct password, yet another fresh host: refused
        # only if all five variants scored against ONE bucket.
        assert _login(client, ip="10.0.10.99").status_code == 401


def _fake_request(headers=None, client=("203.0.113.7", 4444)):
    """A Request carrying just the bits client_ip() reads."""
    return StarletteRequest(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/login",
            "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
            "client": client,
        }
    )


class TestClientIpIsNotAttackerControlled:
    """The per-IP key must come from a hop WE wrote.

    ProxyHeadersMiddleware runs with trusted_hosts="*", so uvicorn rewrites
    request.client.host from the LEFTMOST X-Forwarded-For entry — and nginx
    APPENDS to that header, so the leftmost entry is a string the caller typed.
    Keying on it made the per-IP limiter both bypassable (a fresh bucket per
    request) and weaponizable (arm a lockout against any address you can name).
    """

    def test_x_real_ip_beats_a_forged_forwarded_for(self):
        request = _fake_request(
            {"X-Real-IP": "198.51.100.4", "X-Forwarded-For": "9.9.9.9, 198.51.100.4"}
        )
        assert client_ip(request) == "198.51.100.4"

    def test_the_rightmost_forwarded_hop_wins(self):
        # nginx appends $remote_addr, so the LAST entry is ours.
        request = _fake_request({"X-Forwarded-For": "9.9.9.9, 10.1.1.1, 198.51.100.5"})
        assert client_ip(request) == "198.51.100.5"

    def test_junk_headers_fall_through_to_the_peer(self):
        request = _fake_request({"X-Real-IP": "not-an-ip"}, client=("198.51.100.6", 1))
        assert client_ip(request) == "198.51.100.6"

    def test_a_missing_client_shares_one_bucket(self):
        assert client_ip(_fake_request(client=None)) == "unknown"

    def test_a_port_suffix_is_stripped(self):
        assert client_ip(_fake_request({"X-Real-IP": "198.51.100.7:44321"})) == "198.51.100.7"
        assert client_ip(_fake_request({"X-Real-IP": "[2001:db8::1]:443"})).startswith("2001:db8:")

    def test_one_host_cannot_mint_buckets_by_respelling_itself(self):
        # v4, v4-mapped-v6 and a case variant are ONE host, so they must be ONE
        # bucket — otherwise each spelling buys a fresh allowance.
        spellings = ["198.51.100.8", "::ffff:198.51.100.8", "::FFFF:198.51.100.8"]
        keys = {client_ip(_fake_request({"X-Real-IP": s})) for s in spellings}
        assert keys == {"198.51.100.8"}

    def test_ipv6_is_keyed_by_its_64(self):
        # A single subscriber gets a /64; keying the full address would hand
        # them 2**64 free buckets.
        same = {
            client_ip(_fake_request({"X-Real-IP": addr}))
            for addr in ("2001:db8:abcd:1::1", "2001:db8:abcd:1::dead:beef")
        }
        assert len(same) == 1
        other = client_ip(_fake_request({"X-Real-IP": "2001:db8:abcd:2::1"}))
        assert other not in same

    def test_a_forged_forwarded_for_cannot_dodge_the_lockout(self, client, seeded_db, clock):
        # Every attempt from ONE host, each with a different spoofed XFF. If the
        # key were taken from X-Forwarded-For's leftmost hop, each request would
        # mint a virgin bucket and nothing would ever lock.
        for i in range(THRESHOLD):
            _login(
                client,
                email="ghost@test.example",
                password=WRONG_PASSWORD,
                ip="203.0.113.20",
                forged=f"10.5.5.{i}",
            )
        blocked = _login(client, ip="203.0.113.20", forged="10.5.5.250")
        assert blocked.status_code == 401
        assert blocked.headers["Retry-After"] == str(rate_limit.BASE_LOCK_SECONDS)

    def test_a_forged_forwarded_for_cannot_lock_a_stranger_out(self, client, seeded_db, clock):
        # Weaponization: the attacker labels their own traffic with the admin's
        # office IP. The admin must be untouched.
        victim = "203.0.113.30"
        for _ in range(THRESHOLD * 2):
            _login(
                client,
                email="ghost@test.example",
                password=WRONG_PASSWORD,
                ip="203.0.113.31",
                forged=victim,
            )
        assert _login(client, ip=victim).status_code == 200


# ── Recovery endpoints ──────────────────────────────────────────────────────


def _forgot(client, identifier=ADMIN_EMAIL, ip=None):
    return client.post(
        "/api/auth/forgot-password", json={"identifier": identifier}, headers=_headers(ip)
    )


def _reset(client, token="not-a-jwt", password="Newpass99!", ip=None):
    return client.post(
        "/api/auth/reset-password",
        json={"token": token, "new_password": password},
        headers=_headers(ip),
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


class TestRecoveryIsNotDenialOfRecovery:
    """A stranger must not be able to hold a real user out of password recovery.

    The identifier key is typed by the CALLER, so on the escalating schedule
    five posts at ``daniel@…`` armed HIS key and every later burst doubled it —
    up to 15 minutes — while the flagged admins' ONLY way back into their
    account is forgot-password → reset-password. Flat cooldown: the worst a
    stranger can do is delay the mail by one cooldown.
    """

    def test_a_stranger_cannot_escalate_a_victims_recovery_lockout(
        self, client, seeded_db, clock, monkeypatch
    ):
        sent = []
        monkeypatch.setattr(
            "app.services.email.send_password_reset",
            lambda *a, **k: sent.append(a),
        )
        cooldown = rate_limit.FLAT_COOLDOWN_SECONDS
        # Four bursts, each from a fresh attacker host (so the attacker's own
        # escalating per-IP lock never masks what the identifier key is doing).
        for burst in range(4):
            for _ in range(THRESHOLD):
                _forgot(client, identifier=ADMIN_EMAIL, ip=f"203.0.113.{40 + burst}")
            # Probed from yet another host: the delay is the victim's key
            # talking, and it is the SAME every time — never 120, 240, 480...
            probe = _forgot(client, identifier=ADMIN_EMAIL, ip="203.0.113.99")
            assert probe.status_code == 200
            assert probe.json() == {"status": "ok"}
            assert probe.headers["Retry-After"] == str(cooldown)
            clock.advance(cooldown)

        # ...and one cooldown after the last burst the victim's own request
        # really does send mail. Under the escalating schedule the lock would
        # be 8 minutes here and this would be silence.
        before = len(sent)
        assert _forgot(client, identifier=ADMIN_EMAIL, ip="198.51.100.20").status_code == 200
        assert len(sent) == before + 1

    def test_the_attackers_own_host_still_escalates(self, client, seeded_db, clock):
        # The volume-based half of the throttle is untouched: whoever is
        # actually sending the traffic gets the doubling backoff.
        attacker = "203.0.113.50"
        for _ in range(THRESHOLD):
            _forgot(client, identifier="ghost@test.example", ip=attacker)
        assert _forgot(client, identifier="ghost@test.example", ip=attacker).headers[
            "Retry-After"
        ] == str(rate_limit.BASE_LOCK_SECONDS)
        clock.advance(rate_limit.BASE_LOCK_SECONDS)
        for _ in range(THRESHOLD):
            _forgot(client, identifier="other@test.example", ip=attacker)
        assert _forgot(client, identifier="third@test.example", ip=attacker).headers[
            "Retry-After"
        ] == str(rate_limit.BASE_LOCK_SECONDS * 2)


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
