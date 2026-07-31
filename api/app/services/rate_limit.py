"""In-process rate limiting for the credential endpoints (P1 auth overhaul).

This is the whole rate-limiting story for the API — there was none before, so
this module is deliberately small, dependency-free and self-contained rather
than a framework.

**What this actually protects in production (read before changing the worker
count).** The counters live in a plain dict in THIS process, so the limiter is
exactly as strong as the deployment is single-process. That is not an
aspiration — it is a coupling: ``docker-compose.prod.yml`` pins
``uvicorn ... --workers ${API_WORKERS:-1}`` and feeds the SAME interpolation in
as the ``API_WORKERS`` env var, so the process count the container runs and the
number this module reads cannot drift. With one worker every number below is
literal: 5 failures lock, a success or a completed reset really does clear the
key. Raise ``API_WORKERS`` and three things change, only the first of which is
compensated for:

1. Each worker keeps its own counters, so the aggregate threshold would
   multiply by N — :func:`per_worker_threshold` divides it back down (floored at
   2, so a legitimate typo is never one strike from a lock).
2. Locks are per worker and the OS spreads connections, so an attacker still
   meets a lock later than a single-process deployment would, and the unlocks
   are staggered rather than simultaneous.
3. :meth:`RateLimiter.clear` — what a successful login or a completed password
   reset calls — heals only the worker that served that request. The user can
   still meet a leftover lock on a sibling worker until it expires on its own.

No in-process test can catch (2) or (3); they are properties of the deployment,
not of this code. If the site ever needs real concurrency, move the throttle to
the edge (nginx ``limit_req`` on ``location /api/auth/``) or to a shared store —
do not simply raise the worker count and assume the numbers below still hold.

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

* **Escalating backoff, EXCEPT where escalation is a weapon.** ``threshold``
  failures arm a lock; every subsequent lock on the same key doubles, capped at
  ``max_lock_seconds``. A success on the key clears it outright, and a key that
  goes quiet for ``decay_seconds`` forgets both its failures and its escalation
  level. Keys under :data:`FLAT_COOLDOWN_PREFIXES` opt OUT of the doubling —
  see :data:`RECOVERY_IDENTIFIER_PREFIX`.

* **The IP key is derived from a hop WE control.** See :func:`client_ip`: the
  address is read from ``X-Real-IP`` (nginx overwrites it with ``$remote_addr``)
  or the rightmost ``X-Forwarded-For`` hop, never from anything the caller can
  choose. A limiter keyed on an attacker-supplied string is worse than none: it
  is bypassable AND it lets a stranger lock out any address they can name.

* **Monotonic clock behind a ``_now()`` seam.** Tests fast-forward by
  monkeypatching this module's ``_now``; nothing here reads the wall clock, so
  an NTP step can neither extend nor cancel a lock.
"""

from __future__ import annotations

import ipaddress
import math
import threading
import time
from dataclasses import dataclass

from fastapi import Request

from app.config import settings

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

# ── Flat-cooldown namespace ─────────────────────────────────────────────────
# The per-identifier recovery key is typed by the CALLER — "send a reset link to
# daniel@…" — so whoever it locks is not necessarily whoever armed it. Left on
# the escalating schedule it is a third-party denial of password recovery: five
# posts arm the victim's key, and because each subsequent lock doubles (to a 15
# minute ceiling) a single host can keep a real user out of the ONLY route back
# into a flagged account. So identifier keys get a FLAT cooldown that never
# doubles: it still bounds mail to one inbox (which is the entire point of
# throttling this endpoint), but the worst a stranger can do is delay a victim's
# reset email by one minute at a time. Escalation stays on the per-IP key, which
# is armed by the caller's OWN volume — a sustained attack throttles the
# attacker's host long before it inconveniences the victim.
RECOVERY_IDENTIFIER_PREFIX = "recovery:id:"
FLAT_COOLDOWN_PREFIXES = (RECOVERY_IDENTIFIER_PREFIX,)
FLAT_COOLDOWN_SECONDS = BASE_LOCK_SECONDS

# IPv6 is handed out in enormous per-customer blocks, so keying on the full
# address would let one subscriber mint 2**64 buckets (evading the limiter AND
# flooding the key table). Key on the /64 network instead — the smallest unit
# that is normally ONE customer. IPv4 is keyed on the exact address.
IPV6_KEY_PREFIXLEN = 64


def per_worker_threshold(threshold: int = FAILURE_THRESHOLD, workers: int | None = None) -> int:
    """Failures-per-PROCESS that add up to roughly ``threshold`` site-wide.

    Counters are per process (see the module docstring), so N workers would
    otherwise mean N x threshold attempts before anything locks. Floored at 2 —
    a threshold of 1 would lock a real user on their first typo, which is a
    worse bug than a slightly loose limit.
    """
    if workers is None:
        workers = settings.API_WORKERS
    if workers <= 1:
        return threshold
    return max(2, math.ceil(threshold / workers))


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
        threshold: int | None = None,
        base_lock_seconds: int = BASE_LOCK_SECONDS,
        max_lock_seconds: int = MAX_LOCK_SECONDS,
        decay_seconds: int = FAILURE_DECAY_SECONDS,
        max_keys: int = MAX_TRACKED_KEYS,
        flat_prefixes: tuple[str, ...] = (),
        flat_lock_seconds: int = FLAT_COOLDOWN_SECONDS,
    ) -> None:
        self._threshold = FAILURE_THRESHOLD if threshold is None else threshold
        self._base_lock_seconds = base_lock_seconds
        self._max_lock_seconds = max_lock_seconds
        self._decay_seconds = decay_seconds
        self._max_keys = max_keys
        self._flat_prefixes = flat_prefixes
        self._flat_lock_seconds = flat_lock_seconds
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
            for key in keys:
                if not key:
                    continue
                bucket = self._buckets.get(key)
                if bucket is None:
                    bucket = self._new_bucket(key, now)
                    if bucket is None:
                        # Table full of live locks and nothing evictable: skip
                        # tracking rather than evict an active lockout, which
                        # would be a bypass. See _make_room.
                        continue
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
                    bucket.failures = 0
                    if self._is_flat(key):
                        # Flat namespace: same cooldown every time, forever.
                        # lock_level is deliberately NOT advanced.
                        bucket.locked_until = now + self._flat_lock_seconds
                    else:
                        delay = min(
                            self._base_lock_seconds * (2**bucket.lock_level),
                            self._max_lock_seconds,
                        )
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
    def _is_flat(self, key: str) -> bool:
        """Does this key opt out of escalating backoff? (see
        :data:`FLAT_COOLDOWN_PREFIXES`)."""
        return any(key.startswith(prefix) for prefix in self._flat_prefixes)

    def _new_bucket(self, key: str, now: float) -> _Bucket | None:
        """Allocate a bucket for ``key``, making room if the table is full.

        Returns None only when every tracked key holds an ACTIVE lock — the one
        case where admitting the new key would mean evicting a live lockout.
        Caller must hold the lock.
        """
        if len(self._buckets) >= self._max_keys and not self._make_room(now):
            return None
        bucket = _Bucket()
        self._buckets[key] = bucket
        return bucket

    def _make_room(self, now: float) -> bool:
        """Free at least one slot; report whether anything was evicted.

        Two passes, in order of how little we lose:

        1. Dead buckets (unlocked AND past the decay window) — they carry no
           information at all.
        2. Failing that, the least-recently-failed UNLOCKED bucket. It loses a
           partial failure count, never an active lockout. This is the branch
           that keeps the limiter fail-CLOSED: the old code skipped tracking
           new keys once the table filled, which silently turned the limiter
           OFF for every new address while the table stayed full.

        An active lock is never evicted, so flooding the table with fresh keys
        still cannot wash out a lockout. Caller must hold the lock.
        """
        dead = [
            key
            for key, bucket in self._buckets.items()
            if now >= bucket.locked_until and now - bucket.last_failure_at > self._decay_seconds
        ]
        if dead:
            for key in dead:
                del self._buckets[key]
            return True
        unlocked = [
            (bucket.last_failure_at, key)
            for key, bucket in self._buckets.items()
            if now >= bucket.locked_until
        ]
        if not unlocked:
            return False
        del self._buckets[min(unlocked)[1]]
        return True


# THE shared instance. One limiter, two key namespaces (below) — so a lockout
# in one namespace is visible to every endpoint that consults it, and the two
# namespaces stay independent. Its threshold is the per-PROCESS share of
# FAILURE_THRESHOLD (see per_worker_threshold + the module docstring).
limiter = RateLimiter(
    threshold=per_worker_threshold(),
    flat_prefixes=FLAT_COOLDOWN_PREFIXES,
)


# ── Keys ────────────────────────────────────────────────────────────────────
def _normalize_ip(raw: str | None) -> str | None:
    """Parse one hop into a canonical bucket key, or None if it isn't an IP.

    Canonicalizing matters as much as parsing: ``1.2.3.4``, ``::ffff:1.2.3.4``
    and ``::FFFF:1.2.3.4`` are the same host, and if each minted its own bucket
    an attacker would get a fresh allowance per spelling. IPv6 collapses to its
    /64 network (see :data:`IPV6_KEY_PREFIXLEN`).
    """
    if not raw:
        return None
    host = raw.strip()
    if host.startswith("["):  # [2001:db8::1]:443
        host = host[1:].partition("]")[0]
    elif host.count(":") == 1:  # 1.2.3.4:443 — a lone colon is never IPv6
        host = host.partition(":")[0]
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address):
        mapped = address.ipv4_mapped
        if mapped is not None:
            return str(mapped)
        return str(ipaddress.ip_network(f"{address}/{IPV6_KEY_PREFIXLEN}", strict=False))
    return str(address)


def client_ip(request: Request) -> str:
    """The address the EDGE observed — never one the caller chose.

    ``request.client.host`` is NOT safe to key on here. ProxyHeadersMiddleware
    is mounted with ``trusted_hosts="*"`` (app.main), so uvicorn overwrites
    ``scope["client"]`` with the LEFTMOST ``X-Forwarded-For`` hop — and nginx
    APPENDS ``$remote_addr`` to whatever the client sent
    (``$proxy_add_x_forwarded_for``), so the leftmost hop is literally a string
    the attacker typed. Keying on it would let one host mint a virgin bucket per
    request (unlimited credential spraying) AND arm a lockout against any
    address it can name (remote DoS on a real admin).

    So, in order:

    1. ``X-Real-IP`` — nginx sets it from ``$remote_addr`` with
       ``proxy_set_header``, which REPLACES any client-sent copy, in every
       ``/api/`` location of both nginx.conf and nginx.ssl.conf.
    2. The RIGHTMOST ``X-Forwarded-For`` hop — the one our own proxy appended.
       Everything to its left is caller-supplied.
    3. ``request.client.host`` — direct, unproxied connections (local dev,
       tests). ``request.client`` can be None on exotic ASGI transports, so
       fall back to a constant: sharing one bucket is the safe direction
       (throttled together) versus no bucket at all.

    This trusts exactly one proxy hop, which is what the deployment has. It
    assumes the api port is reachable only through nginx — hence
    ``ports: !reset []`` on the api service in docker-compose.prod.yml; publish
    8000 to the internet again and both headers become forgeable.
    """
    for header in ("x-real-ip", "x-forwarded-for"):
        raw = request.headers.get(header)
        if not raw:
            continue
        candidate = _normalize_ip(raw.rsplit(",", 1)[-1])
        if candidate:
            return candidate
    client = request.client
    host = client.host if client is not None else None
    return _normalize_ip(host) or host or "unknown"


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
    lookup normalizes it.

    Lives in the FLAT-cooldown namespace (:data:`RECOVERY_IDENTIFIER_PREFIX`):
    whoever this key locks is whoever the CALLER named, so it must never reach
    the escalating ceiling.
    """
    normalized = (identifier or "").strip().lower()
    return f"{RECOVERY_IDENTIFIER_PREFIX}{normalized}" if normalized else None
