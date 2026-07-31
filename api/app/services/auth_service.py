import hashlib
import uuid as uuid_mod
from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import User

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


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


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


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
) -> User:
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
