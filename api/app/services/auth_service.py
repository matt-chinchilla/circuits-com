import hashlib
import uuid as uuid_mod
from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import User
from app.models.roles import CUSTOMER_ROLES, STAFF_ROLES, VIEWER_ROLES

security = HTTPBearer(auto_error=False)

TOKEN_EXPIRY_HOURS = 24
# "Keep me signed in for 30 days" — the login endpoint passes this as
# expires_hours when the remember box is checked.
REMEMBER_EXPIRY_HOURS = 24 * 30
# Password-reset links are short-lived (the design copy promises 30 minutes).
RESET_EXPIRY_MINUTES = 30
# Session invalidation: a token is only honored if it was minted at (or after)
# the user's last password change, so changing a password logs out every other
# session. PyJWT truncates `iat` to whole seconds while password_changed_at
# keeps microseconds — one second of grace absorbs that rounding (and any small
# clock skew) so the token a password change hands back can't invalidate itself.
SESSION_IAT_GRACE_SECONDS = 1


# bcrypt hashes at most 72 BYTES of input, and since bcrypt 4 it RAISES
# ValueError on longer input instead of silently truncating. Left unhandled that
# ValueError becomes a 500, and a 500-vs-401 split on /login is a one-request
# account-existence oracle: a >72-byte password reaches bcrypt (and raises) only
# when the address matched a real user — the unknown-account path burns the
# fixed-length dummy hash instead and can never raise. It bites on the write
# side too: the policy caps passwords at 24 CODE POINTS, and 24 emoji are 96
# bytes, so a policy-VALID password could 500 inside hash_password.
#
# Clamping the encoded bytes here makes both functions total for every str, so
# no call site can produce a 500. 72 bytes has always been bcrypt's semantic
# ceiling (bytes past it were never part of the digest), so this verifies every
# previously-stored hash exactly as before.
BCRYPT_MAX_BYTES = 72


def _bcrypt_bytes(password: str) -> bytes:
    """UTF-8 encode a password, clamped to bcrypt's 72-byte ceiling.

    Sliced on BYTES, not characters — the ceiling is a byte limit, and a
    multibyte character straddling the boundary is fine: bcrypt takes raw
    bytes, it does not decode them.
    """
    return (password or "").encode()[:BCRYPT_MAX_BYTES]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_bcrypt_bytes(password), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(_bcrypt_bytes(password), hashed.encode())


# Precomputed hash (same cost factor as real hashes) used to equalize /login
# timing on the user-not-found path. Without it, a missing username short-
# circuits before bcrypt runs (~3ms) while a real username pays the bcrypt cost
# (~200ms) — a ~70x gap that leaks which usernames exist despite the generic 401.
_DUMMY_PASSWORD_HASH = bcrypt.hashpw(b"timing-equalizer", bcrypt.gensalt()).decode()


def verify_dummy_password() -> None:
    """Burn one bcrypt verify (result discarded) so the user-not-found login
    path costs the same as the wrong-password path. Constant-time anti-enum."""
    bcrypt.checkpw(b"x", _DUMMY_PASSWORD_HASH.encode())


def create_token(user_id: str, role: str, expires_hours: int = TOKEN_EXPIRY_HOURS) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "role": role,
        "exp": now + timedelta(hours=expires_hours),
        # `iat` is load-bearing, not decorative: get_current_user compares it to
        # the user's password_changed_at to kill sessions minted before the last
        # password change. Never drop it from this payload.
        "iat": now,
    }
    return jwt.encode(payload, settings.ADMIN_SECRET_KEY, algorithm="HS256")


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.ADMIN_SECRET_KEY, algorithms=["HS256"])


def _as_utc(dt: datetime) -> datetime:
    """Normalize a DB datetime to aware-UTC.

    Postgres hands back aware datetimes for a ``DateTime(timezone=True)``
    column; SQLite (the test suite, built via ``Base.metadata.create_all``)
    hands back NAIVE ones for the same column. Comparing aware to naive raises
    TypeError, so treat a naive value as UTC — which is what both the model
    default and the migration backfill write.
    """
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def token_predates_password_change(payload: dict, password_changed_at: datetime | None) -> bool:
    """True when this token was minted before the user's last password change.

    A NULL ``password_changed_at`` means "no constraint": fresh rows carry no
    timestamp (alembic 022 backfilled only the users that already existed), and
    reading NULL as "changed at the epoch" would instantly log out every newly
    created user. A token with a missing or unparseable ``iat`` cannot prove it
    is newer than the change, so it loses.
    """
    if password_changed_at is None:
        return False
    changed_at = _as_utc(password_changed_at)
    raw_iat = payload.get("iat")
    if raw_iat is None:
        return True
    try:
        issued_at = datetime.fromtimestamp(float(raw_iat), tz=UTC)
    except (TypeError, ValueError, OverflowError, OSError):
        return True
    return issued_at < changed_at - timedelta(seconds=SESSION_IAT_GRACE_SECONDS)


# ── Password-reset tokens (tableless, single-use) ──────────────────────────
# A reset token is a short-lived JWT tagged purpose="pwreset" and stamped with a
# fingerprint of the user's CURRENT password hash. The reset route compares that
# fingerprint to the live hash: the moment the password changes, the fingerprint
# no longer matches, so the link (and any other outstanding reset link) is dead —
# single-use semantics with no revocation table. The distinct purpose claim, plus
# get_current_user's rejection of any purpose-bearing token, means a reset token
# can never be replayed as an admin session bearer.


def _pw_fingerprint(password_hash: str) -> str:
    """First 16 hex of sha256(password_hash) — changes whenever the hash does."""
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def create_reset_token(user_id: str, password_hash: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "purpose": "pwreset",
        "pwfp": _pw_fingerprint(password_hash),
        "exp": now + timedelta(minutes=RESET_EXPIRY_MINUTES),
        "iat": now,
    }
    return jwt.encode(payload, settings.ADMIN_SECRET_KEY, algorithm="HS256")


def decode_reset_token(token: str) -> dict:
    """Validate signature + expiry + purpose; return the payload.

    Raises jwt.ExpiredSignatureError on expiry and jwt.InvalidTokenError for a
    bad signature OR a token that isn't a reset token (e.g. a session token).
    The pwfp single-use check is the caller's job (it needs the live hash).
    """
    payload = jwt.decode(token, settings.ADMIN_SECRET_KEY, algorithms=["HS256"])
    if payload.get("purpose") != "pwreset":
        raise jwt.InvalidTokenError("not a password-reset token")
    return payload


def reset_token_matches_hash(payload: dict, password_hash: str) -> bool:
    """True iff the token's pwfp still matches the user's live password hash.

    A False here means the password already changed since the link was issued
    (the link was used, or a newer one superseded it) → the route rejects it.
    """
    return payload.get("pwfp") == _pw_fingerprint(password_hash)


# ── Email-verification tokens (alembic 043) ────────────────────────────────
# 24 hours, not the reset link's 30 minutes: a reset link hands over a live
# credential, this only proves mailbox control, and people read email on their
# own schedule.
VERIFY_EXPIRY_HOURS = 24


def _email_fingerprint(email: str) -> str:
    """First 16 hex of sha256(lower(email)) — ties a token to one address.

    Lowercased because the address is STORED lowercased (uq_users_email_lower)
    but the token may be minted from whatever casing the person typed.
    """
    return hashlib.sha256((email or "").strip().lower().encode()).hexdigest()[:16]


def create_verify_token(user_id: str, email: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "purpose": "verify",
        "emfp": _email_fingerprint(email),
        "exp": now + timedelta(hours=VERIFY_EXPIRY_HOURS),
        "iat": now,
    }
    return jwt.encode(payload, settings.ADMIN_SECRET_KEY, algorithm="HS256")


def decode_verify_token(token: str) -> dict:
    """Validate signature + expiry + purpose; return the payload.

    Raises jwt.ExpiredSignatureError on expiry and jwt.InvalidTokenError for a
    bad signature OR a token that isn't a verification token (a session token,
    or a reset token). The purpose claim is what stops a verification link
    being replayed as a session: get_authenticated_user rejects ANY token
    carrying a purpose.
    """
    payload = jwt.decode(token, settings.ADMIN_SECRET_KEY, algorithms=["HS256"])
    if payload.get("purpose") != "verify":
        raise jwt.InvalidTokenError("not a verification token")
    return payload


def verify_token_matches_email(payload: dict, email: str) -> bool:
    """True iff the token was minted for this address."""
    return payload.get("emfp") == _email_fingerprint(email)


# The 403 body a flagged user gets from every gated route. A machine-readable
# code, not prose: the admin client keys the "set a new password" redirect off
# this exact string, so changing it silently breaks the forced-reset UX.
PASSWORD_CHANGE_REQUIRED_DETAIL = "password_change_required"


def get_authenticated_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    """Authenticate the bearer token — WITHOUT the forced-password-change gate.

    Only the three endpoints a flagged user must still reach may depend on
    this: ``/api/auth/change-password`` (the way out), ``/api/auth/me`` (the
    client asks "who am I / do I have to change it?") and logout. Everything
    else takes :func:`get_current_user`, which adds the 403 gate.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    try:
        payload = decode_token(credentials.credentials)
        user_id = payload.get("sub")
        # Reject any non-session token (e.g. a password-reset token, which
        # carries purpose="pwreset"). Session tokens never set a purpose claim,
        # so a reset token can't be replayed as an admin bearer.
        if user_id is None or payload.get("purpose") is not None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token",
            )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )

    try:
        user_uuid = uuid_mod.UUID(user_id)
    except (ValueError, AttributeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )
    user = db.query(User).filter(User.id == user_uuid).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    # Session invalidation: changing a password retires every token issued
    # before the change (this one included), no revocation table required.
    if token_predates_password_change(payload, user.password_changed_at):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired",
        )
    return user


def get_current_user(user: User = Depends(get_authenticated_user)) -> User:
    """The authenticated user, gated on a forced password change.

    THE enforcement point for ``must_change_password``: a flagged user gets 403
    ``password_change_required`` on every route that depends on this — the
    admin screen is only its front end, and deleting the screen would not open
    the console.

    Fail-CLOSED by construction: every admin route already depends on this, so
    it covers them all — and covers any route added later — without a
    per-router opt-in that a new endpoint could forget. The three exempt
    endpoints opt OUT explicitly via :func:`get_authenticated_user` —
    ``/auth/change-password`` (the way out of the password gate), ``/auth/me``
    and logout.

    Deliberately role-agnostic. The customer/staff wall is a separate concern —
    see ``require_staff`` / ``require_account_user`` / ``require_console_user``,
    which compose with this rather than replacing it.
    """
    # bool(): the column is NOT NULL, but a row read through a connection that
    # predates alembic 022 could still surface None — never let `if x` decide
    # on a value whose null-ness is uncertain.
    if bool(user.must_change_password):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=PASSWORD_CHANGE_REQUIRED_DETAIL,
        )
    return user


# ── Owner-only routes ───────────────────────────────────────────────────────
# Message deletion is irreversible and the rows are real members of the public
# writing in, so the owner decided (2026-08-19) that only the owner account may
# destroy them. `user_role` carries exactly one `owner` today (matthew, alembic
# 022) on BOTH local and prod; every other admin is `admin`.
OWNER_ONLY_DETAIL = "owner_only"


def is_owner(user: User | None) -> bool:
    """True when this user holds the `owner` role.

    ``getattr(role, "value", role)`` because SQLAlchemy's ``Enum(...)`` with
    native strings hands back a plain ``str`` here, but the same column read
    through a mapping that resolves to a Python enum member would give an enum
    — comparing the raw attribute would then silently be False for the real
    owner and lock the ONLY account that may delete out of its own inbox.
    """
    if user is None:
        return False
    role = getattr(user.role, "value", user.role)
    return isinstance(role, str) and role.strip().lower() == "owner"


def require_owner(user: User = Depends(get_current_user)) -> User:
    """Gate a route on the owner role — 403 ``owner_only`` for anyone else.

    COMPOSES with :func:`get_current_user` rather than replacing it, and the
    ordering is deliberate: get_current_user runs FIRST, so an unauthenticated
    caller still gets 401, a flagged user still gets ``password_change_required``
    """
    if not is_owner(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=OWNER_ONLY_DETAIL,
        )
    return user


# ── The customer/staff wall (alembic 043) ───────────────────────────────────
# get_current_user is deliberately role-agnostic, which was correct while every
# account was staff. Public registration ends that, so these three are the
# boundary. They COMPOSE with get_current_user — never replace it — so the
# forced-password gate still runs first.
STAFF_ONLY_DETAIL = "staff_only"
NOT_ACTIVATED_DETAIL = "account_not_activated"
# A viewer (read-only staff, alembic 051) on any verb that could change data.
READ_ONLY_DETAIL = "read_only"
# RFC 9110 "safe" methods — the only verbs a read-only account may use.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _role_of(user: User) -> str:
    """Normalize the role the same way is_owner does.

    SQLAlchemy's Enum(...) can hand back an enum member or a bare string
    depending on how the row was loaded.
    """
    role = getattr(user.role, "value", user.role)
    return role.strip().lower() if isinstance(role, str) else ""


def is_staff(user: User | None) -> bool:
    """Everyone the /admin mount belongs to — acting admins AND read-only
    viewers. Membership is STAFF_ROLES, not ADMIN_ROLES: a viewer clears the
    wall on reads and is stopped by require_staff's verb check on writes."""
    return user is not None and _role_of(user) in STAFF_ROLES


def is_viewer(user: User | None) -> bool:
    """Read-only staff (alembic 051) — sees everything staff sees, changes nothing."""
    return user is not None and _role_of(user) in VIEWER_ROLES


def is_customer(user: User | None) -> bool:
    return user is not None and _role_of(user) in CUSTOMER_ROLES


def _refuse_non_staff(user: User) -> None:
    """The customer/staff wall itself — a plain helper, NOT a dependency.

    Deliberately not ``Depends``-wired: a default that only DI resolves is
    skipped by a direct call, and the calendar gate CALLS require_staff (its
    plugin door arrives with no bearer). The first cut of alembic 051 made
    exactly that mistake and let a customer read /api/calendar/events —
    test_every_route_is_gated.py::test_the_calendar_gate_really_is_a_wall
    is what caught it.
    """
    if not is_staff(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=STAFF_ONLY_DETAIL,
        )


def require_staff(request: Request, user: User = Depends(get_current_user)) -> User:
    """Staff-only routes: /api/admin/users, message deletion, anything that
    manages OTHER accounts.

    A ``viewer`` (read-only staff, alembic 051) passes on the safe verbs and
    is refused with 403 ``read_only`` on POST/PATCH/PUT/DELETE. The check
    lives HERE, in the one wall every staff router already declares (most at
    router level), so a mutation route added later is read-only for viewers
    without a per-route opt-in it could forget. A route whose non-GET verb is
    a heartbeat rather than an edit opts OUT explicitly via
    :func:`require_staff_reader`.
    """
    _refuse_non_staff(user)
    if is_viewer(user) and request.method.upper() not in SAFE_METHODS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=READ_ONLY_DETAIL,
        )
    return user


def require_staff_reader(user: User = Depends(get_current_user)) -> User:
    """The staff wall WITHOUT the viewer verb check.

    For the presence heartbeat only (routes/admin_presence.py): its POST
    stamps the caller's OWN last_seen_at and returns who is online. A viewer
    with the console open should show up in the bubbles like anyone else, and
    refusing the ping would log a 403 in their console every 30s for nothing.
    Do not reach for this on a route that edits data.
    """
    _refuse_non_staff(user)
    return user


def require_account_user(user: User = Depends(get_current_user)) -> User:
    """An ACTIVATED customer. Activation (D17) is the whole authorization
    boundary in this project, so it lives here and nowhere else."""
    if not is_customer(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=STAFF_ONLY_DETAIL,
        )
    if user.activated_at is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=NOT_ACTIVATED_DETAIL,
        )
    return user


def require_console_user(user: User = Depends(get_current_user)) -> User:
    """Either principal — the console pages are shared (D16).

    Staff are NEVER gated on activated_at: it is NULL on every staff row and
    must stay irrelevant to them.
    """
    if is_staff(user):
        return user
    return require_account_user(user)
