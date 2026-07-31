import uuid as uuid_mod
from datetime import UTC, datetime

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import User
from app.services import email as email_service
from app.services.auth_service import (
    REMEMBER_EXPIRY_HOURS,
    TOKEN_EXPIRY_HOURS,
    create_reset_token,
    create_token,
    decode_reset_token,
    get_authenticated_user,
    hash_password,
    reset_token_matches_hash,
    verify_dummy_password,
    verify_password,
)
from app.services.password_policy import PASSWORD_HELP, validate_password
from app.services.rate_limit import (
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
    new_password: str = Field(min_length=8)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


def _is_demo_identifier(identifier: str) -> bool:
    """True when this identifier addresses the public demo account."""
    demo_email = (settings.DEMO_LOGIN_EMAIL or "").strip().lower()
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
        ),
        # bool(): the column is NOT NULL, but a legacy row read through an
        # older connection could still surface None — `?:`-style optionality
        # must never reach the response model.
        must_change_password=bool(user.must_change_password),
    )


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

    user.password_hash = hash_password(body.new_password)
    # Stamping this retires every session token minted before the reset (see
    # auth_service.token_predates_password_change) — a password recovered
    # because the account was compromised must not leave the intruder's
    # existing session alive. must_change_password is deliberately NOT cleared
    # here: this route does not yet enforce the password policy, so clearing it
    # would let a forced rotation be satisfied by a weak password.
    user.password_changed_at = datetime.now(UTC)
    db.commit()
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
        "role": current_user.role,
        "supplier_id": str(current_user.supplier_id) if current_user.supplier_id else None,
        "must_change_password": bool(current_user.must_change_password),
    }
