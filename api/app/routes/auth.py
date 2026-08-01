import uuid as uuid_mod
from datetime import UTC, datetime

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import User
from app.services import email as email_service
from app.services import mail_sync
from app.services.auth_service import (
    DEMO_READ_ONLY_DETAIL,
    REMEMBER_EXPIRY_HOURS,
    TOKEN_EXPIRY_HOURS,
    create_reset_token,
    create_token,
    decode_reset_token,
    demo_login_email,
    get_authenticated_user,
    hash_password,
    is_demo_user,
    reset_token_matches_hash,
    verify_dummy_password,
    verify_password,
)
from app.services.password_policy import PASSWORD_HELP, validate_password
from app.services.rate_limit import (
    client_ip,
    limiter,
    login_email_key,
    login_ip_key,
    recovery_identifier_key,
    recovery_ip_key,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Recovery endpoints always return this, whether or not an account matched, so a
# caller can't probe which usernames/emails exist (anti-enumeration).
GENERIC_OK = {"status": "ok"}

# THE one wrong-credentials body. A locked-out attempt raises the very same
# thing (only a Retry-After header differs), so the rate limiter can never be
# read as "this account exists / this password was nearly right".
INVALID_CREDENTIALS_DETAIL = "Invalid credentials"


def _invalid_credentials(retry_after: int = 0) -> HTTPException:
    """The generic 401 — identical body for unknown account, wrong password and
    rate-limited. ``Retry-After`` is advisory only and says nothing about any
    account: it is armed by the CALLER's own request volume, whether or not the
    address they typed exists."""
    headers = {"Retry-After": str(retry_after)} if retry_after > 0 else None
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=INVALID_CREDENTIALS_DETAIL,
        headers=headers,
    )


def _login_rate_limit(request: Request) -> None:
    """Per-IP pre-check for the sign-in endpoints (see LOGIN_RATE_LIMIT_DEPENDENCIES).

    IP-only: a body-scoped (per-email) check needs the parsed body, which lives
    in the route. The route adds the per-email key itself, so an attacker
    spraying one address from many hosts is still caught.
    """
    retry_after = limiter.retry_after(login_ip_key(request))
    if retry_after:
        raise _invalid_credentials(retry_after)


# ── Rate-limit seam (task 5) ────────────────────────────────────────────────
# /login and /demo are the two unauthenticated credential-adjacent endpoints and
# MUST carry the SAME limiter. Both declare this ONE list so wiring the limiter
# is a single edit here (append the Depends(...)) instead of two call sites that
# can drift — /demo silently exempt from throttling would be a free oracle for
# hammering the API. FastAPI reads the list when the decorator runs, so task 5
# must populate it above the route definitions (or assign a new list to this
# name BEFORE import completes).
#
# /demo HONORS a login lockout but never escalates one: it takes no credentials,
# so it cannot "fail", and counting the marketing button's clicks would lock a
# prospect out of the demo after five taps. Sharing the check is what stops a
# brute-forcing IP from simply pivoting to /demo for a token.
LOGIN_RATE_LIMIT_DEPENDENCIES: list = [Depends(_login_rate_limit)]


class LoginRequest(BaseModel):
    # The login identifier is the email address, matched case-insensitively on
    # lower(email). There is NO username fallback for anyone — the public demo
    # account included; one-click demo access lives at POST /api/auth/demo.
    email: str
    password: str
    # "Keep me signed in for 30 days" — extends the JWT TTL when checked.
    remember: bool = False


class UserInfo(BaseModel):
    id: str
    username: str
    role: str
    supplier_id: str | None = None
    # Task 8 — the public demo account, signalled by the SERVER so the console
    # never has to infer it from a username or a role it could be lied to about.
    # One flag drives both demo behaviours: the console renders read-only (the
    # 403 `demo_account_read_only` gate in get_current_user is the real
    # enforcement — this is only the front end of it) and DEMO DATA mode is
    # forced on and non-disableable, so a prospect never sees real revenue,
    # customer names or sponsor contacts.
    is_demo: bool = False


class LoginResponse(BaseModel):
    token: str
    user: UserInfo
    # Drives the "set a new password" screen. Task 4's dependency is the real
    # gate (403 password_change_required); this flag is just the front door.
    must_change_password: bool = False


class ForgotPasswordRequest(BaseModel):
    identifier: str  # email OR username


class ResetPasswordRequest(BaseModel):
    token: str
    # No Field(min_length=...) here on purpose: validate_password is the ONE
    # gate, so a too-short password answers with the same structured
    # password_policy 422 as every other rule instead of a stock pydantic
    # array-detail the client can't read.
    new_password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


def _is_demo_identifier(identifier: str) -> bool:
    """True when this identifier addresses the public demo account.

    Reads the ONE definition in auth_service so this and the read-only gate
    cannot disagree about which address is the demo.
    """
    demo_email = demo_login_email()
    return bool(demo_email) and identifier.strip().lower() == demo_email


def _find_login_user(db: Session, identifier: str) -> User | None:
    """Resolve a login identifier to a user, or None.

    Case-insensitive on lower(email) — the same expression the unique index
    covers, so at most one row can ever match. Email is the ONLY login key:
    no username resolves here, for any account.

    The public demo account is NOT reachable through this path at all
    (2026-07-31 owner decision). Its one and only door is `POST /auth/demo`,
    which takes no credentials. Two reasons this matters beyond tidiness:
    the demo password is public, so leaving it usable here would hand an
    attacker a credential that legitimately succeeds — and a success clears
    the rate-limit buckets, i.e. an unlimited lever for resetting a lockout
    they armed themselves. Returning None routes it through the identical
    unknown-account path (dummy hash + generic 401 + counted failure), so
    refusing the demo here leaks nothing about which accounts exist.
    """
    ident = identifier.strip().lower()
    if not ident or _is_demo_identifier(ident):
        return None
    return db.query(User).filter(func.lower(User.email) == ident).first()


def _session_response(user: User, *, expires_hours: int = TOKEN_EXPIRY_HOURS) -> LoginResponse:
    """Mint a session token and wrap it in the one login-shaped payload.

    /login, /demo and /change-password all hand the client the same thing, so
    the client stores a token exactly one way.
    """
    return LoginResponse(
        token=create_token(str(user.id), user.role, expires_hours=expires_hours),
        user=UserInfo(
            id=str(user.id),
            username=user.username,
            role=user.role,
            supplier_id=str(user.supplier_id) if user.supplier_id else None,
            is_demo=is_demo_user(user),
        ),
        # bool(): the column is NOT NULL, but a legacy row read through an
        # older connection could still surface None — `?:`-style optionality
        # must never reach the response model.
        must_change_password=bool(user.must_change_password),
    )


def _record_login(db: Session, user: User, request: Request) -> None:
    """Shift the previous sign-in stamp down and record this one (alembic 024).

    The console shows the PREVIOUS sign-in, not this one: "you signed in four
    seconds ago" is not information, whereas "the session before this came from
    that address at that time" is how somebody notices access that was not
    theirs. So this shifts ``last_* -> prev_*`` before stamping itself, which
    also means a reloaded tab reads the right answer from the database instead
    of depending on what the login response happened to carry.

    The address comes from :func:`client_ip` — ``X-Real-IP``, which nginx
    overwrites with ``$remote_addr`` — and never from the caller-supplied
    ``X-Forwarded-For``. A spoofable stamp would be worse than none at all: it
    would be evidence pointing wherever an attacker decided to point it.

    Best-effort. A failure here must never cost a valid credential its session,
    so the write is rolled back and swallowed rather than 500-ing a sign-in that
    has already succeeded. Not called for the demo account, which is shared and
    public — a "last sign-in" showing a stranger's address would be noise at
    best and a small privacy leak at worst.
    """
    try:
        user.prev_login_at = user.last_login_at
        user.prev_login_ip = user.last_login_ip
        user.last_login_at = datetime.now(UTC)
        user.last_login_ip = client_ip(request)
        db.commit()
    except Exception:  # pragma: no cover - defensive
        db.rollback()


@router.post("/login", response_model=LoginResponse, dependencies=LOGIN_RATE_LIMIT_DEPENDENCIES)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    # Two keys, scored independently: the host (one machine walking a list of
    # addresses) and the address (a botnet spraying one account).
    ip_key = login_ip_key(request)
    email_key = login_email_key(body.email)

    # The per-IP half already ran in the dependency; this covers the per-email
    # half. Returns BEFORE bcrypt: a locked key must not buy the attacker a
    # password check, and burning a hash per blocked request would hand them a
    # CPU-exhaustion lever. The early return leaks nothing an attacker doesn't
    # already know — they armed this lock themselves, and it arms identically
    # for an address that has no account.
    retry_after = limiter.retry_after(email_key)
    if retry_after:
        raise _invalid_credentials(retry_after)

    user = _find_login_user(db, body.email)
    if user is None:
        # Equalize timing with the wrong-password path so a missing account
        # can't be detected by response latency (account enumeration).
        verify_dummy_password()
        # Counted exactly like a wrong password — if only real accounts scored
        # failures, the lockout itself would become an existence oracle.
        raise _invalid_credentials(limiter.record_failure(ip_key, email_key))
    if not verify_password(body.password, user.password_hash):
        raise _invalid_credentials(limiter.record_failure(ip_key, email_key))
    # Success clears both keys: a legitimate user who finally remembers their
    # password is not still one fumble from a lockout.
    limiter.clear(ip_key, email_key)
    # Mailbox drift self-heals HERE (P3). A login is the one moment outside a
    # password change where the site legitimately holds the plaintext, so a
    # push that failed earlier gets a free retry with nobody typing anything
    # twice. No-op unless the row is actually flagged, and rate-limited by a
    # per-address cooldown, so a mail box that is down cannot make every
    # sign-in wait out the HTTP timeout.
    mail_sync.retry_pending_sync(db, user, body.password)
    _record_login(db, user, request)
    expires = REMEMBER_EXPIRY_HOURS if body.remember else TOKEN_EXPIRY_HOURS
    return _session_response(user, expires_hours=expires)


@router.post("/demo", response_model=LoginResponse, dependencies=LOGIN_RATE_LIMIT_DEPENDENCIES)
def demo_login(db: Session = Depends(get_db)):
    """One-click demo access — no body, no credentials, no auth.

    Prospects open the console without a password. The account is resolved
    SERVER-side from settings.DEMO_LOGIN_EMAIL, so the public JS bundle never
    carries a credential and the endpoint can never be coaxed into minting a
    token for some other account (it accepts no input at all).

    404 — not 403 — when disabled or when the demo row is missing: a disabled
    demo should look like a route that was never deployed, and the response
    must not confirm which accounts exist (anti-enumeration).

    The session it hands out is READ-ONLY: ``get_current_user`` answers 403
    ``demo_account_read_only`` to every write from this account (task 8), and
    the payload's ``user.is_demo`` tells the console to mark itself and force
    DEMO DATA on. That is what makes it safe to put this behind a public button.
    """
    if not settings.DEMO_LOGIN_ENABLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    demo_email = (settings.DEMO_LOGIN_EMAIL or "").strip().lower()
    user = (
        db.query(User).filter(func.lower(User.email) == demo_email).first() if demo_email else None
    )
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    # The demo account carries must_change_password = False (seed never flags
    # it; alembic 022 flagged only the named admins), so this token clears the
    # forced-change gate. Reported verbatim rather than forced to False: this
    # unauthenticated endpoint must not be able to clear a security flag.
    return _session_response(user)


@router.post("/change-password", response_model=LoginResponse)
def change_password(
    body: ChangePasswordRequest,
    db: Session = Depends(get_db),
    # get_authenticated_user, NOT get_current_user: this is the way OUT of the
    # forced-change gate, so it must stay reachable by a flagged user.
    current_user: User = Depends(get_authenticated_user),
):
    """Self-service password change — and the only way to clear a forced reset.

    Returns a FRESH token: stamping password_changed_at retires every token
    minted before now (auth_service.token_predates_password_change), so without
    a replacement the caller would log itself out by succeeding.
    """
    # The demo account is read-only here too, even though this endpoint takes
    # the UNgated dependency. It is not a security hole (the demo has no
    # credential login to protect) — it is griefing: the demo password is
    # public, so any visitor could rotate it and, by stamping
    # password_changed_at, instantly sign out every OTHER prospect's live demo
    # session. Nothing is lost by refusing: the account's only door is
    # /auth/demo, which never asks for a password.
    if is_demo_user(current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=DEMO_READ_ONLY_DETAIL,
        )

    if not verify_password(body.current_password, current_user.password_hash):
        # 400, not 401: the session is perfectly valid, one field was wrong.
        # A 401 here would trip the admin client's log-out-on-401 handling and
        # bounce the user to the sign-in screen mid-form.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect.",
        )

    unmet = validate_password(body.new_password)
    if unmet:
        # Structured detail (dict, not str): the admin form ticks its rule
        # checklist off `unmet`. Note `apiErrorDetail` only surfaces STRING
        # details, so the client must read detail.unmet explicitly.
        # Bare 422 (repo convention — see admin_sponsors/admin_expenses): the
        # starlette constant was renamed ..._ENTITY -> ..._CONTENT and emits a
        # DeprecationWarning, so the literal is the version-stable spelling.
        raise HTTPException(
            status_code=422,
            detail={"code": "password_policy", "message": PASSWORD_HELP, "unmet": unmet},
        )

    if verify_password(body.new_password, current_user.password_hash):
        # A forced rotation that accepts the same password is not a rotation.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Your new password must be different from your current password.",
        )

    current_user.password_hash = hash_password(body.new_password)
    current_user.password_changed_at = datetime.now(UTC)
    current_user.must_change_password = False
    db.commit()
    db.refresh(current_user)
    # P3: push the new password to the mailbox — AFTER the commit, on purpose.
    # The site is the source of truth and its write must never be at the mercy
    # of a mail box being up; a failure here only marks mail_sync_pending (and
    # is retried on the next login), it does not undo or 500 the change the
    # user just made successfully.
    mail_sync.sync_user_password(db, current_user, body.new_password)
    # Minted AFTER the stamp so its iat is not older than password_changed_at
    # (the 1s grace absorbs JWT's second-truncation either way).
    return _session_response(current_user)


@router.post("/logout")
def logout():
    return {"status": "ok"}


@router.post("/forgot-password")
def forgot_password(
    body: ForgotPasswordRequest,
    background_tasks: BackgroundTasks,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    """Email a secure reset link if the identifier matches an account with an
    email on file. Always returns GENERIC_OK (anti-enumeration).

    Rate limited in the ``recovery:*`` namespace — deliberately NOT the
    ``login:*`` one. "Fail the password a few times, then click Forgot
    password" is the single most common real user flow there is, and a shared
    bucket would let the login lockout suppress the email that resolves it.

    A throttled request returns the SAME generic OK with no mail sent (plus an
    advisory Retry-After): this endpoint's response is a constant by design, and
    the throttle exists to stop an attacker mail-bombing a victim's inbox — not
    to tell the caller anything.
    """
    ip_key = recovery_ip_key(request)
    identifier_key = recovery_identifier_key(body.identifier)
    retry_after = limiter.retry_after(ip_key, identifier_key)
    if retry_after:
        response.headers["Retry-After"] = str(retry_after)
        return GENERIC_OK
    # Every attempt costs — success included. There is no "correct" answer here
    # to reward, so the send itself is what has to be bounded.
    limiter.record_failure(ip_key, identifier_key)

    identifier = body.identifier.strip()
    if identifier:
        ident_lower = identifier.lower()
        user = (
            db.query(User)
            .filter(
                or_(
                    func.lower(User.username) == ident_lower,
                    func.lower(User.email) == ident_lower,
                )
            )
            .first()
        )
        if user and user.email:
            token = create_reset_token(str(user.id), user.password_hash)
            # The link origin is the trusted, configured APP_BASE_URL — NEVER the
            # request Host header (which ProxyHeadersMiddleware trusts blindly).
            # Building it from the request would let an attacker poison the reset
            # link emailed to a victim. (security review 2026-06-13)
            base = settings.APP_BASE_URL.rstrip("/")
            reset_url = f"{base}/admin/reset-password?token={token}"
            background_tasks.add_task(
                email_service.send_password_reset, user.email, user.username, reset_url
            )
    return GENERIC_OK


@router.post("/reset-password")
def reset_password(body: ResetPasswordRequest, request: Request, db: Session = Depends(get_db)):
    """Set a new password from a valid, unused reset token.

    The new password must satisfy the SAME policy as /change-password (422
    ``password_policy`` listing the unmet rule keys). This route writes a real,
    permanent credential — an unpoliced recovery path would simply be the way
    round the policy — and because it enforces the policy it can also clear
    ``must_change_password``.

    Rate limited per-IP in the ``recovery:*`` namespace so the token itself
    can't be brute-forced. Only REJECTED tokens count, so a user clicking their
    own valid link is never throttled.

    A throttled caller gets 429 — not the generic OK, and not the "link is no
    longer valid" 400. Telling someone their password was reset when it wasn't
    is a lie, and reusing the dead-link copy would send them to request another
    link that would also be throttled. 429 reveals nothing about any account:
    it is armed purely by this caller's own failed attempts.
    """
    ip_key = recovery_ip_key(request)
    retry_after = limiter.retry_after(ip_key)
    if retry_after:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please try again in a few minutes.",
            headers={"Retry-After": str(retry_after)},
        )

    def _dead_link(detail: str) -> HTTPException:
        """Reject + count. Every failure path funnels through here so none can
        be added later that forgets to score against the limiter."""
        limiter.record_failure(ip_key)
        return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)

    try:
        payload = decode_reset_token(body.token)
    except jwt.ExpiredSignatureError:
        raise _dead_link("This reset link has expired. Please request a new one.") from None
    except jwt.InvalidTokenError:
        raise _dead_link("This reset link is invalid. Please request a new one.") from None

    try:
        user_uuid = uuid_mod.UUID(payload.get("sub"))
    except (ValueError, TypeError):
        raise _dead_link("This reset link is invalid. Please request a new one.") from None

    user = db.query(User).filter(User.id == user_uuid).first()
    # A fingerprint mismatch means the password already changed since the link
    # was issued (used once, or superseded) — treat as a dead link.
    if user is None or not reset_token_matches_hash(payload, user.password_hash):
        raise _dead_link("This reset link is no longer valid. Please request a new one.")

    # The policy runs AFTER the link is proven good, and does NOT go through
    # _dead_link: reaching this line means the caller holds a valid single-use
    # link, so a rule they haven't met yet is a form error, not a failed attack
    # — counting it would throttle a user fumbling their own recovery, and the
    # link stays usable (the password hash, hence the token fingerprint, is
    # unchanged) so they can simply retry.
    unmet = validate_password(body.new_password)
    if unmet:
        # Byte-identical shape to /change-password's policy 422 so one client
        # helper reads both (see admin passwordPolicy.unmetKeysFromDetail).
        raise HTTPException(
            status_code=422,
            detail={"code": "password_policy", "message": PASSWORD_HELP, "unmet": unmet},
        )

    user.password_hash = hash_password(body.new_password)
    # Stamping this retires every session token minted before the reset (see
    # auth_service.token_predates_password_change) — a password recovered
    # because the account was compromised must not leave the intruder's
    # existing session alive.
    user.password_changed_at = datetime.now(UTC)
    # A completed reset IS the rotation the forced-change flag demands: the new
    # password just passed the same policy /change-password enforces, and the
    # caller proved control of the mailbox. Leaving the flag set would trap the
    # migration-022 admins — whose passwords were rotated out from under them,
    # so /change-password (which needs current_password) is unusable — behind a
    # 403 gate with no way through. Clearing it here is what makes recovery a
    # complete exit from the gate.
    user.must_change_password = False
    db.commit()
    # P3: the second password-set path, and it must sync exactly like the
    # first — a recovery that left the mailbox on the old password would be the
    # very drift this channel exists to prevent. Best-effort and post-commit:
    # the reset itself has already succeeded.
    mail_sync.sync_user_password(db, user, body.new_password)
    # A completed reset clears this host's recovery counter AND the sign-in
    # lockout it was almost certainly triggered by. Without the login keys here
    # the flow dead-ends: forgetting your password is exactly what locks you
    # out, so "reset it" would hand you a working password you still can't use
    # for up to 15 minutes. Possession of a single-use link emailed to the
    # account is stronger proof of legitimacy than the password itself — anyone
    # who can reach this line already holds the mailbox.
    limiter.clear(ip_key, login_ip_key(request), login_email_key(user.email))
    return GENERIC_OK


@router.post("/forgot-username", status_code=status.HTTP_410_GONE)
def forgot_username():
    """Retired (P1 auth overhaul): the username IS the email address now, so
    there is nothing to look up. Kept as an explicit 410 rather than deleted so
    a client still running the pre-overhaul bundle gets a self-describing
    answer instead of a bare 404. Reveals nothing about any account."""
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Username recovery is retired — sign in with your email address.",
    )


@router.get("/me")
# Ungated (get_authenticated_user): a user who MUST change their password still
# needs to ask who they are — this is how the client learns to show the screen.
def me(current_user: User = Depends(get_authenticated_user)):
    return {
        "id": str(current_user.id),
        "username": current_user.username,
        # The login key since 022, and the address the console shows on the
        # account screen — which used to print a hardcoded `matt@` that did not
        # match anybody's actual account or mailbox.
        "email": current_user.email,
        "role": current_user.role,
        "supplier_id": str(current_user.supplier_id) if current_user.supplier_id else None,
        "must_change_password": bool(current_user.must_change_password),
        # The sign-in BEFORE the current session (alembic 024) — the reading
        # that lets someone spot access that was not theirs. null means never
        # recorded (first-ever sign-in, or an account that predates 024), and
        # the console says so rather than rendering a zero date.
        "previous_login_at": (
            current_user.prev_login_at.isoformat() if current_user.prev_login_at else None
        ),
        "previous_login_ip": current_user.prev_login_ip,
        # P3 drift signal: true means this account's SITE password changed but
        # its MAILBOX did not get it, so the two are temporarily different.
        # Surfaced rather than kept server-side because silent drift is exactly
        # the failure mode the push-sync design set out to prevent — the person
        # whose mail is behind is the one who needs to know.
        "mail_sync_pending": bool(current_user.mail_sync_pending),
        # Same server-signalled flag as the login payload — a reloaded tab
        # rediscovers "this is the demo" here, so DEMO DATA stays forced on and
        # the console stays marked without a fresh sign-in.
        "is_demo": is_demo_user(current_user),
    }
