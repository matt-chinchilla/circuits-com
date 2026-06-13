import hashlib
import uuid as uuid_mod
from datetime import datetime, timezone, timedelta

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


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def create_token(user_id: str, role: str, expires_hours: int = TOKEN_EXPIRY_HOURS) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "role": role,
        "exp": now + timedelta(hours=expires_hours),
        "iat": now,
    }
    return jwt.encode(payload, settings.ADMIN_SECRET_KEY, algorithm="HS256")


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.ADMIN_SECRET_KEY, algorithms=["HS256"])


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
    now = datetime.now(timezone.utc)
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
    return user
