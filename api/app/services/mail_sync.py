"""P3 credential push-sync — one password opens the site and the mailbox.

Design (``docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md``,
phase P3, decided — not re-litigated here): at every password-set moment the
SITE holds the plaintext. It derives the SHA512-crypt hash *here* and POSTs
``{email, hash}`` to a small authenticated endpoint on the mail box, which
rewrites that account's line in ``postfix-accounts.cf`` and reloads.

Two properties that shape every line below:

* **Plaintext never leaves the web box.** Only the derived hash crosses the
  wire, so a compromised mail box (the internet-facing half of the estate)
  yields the same verifier an attacker would get by reading its own Dovecot
  config — nothing more. The receiver refuses anything that isn't a ``$6$``
  hash, so this cannot be quietly downgraded from the calling side either.
* **The mail box gets no database path.** It never queries Postgres and holds
  no DB credential; the site pushes, the mail box only ever receives.

**A sync failure must never fail the user's password change.** The site is the
source of truth: the password IS changed, and the mail box is behind. That
state is recorded on ``users.mail_sync_pending`` (alembic 023) and retried on
the user's next successful login — the one other moment the plaintext is
legitimately in memory. Silent drift (site and mail disagreeing with nobody
knowing) is the specific failure this module exists to prevent, so every path
here either syncs, or marks the row.

Disabled by default: with ``MAIL_SYNC_URL``/``MAIL_SYNC_SECRET`` unset every
entry point is a no-op that returns ``None`` and touches nothing. A missing URL
must never raise — dev boxes, the test suite and the site as it runs today all
have no mail box, and none of them may lose the ability to change a password
because of it.
"""

import logging
import time

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import User
from app.services.sha512_crypt import sha512_crypt

logger = logging.getLogger(__name__)

# The receiver's one route (mail/sync-receiver/mail_sync_receiver.py). Kept
# here rather than folded into MAIL_SYNC_URL so the operator configures a plain
# origin ("https://mail.circuitcenter.ai:8825") and the path can never be
# mistyped into a 404 that looks like an outage.
SYNC_PATH = "/sync-password"

# Per-process, per-address cooldown for the LOGIN retry only (see
# retry_pending_sync). Without it, a mail box that is down makes EVERY login by
# a pending user wait out the full HTTP timeout — turning "mail is behind" into
# "the console feels broken". The password-set paths never consult it: those
# must always attempt, because they are the moment the drift is created.
_last_failure_at: dict[str, float] = {}


def _normalize(email: str | None) -> str:
    return (email or "").strip().lower()


def is_configured() -> bool:
    """True when both halves of the channel are set. Either alone is useless —
    a URL without a secret would POST unauthenticated, a secret without a URL
    has nowhere to go."""
    return bool(
        (settings.MAIL_SYNC_URL or "").strip() and (settings.MAIL_SYNC_SECRET or "").strip()
    )


def has_mailbox(email: str | None) -> bool:
    """True when this address is one of the real mailboxes.

    ``demo@circuitcenter.ai`` is a login identity with NO mailbox (design, P2),
    and a password reset on it must not park the row in a pending state that
    can never clear — there is nothing on the mail box to sync it to. The list
    is configuration (``MAIL_SYNC_MAILBOXES``) so provisioning a sixth mailbox
    is an .env line, not a redeploy.
    """
    target = _normalize(email)
    return bool(target) and target in {_normalize(m) for m in settings.MAIL_SYNC_MAILBOXES}


def _client() -> httpx.Client:
    """The HTTP client for one push. A function, not a module-level constant, so
    tests can substitute a MockTransport and exercise the real request-building
    code (URL, headers, body) instead of stubbing it out."""
    return httpx.Client(
        timeout=settings.MAIL_SYNC_TIMEOUT,
        verify=settings.MAIL_SYNC_VERIFY_SSL,
    )


def push_password(email: str, plaintext: str) -> bool:
    """Derive the mailbox hash and POST it. True on success, False on failure.

    Never raises — every transport, TLS, timeout and HTTP-status failure is one
    False. Callers turn that into ``mail_sync_pending``.
    """
    url = (settings.MAIL_SYNC_URL or "").strip().rstrip("/") + SYNC_PATH
    address = _normalize(email)
    # Derived HERE. The plaintext argument stops at this line and is never
    # logged, stored, or serialized.
    hashed = sha512_crypt(plaintext)
    try:
        with _client() as client:
            response = client.post(
                url,
                json={"email": address, "hash": hashed},
                headers={
                    "Authorization": f"Bearer {settings.MAIL_SYNC_SECRET}",
                    # Lets the receiver's log say which deploy called it without
                    # any per-request identity to manage.
                    "User-Agent": "circuitcenter-mail-sync/1",
                },
            )
    except Exception as exc:  # noqa: BLE001 - a mail box outage is not a 500 here
        # repr(exc), not the response body: an error page from something in
        # front of the receiver could echo the request back, and this log line
        # goes to container stdout.
        logger.warning("mail-sync: push failed for %s (%r)", address, exc)
        return False
    if response.status_code != 200:
        logger.warning(
            "mail-sync: %s rejected for %s (HTTP %s)", url, address, response.status_code
        )
        return False
    return True


def sync_user_password(db: Session, user: User, plaintext: str) -> bool | None:
    """Push this user's new password to the mail box and record the outcome.

    Returns True (synced), False (failed — row marked pending) or None (nothing
    to do: the channel is unconfigured, or this account has no mailbox).

    Call AFTER the password change is committed. The site's write is the one
    that must not be lost; this is best-effort catch-up on top of it.
    """
    if not is_configured():
        # Leave the flag exactly as it is. A row marked pending while the
        # channel was live is still genuinely out of sync after someone
        # unsets the URL — clearing it here would erase real drift.
        return None

    address = _normalize(user.email)
    if not has_mailbox(address):
        # Definitively nothing to sync, so the flag must be OFF: an account
        # with no mailbox can never "catch up", and a stuck flag would make the
        # drift signal cry wolf forever.
        _set_pending(db, user, False)
        return None

    ok = push_password(address, plaintext)
    if ok:
        _last_failure_at.pop(address, None)
    else:
        _last_failure_at[address] = time.monotonic()
    _set_pending(db, user, not ok)
    return ok


def retry_pending_sync(db: Session, user: User, plaintext: str) -> bool | None:
    """Self-heal on login: re-push a password whose earlier sync failed.

    Login is the one other moment the site legitimately holds the plaintext, so
    it is where drift resolves itself without anyone typing a password twice.
    Only flagged rows are touched, and a recently-failed address is skipped for
    ``MAIL_SYNC_RETRY_COOLDOWN`` seconds so a mail box that is down cannot add
    the HTTP timeout to every sign-in.
    """
    if not bool(user.mail_sync_pending) or not is_configured():
        return None
    address = _normalize(user.email)
    last_failure = _last_failure_at.get(address)
    if last_failure is not None:
        elapsed = time.monotonic() - last_failure
        if elapsed < settings.MAIL_SYNC_RETRY_COOLDOWN:
            return None
    return sync_user_password(db, user, plaintext)


def _set_pending(db: Session, user: User, pending: bool) -> None:
    """Write the drift flag, committing only on an actual change.

    Wrapped in its own try/except: this runs after the password commit, so a
    failure to record the flag must not surface as a 500 on a password change
    that already succeeded. Worst case the flag is stale, which the next login
    or password change re-evaluates.
    """
    if bool(user.mail_sync_pending) == pending:
        return
    try:
        user.mail_sync_pending = pending
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("mail-sync: could not record pending=%s (%r)", pending, exc)
        db.rollback()


def reset_retry_state() -> None:
    """Clear the per-process cooldown map. For tests (and any future admin
    "retry now" action) — the cooldown is an optimization, never a contract."""
    _last_failure_at.clear()
