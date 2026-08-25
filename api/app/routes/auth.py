import uuid as uuid_mod
from datetime import UTC, datetime

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Message, User
from app.services import email as email_service
from app.services import mail_sync
from app.services.auth_service import (
    REMEMBER_EXPIRY_HOURS,
    TOKEN_EXPIRY_HOURS,
    create_reset_token,
    create_token,
    create_verify_token,
    decode_reset_token,
    decode_verify_token,
    get_authenticated_user,
    hash_password,
    is_customer,
    reset_token_matches_hash,
    verify_dummy_password,
    verify_password,
    verify_token_matches_email,
)
from app.services.geoip import country_for_ip
from app.services.password_policy import PASSWORD_HELP, validate_password
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
    RESEND_WINDOW_SECONDS,
    client_ip,
    limiter,
    login_email_key,
    login_ip_key,
    record_hit,
    record_probe,
    recovery_identifier_key,
    recovery_ip_key,
    resend_email_hit_key,
    resend_ip_hit_key,
    signup_create_key,
    signup_email_key,
    signup_ip_key,
    signup_probe_key,
    signup_probe_wide_key,
    trusted_client_addr,
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
# The unauthenticated credential-adjacent endpoints declare this ONE list, so
# wiring the limiter is a single edit here (append the Depends(...)) rather than
# several call sites that can drift — one endpoint silently exempt from
# throttling would be a free oracle for hammering the API. FastAPI reads the
# list when the decorator runs, so it must be populated above the route
# definitions (or a new list assigned to this name BEFORE import completes).
#
# Migration 043 retired /auth/demo, which used to share this list.
LOGIN_RATE_LIMIT_DEPENDENCIES: list = [Depends(_login_rate_limit)]


class LoginRequest(BaseModel):
    # The login identifier is the email address, matched case-insensitively on
    # lower(email). There is NO username fallback for anyone.
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
    # No Field(min_length=...) here on purpose: validate_password is the ONE
    # gate, so a too-short password answers with the same structured
    # password_policy 422 as every other rule instead of a stock pydantic
    # array-detail the client can't read.
    new_password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class SignupRequest(BaseModel):
    # extra="forbid" is load-bearing, not tidiness: it is what stops a body
    # carrying role/supplier_id/manufacturer_id, and what rejects a
    # confirm_password someone helpfully added client-side (D11).
    model_config = ConfigDict(extra="forbid")

    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    email: EmailStr
    # No Field(min_length=...): validate_password is the ONE gate, so a short
    # password answers with the structured policy 422 like every other rule.
    password: str


class VerifyRequest(BaseModel):
    token: str


class ResendVerificationRequest(BaseModel):
    email: str


EMAIL_TAKEN_DETAIL = "email_taken"

# The ONE body every UNUSABLE verification token answers with — malformed,
# expired, wrong purpose (a session or reset token), no such user, or minted
# for a different address. They are indistinguishable on purpose: none of them
# should tell a caller holding a bad link whether some account exists.
#
# The already-verified reply below is deliberately NOT this string. It is not
# an enumeration leak — reaching it requires presenting a validly-signed token
# for that exact user and address, which is itself proof the account exists —
# and "you already confirmed, just sign in" is the answer that reply exists to
# give.
INVALID_VERIFY_DETAIL = "invalid_or_expired_token"


def _find_login_user(db: Session, identifier: str) -> User | None:
    """Resolve a login identifier to a user, or None.

    Case-insensitive on lower(email) — the same expression the unique index
    covers, so at most one row can ever match. Email is the ONLY login key:
    no username resolves here, for any account.

    """
    ident = identifier.strip().lower()
    if not ident:
        return None
    return db.query(User).filter(func.lower(User.email) == ident).first()


def _session_response(user: User, *, expires_hours: int = TOKEN_EXPIRY_HOURS) -> LoginResponse:
    """Mint a session token and wrap it in the one login-shaped payload.

    /login and /change-password both hand the client the same thing, so
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
    has already succeeded.
    """
    try:
        user.prev_login_at = user.last_login_at
        user.prev_login_ip = user.last_login_ip
        user.last_login_at = datetime.now(UTC)
        user.last_login_ip = client_ip(request)
        db.commit()
    except Exception:  # pragma: no cover - defensive
        db.rollback()


@router.post("/signup", status_code=status.HTTP_202_ACCEPTED)
def signup(
    body: SignupRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Create an unverified, unactivated customer account.

    Returns 202 and NO token. There is no session until the address is
    verified, which is what makes "notify staff on verify, never on submit"
    (D6) enforceable rather than advisory.
    """
    ip_key = signup_ip_key(request)
    retry_after = limiter.retry_after(ip_key)
    if retry_after:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="too_many_requests",
            headers={"Retry-After": str(retry_after)},
        )

    unmet = validate_password(body.password)
    if unmet:
        # Byte-identical shape to /change-password and /reset-password so one
        # client helper reads all three. Bare 422 (repo convention): the
        # starlette constant was renamed ..._ENTITY -> ..._CONTENT and emits a
        # DeprecationWarning, so the literal is the version-stable spelling.
        raise HTTPException(
            status_code=422,
            detail={"code": "password_policy", "message": PASSWORD_HELP, "unmet": unmet},
        )

    email = body.email.strip().lower()
    existing = db.query(User).filter(func.lower(User.email) == email).first()
    if existing is not None:
        # D5: an explicit owner carve-out from the anti-enumeration rule, paid
        # for by the probe counter below. Do NOT "restore" the generic reply
        # without reading §6 of the design spec first.
        probes = record_probe(signup_probe_key(request), email)
        # The SLOW WALK, over an hour instead of fifteen minutes. Seven distinct
        # addresses per sixteen minutes never trips the rule below and still
        # walks ~26 an hour, so without this row the counter that "pays for" D5
        # is avoidable by anyone willing to wait. A separate key because
        # record_probe prunes each key to ONE window.
        wide = record_probe(
            signup_probe_wide_key(request), email, window_seconds=PROBE_WIDE_WINDOW_SECONDS
        )
        if wide >= PROBE_WIDE_DISTINCT_THRESHOLD:
            # A day, not an hour: at this pace nothing but enumeration is
            # happening. pause() never shortens a live lock, so this cannot be
            # undone by the shorter pause below.
            limiter.pause(ip_key, seconds=PROBE_WIDE_LOCK_SECONDS)
        if probes >= PROBE_DISTINCT_THRESHOLD:
            # pause(), NOT record_failure(): the design's threshold table says
            # "1 hour pause", and record_failure's delay is the login ladder's
            # own escalation (60s, doubling) — it cannot deliver an hour, and
            # calling it would leave PROBE_LOCK_SECONDS a constant that lies.
            # The pause is scoped to signup:ip:* so it cannot lock this host
            # out of signing IN, which is the whole reason the namespace is
            # separate.
            limiter.pause(ip_key, seconds=PROBE_LOCK_SECONDS)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=EMAIL_TAKEN_DETAIL)

    # trusted_client_addr, NOT client_ip: client_ip collapses IPv6 to its /64
    # because that is the right shape for a BUCKET KEY and the wrong shape for
    # a stored address — a CIDR is not where anybody signed up, and the geoip
    # reader rejects it outright (which is how every IPv6 visitor once landed
    # on the analytics map as "unknown"). None when no hop parses as an IP,
    # which is a fact rather than an error: both columns are nullable.
    ip = trusted_client_addr(request)
    user = User(
        username=email,  # D7 — customers never choose one
        email=email,
        password_hash=hash_password(body.password),
        role="user",
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        signup_ip=ip,
        signup_country=country_for_ip(ip),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Meter the path that ACTUALLY sends the mail. Everything above this line
    # counts refusals; a fresh address has always returned 202 and mailed a
    # stranger, unbounded, which is the open-relay half of this endpoint. The
    # tenth account still succeeds — it arms the hour that the eleventh meets at
    # the 429 above. record_hit, not record_probe: creations are attempts, and
    # this key is never asked "how many different people".
    created = record_hit(signup_create_key(request), window_seconds=CREATE_WINDOW_SECONDS)
    if created >= CREATE_THRESHOLD:
        limiter.pause(ip_key, seconds=CREATE_LOCK_SECONDS)

    verify_url = (
        f"{settings.APP_BASE_URL.rstrip('/')}/admin/verify"
        f"?token={create_verify_token(str(user.id), email)}"
    )
    background_tasks.add_task(
        email_service.send_verification_email, email, user.first_name, verify_url
    )
    return {"status": "ok"}


def _next_message_seq(db: Session) -> int:
    """Same single sequence space the public forms use (routes/forms.py).

    The MSG-#### designator is one counter across every message type, so a
    customer signup takes the next number after the last contact form — not a
    parallel series that collides with it (``seq`` is UNIQUE).
    """
    return (db.query(func.max(Message.seq)).scalar() or 0) + 1


@router.post("/verify")
def verify_email(
    body: VerifyRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Spend a verification token — and fire the signup's side effects.

    A POST, not a GET on the emailed link, because corporate mail scanners
    prefetch every URL in a message: a GET would be consumed before the human
    ever clicked. The SPA renders /admin/verify and POSTs from there.

    This is where the two Message rows are born (D6), never at signup: the
    staff row and the welcome mail are only owed to someone who has proved they
    hold the mailbox. Firing them on submit would let anyone with a script
    spray the staff inbox and mail strangers a "welcome" they never asked for.
    """
    try:
        payload = decode_verify_token(body.token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=400, detail=INVALID_VERIFY_DETAIL) from None

    try:
        # TypeError too: a token carrying an explicit null `sub` reaches
        # UUID(None), which raises TypeError, not ValueError — and an
        # unhandled 500 on a public route is a worse answer than the 400.
        user_uuid = uuid_mod.UUID(payload.get("sub", ""))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=400, detail=INVALID_VERIFY_DETAIL) from None

    user = db.query(User).filter(User.id == user_uuid).first()
    # The email fingerprint check is what stops a token surviving an address
    # change: it was minted for one mailbox and is only good for that one.
    if user is None or not verify_token_matches_email(payload, user.email or ""):
        raise HTTPException(status_code=400, detail=INVALID_VERIFY_DETAIL)
    if user.email_verified_at is not None:
        # Single-use: the stamp IS the spend record, so a replayed link cannot
        # fire the side effects twice (no second staff row, no second welcome).
        # The token stays validly signed until it expires — the row is what
        # says it has been used.
        raise HTTPException(status_code=400, detail="already_verified")

    user.email_verified_at = datetime.now(UTC)
    full_name = " ".join(p for p in (user.first_name, user.last_name) if p).strip()
    seq = _next_message_seq(db)
    db.add(
        Message(
            id=str(uuid_mod.uuid4()),
            type="signup",
            status="new",
            seq=seq,
            user_id=None,  # the shared staff inbox — all four staff see it
            payload={
                "first_name": user.first_name or "",
                "last_name": user.last_name or "",
                "full_name": full_name,
                "email": user.email,
                "country": user.signup_country,
            },
        )
    )
    db.add(
        Message(
            id=str(uuid_mod.uuid4()),
            type="welcome",
            status="new",
            seq=seq + 1,
            user_id=user.id,  # their inbox only
            payload={"first_name": user.first_name or "", "full_name": full_name},
        )
    )
    # One transaction: the stamp and both rows land together or not at all. A
    # commit between them could leave an account verified with no staff row —
    # nobody would ever know the registration happened.
    db.commit()

    background_tasks.add_task(email_service.send_welcome_email, user.email, user.first_name)
    return {"status": "ok"}


@router.post("/resend-verification")
def resend_verification(
    body: ResendVerificationRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Re-send the verification link. Always the generic OK.

    Unlike /signup — which trades anti-enumeration away on purpose (D5) because
    "that address is already registered" is the only honest answer to a person
    who cannot get in — this endpoint has no such UX debt: the caller who owns
    the address gets the mail either way. So it keeps the invariant, and an
    unknown address, an already-verified one and a freshly-sent link are
    byte-identical replies.

    Shares the signup:ip:* bucket rather than owning one: the pause signup arms
    for probing is exactly the pause that should stop the same host turning
    this route into a mailer. A throttled caller still gets the generic OK with
    no mail sent — the response is a constant by design.

    It also ARMS that bucket, and a per-address one. Reading a lock somebody
    else set is not rate limiting: until this counted its own traffic, a loop
    on this route mail-bombed one registrant at whatever rate the network
    allowed, because nothing here ever reaches the branch signup arms. Two
    keys, because the victim of a bomb is the ADDRESS being looped while the
    obvious way around a per-address rule is to rotate addresses from the same
    HOST.
    """
    ip_key = signup_ip_key(request)
    email = (body.email or "").strip().lower()
    email_key = signup_email_key(email)
    if limiter.retry_after(ip_key, email_key):
        return GENERIC_OK

    # Metered BEFORE the lookup, so an address that does not exist costs the
    # caller exactly what a real one does — the count must not become the
    # oracle the reply refuses to be.
    if record_hit(resend_ip_hit_key(request), window_seconds=RESEND_WINDOW_SECONDS) >= (
        RESEND_IP_THRESHOLD
    ):
        limiter.pause(ip_key, seconds=RESEND_LOCK_SECONDS)
    hit_key = resend_email_hit_key(email)
    if (
        hit_key is not None
        and record_hit(hit_key, window_seconds=RESEND_WINDOW_SECONDS) >= RESEND_EMAIL_THRESHOLD
    ):
        limiter.pause(email_key, seconds=RESEND_LOCK_SECONDS)

    user = db.query(User).filter(func.lower(User.email) == email).first()
    if user is not None and user.email_verified_at is None:
        # A FRESH token, not a stored one: the original may already have
        # expired, which is the usual reason somebody is on this screen.
        verify_url = (
            f"{settings.APP_BASE_URL.rstrip('/')}/admin/verify"
            f"?token={create_verify_token(str(user.id), email)}"
        )
        background_tasks.add_task(
            email_service.send_verification_email, email, user.first_name, verify_url
        )
    return GENERIC_OK


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
    # Only reachable with the CORRECT password, which is what keeps it from
    # being an existence oracle: a wrong guess against an unverified account
    # took the generic 401 two lines up, so "this address exists but never
    # verified" costs an attacker the password they'd need anyway.
    #
    # Deliberately BEFORE limiter.clear(): a correct password here still buys
    # no session, so it must not buy a reset of the per-IP failure ledger
    # either. Signing up is free and needs no mailbox, so an attacker could
    # otherwise keep one unverified account of their own purely to wipe the
    # lock their spraying arms.
    #
    # Activation is deliberately NOT checked here (D17) — a verified but
    # unactivated customer signs in fine and meets "awaiting approval" at the
    # console. Refusing at the door would be indistinguishable from a bad
    # password, which is the wrong message for someone who did everything right.
    if is_customer(user) and user.email_verified_at is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="email_not_verified")
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
        # D14: no reset link for an unverified address. The door for someone
        # who never verified is resend-verification — each door does one job,
        # and a reset link would otherwise let an address that was never
        # proved to belong to anyone become a working account. Falls through
        # to the SAME generic OK, so this leaks nothing.
        if is_customer(user) and user.email_verified_at is None:
            user = None
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
    }
