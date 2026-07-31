"""In-process rate limiting for the credential endpoints (P1 auth overhaul).

This is the whole rate-limiting story for the API — there was none before, so
this module is deliberately small, dependency-free and self-contained rather
than a framework.

**Multi-worker caveat (read this before scaling out).** The counters live in a
plain dict in THIS process. The API runs a single uvicorn worker today, so the
limiter sees every attempt; run N workers (or N containers behind the load
balancer) and each gets its own counters, so the effective threshold multiplies
by N. That is a soft failure — the limiter still bounds a brute-force run to
``N x threshold`` attempts per window, which is worlds better than unbounded —
but the moment a second worker appears this wants to move to a shared store
(Redis) or a limiter at the edge (nginx ``limit_req``). Nothing else in the
codebase assumes a single worker; this module does.

Design notes:

* **Two key namespaces, deliberately separate.** ``login:*`` counts failed
  sign-ins; ``recovery:*`` counts password-recovery traffic. They must NOT
  share a bucket: the most ordinary user flow on earth is "fumble the password
  a few times, then click Forgot password", and folding the two together would
  let the login lockout swallow the very email that resolves it.

* **Per-IP AND per-account.** An attacker spraying one address from a botnet is
  caught by the per-account key; one host walking a list of addresses is caught
  by the per-IP key. The cost is that a third party can lock a known address out
  for up to 15 minutes by failing 5 logins against it (a targeted nuisance, not
  an account takeover) — the accepted trade for stopping credential stuffing at
  this scale. The account key is only ever touched by endpoints that ALREADY
  record a failure for a non-existent account too, so it can never become an
  account-existence oracle (see auth.login).

* **Escalating backoff.** ``threshold`` failures arm a lock; every subsequent
  lock on the same key doubles, capped at ``max_lock_seconds``. A success on the
  key clears it outright, and a key that goes quiet for ``decay_seconds``
  forgets both its failures and its escalation level.

* **Monotonic clock behind a ``_now()`` seam.** Tests fast-forward by
  monkeypatching this module's ``_now``; nothing here reads the wall clock, so
  an NTP step can neither extend nor cancel a lock.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass

from fastapi import Request

# ── Policy ──────────────────────────────────────────────────────────────────
# 5 failures arm a 60s lock, doubling per lock (60 / 120 / 240 / 480) up to a
# 15 minute ceiling. A key untouched for 15 minutes forgets everything.
FAILURE_THRESHOLD = 5
BASE_LOCK_SECONDS = 60
MAX_LOCK_SECONDS = 15 * 60
FAILURE_DECAY_SECONDS = 15 * 60
# Bounds the memory an attacker can make us allocate by rotating keys. Each
# bucket is ~4 small floats, so this ceiling is a few hundred KB.
MAX_TRACKED_KEYS = 8192


def _now() -> float:
    """Current time on a monotonic clock, in seconds.

    THE clock seam: tests monkeypatch this module attribute to fast-forward
    past a lock instead of sleeping through it. Every read of "now" in this
    module goes through here.
    """
    return time.monotonic()


@dataclass
class _Bucket:
    """One key's state. ``lock_level`` survives the lock expiring — that is
    what makes the backoff escalate instead of resetting to 60s each time."""

    failures: int = 0
    lock_level: int = 0
    locked_until: float = 0.0
    last_failure_at: float = 0.0


class RateLimiter:
    """Failure counters with escalating lockout, keyed by arbitrary strings.

    Thread-safe: FastAPI runs `def` (non-async) routes in a threadpool, so two
    requests really can land in here at once. The lock is re-entrant because
    the mutating methods report their result through :meth:`retry_after`.
    """

    def __init__(
        self,
        *,
        threshold: int = FAILURE_THRESHOLD,
        base_lock_seconds: int = BASE_LOCK_SECONDS,
        max_lock_seconds: int = MAX_LOCK_SECONDS,
        decay_seconds: int = FAILURE_DECAY_SECONDS,
        max_keys: int = MAX_TRACKED_KEYS,
    ) -> None:
        self._threshold = threshold
        self._base_lock_seconds = base_lock_seconds
        self._max_lock_seconds = max_lock_seconds
        self._decay_seconds = decay_seconds
        self._max_keys = max_keys
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.RLock()

    # ── Query ───────────────────────────────────────────────────────────────
    def retry_after(self, *keys: str | None) -> int:
        """Whole seconds left on the LONGEST active lock across ``keys``.

        ``0`` means "not locked" — callers branch on truthiness, so an active
        lock always rounds UP to at least 1 (a lock with 0.4s left must never
        read as open).
        """
        now = _now()
        remaining = 0.0
        with self._lock:
            for key in keys:
                if not key:
                    continue
                bucket = self._buckets.get(key)
                if bucket is None:
                    continue
                remaining = max(remaining, bucket.locked_until - now)
        return math.ceil(remaining) if remaining > 0 else 0

    # ── Mutate ──────────────────────────────────────────────────────────────
    def record_failure(self, *keys: str | None) -> int:
        """Count one failed attempt against every key; return the new
        :meth:`retry_after`.

        Each key is scored independently — the per-IP key can be one failure
        from a lock while the per-account key is fresh.
        """
        now = _now()
        with self._lock:
            self._prune(now)
            for key in keys:
                if not key:
                    continue
                bucket = self._buckets.get(key)
                if bucket is None:
                    if len(self._buckets) >= self._max_keys:
                        # Table full of live locks: skip tracking this key
                        # rather than evict someone else's active lockout,
                        # which would be a bypass. Bounded by _prune above.
                        continue
                    bucket = _Bucket()
                    self._buckets[key] = bucket
                # A quiet key forgets its history — failures AND escalation.
                # Only once it is genuinely unlocked, so a long lock whose
                # start is older than the decay window can't self-cancel.
                if (
                    bucket.last_failure_at
                    and now >= bucket.locked_until
                    and now - bucket.last_failure_at > self._decay_seconds
                ):
                    bucket.failures = 0
                    bucket.lock_level = 0
                bucket.last_failure_at = now
                bucket.failures += 1
                if bucket.failures >= self._threshold:
                    delay = min(
                        self._base_lock_seconds * (2**bucket.lock_level),
                        self._max_lock_seconds,
                    )
                    bucket.failures = 0
                    bucket.lock_level += 1
                    bucket.locked_until = now + delay
        return self.retry_after(*keys)

    def clear(self, *keys: str | None) -> None:
        """Forget every counter for these keys — what a SUCCESS calls."""
        with self._lock:
            for key in keys:
                if key:
                    self._buckets.pop(key, None)

    def reset(self) -> None:
        """Drop all state. Test seam (an autouse fixture calls it per test) —
        never call this from request-handling code."""
        with self._lock:
            self._buckets.clear()

    # ── Internals ───────────────────────────────────────────────────────────
    def _prune(self, now: float) -> None:
        """Evict dead buckets once the table reaches its ceiling.

        Only expired-AND-decayed buckets go: an active lock is never evicted,
        so flooding the table with fresh keys cannot wash out a lockout.
        Caller must hold the lock.
        """
        if len(self._buckets) < self._max_keys:
            return
        dead = [
            key
            for key, bucket in self._buckets.items()
            if now >= bucket.locked_until and now - bucket.last_failure_at > self._decay_seconds
        ]
        for key in dead:
            del self._buckets[key]


# THE shared instance. One limiter, two key namespaces (below) — so a lockout
# in one namespace is visible to every endpoint that consults it, and the two
# namespaces stay independent.
limiter = RateLimiter()


# ── Keys ────────────────────────────────────────────────────────────────────
def client_ip(request: Request) -> str:
    """Best-known client address.

    ``request.client.host`` is already the real client IP in production:
    uvicorn's ProxyHeadersMiddleware (app.main, trusted_hosts="*") rewrites it
    from nginx's ``X-Forwarded-For``. ``request.client`` can be None on exotic
    ASGI transports, so fall back to a constant — sharing one bucket is the
    safe direction (throttled together) versus no bucket at all.
    """
    client = request.client
    host = client.host if client is not None else None
    return host or "unknown"


def login_ip_key(request: Request) -> str:
    return f"login:ip:{client_ip(request)}"


def login_email_key(email: str | None) -> str | None:
    """Per-account login key, normalized exactly like the login lookup
    (``strip().lower()``) so casing/whitespace can't mint a fresh bucket.
    Returns None for an empty address — there is no account to key on, and the
    per-IP key still covers the attempt."""
    normalized = (email or "").strip().lower()
    return f"login:email:{normalized}" if normalized else None


def recovery_ip_key(request: Request) -> str:
    return f"recovery:ip:{client_ip(request)}"


def recovery_identifier_key(identifier: str | None) -> str | None:
    """Per-target recovery key. The identifier may be an email OR a username
    (``/forgot-password`` accepts both), and is normalized the same way the
    lookup normalizes it."""
    normalized = (identifier or "").strip().lower()
    return f"recovery:id:{normalized}" if normalized else None
