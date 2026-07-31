import uuid as uuid_mod
from datetime import UTC, datetime

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
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
    get_current_user,
    hash_password,
    reset_token_matches_hash,
    verify_dummy_password,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Recovery endpoints always return this, whether or not an account matched, so a
# caller can't probe which usernames/emails exist (anti-enumeration).
GENERIC_OK = {"status": "ok"}

# The sign-in screen advertises a public demo account as "demo / demo" — a bare
# username, not an address. Email is the login key for every real account
# (alembic 022 made it required + unique on lower(email)), but this ONE literal
# username also resolves so that advertised credential keeps working verbatim.
# Scoped deliberately: no other account can authenticate by username.
DEMO_USERNAME = "demo"


class LoginRequest(BaseModel):
    # The login identifier is the email address, matched case-insensitively on
    # lower(email). (DEMO_USERNAME is the single documented exception.)
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


def _find_login_user(db: Session, identifier: str) -> User | None:
    """Resolve a login identifier to a user, or None.

    Case-insensitive on lower(email) — the same expression the unique index
    covers, so at most one row can ever match. Falls back to the demo account's
    bare username (and only that one) per DEMO_USERNAME above.
    """
    ident = identifier.strip().lower()
    if not ident:
        return None
    user = db.query(User).filter(func.lower(User.email) == ident).first()
    if user is None and ident == DEMO_USERNAME:
        user = db.query(User).filter(User.username == DEMO_USERNAME).first()
    return user


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = _find_login_user(db, body.email)
    if user is None:
        # Equalize timing with the wrong-password path so a missing account
        # can't be detected by response latency (account enumeration).
        verify_dummy_password()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    expires = REMEMBER_EXPIRY_HOURS if body.remember else TOKEN_EXPIRY_HOURS
    token = create_token(str(user.id), user.role, expires_hours=expires)
    return LoginResponse(
        token=token,
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


@router.post("/logout")
def logout():
    return {"status": "ok"}


@router.post("/forgot-password")
def forgot_password(
    body: ForgotPasswordRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Email a secure reset link if the identifier matches an account with an
    email on file. Always returns GENERIC_OK (anti-enumeration)."""
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
def reset_password(body: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Set a new password from a valid, unused reset token."""
    try:
        payload = decode_reset_token(body.token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This reset link has expired. Please request a new one.",
        ) from None
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This reset link is invalid. Please request a new one.",
        ) from None

    try:
        user_uuid = uuid_mod.UUID(payload.get("sub"))
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This reset link is invalid. Please request a new one.",
        ) from None

    user = db.query(User).filter(User.id == user_uuid).first()
    # A fingerprint mismatch means the password already changed since the link
    # was issued (used once, or superseded) — treat as a dead link.
    if user is None or not reset_token_matches_hash(payload, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This reset link is no longer valid. Please request a new one.",
        )

    user.password_hash = hash_password(body.new_password)
    # Stamping this retires every session token minted before the reset (see
    # auth_service.token_predates_password_change) — a password recovered
    # because the account was compromised must not leave the intruder's
    # existing session alive. must_change_password is deliberately NOT cleared
    # here: this route does not yet enforce the password policy, so clearing it
    # would let a forced rotation be satisfied by a weak password.
    user.password_changed_at = datetime.now(UTC)
    db.commit()
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
def me(current_user: User = Depends(get_current_user)):
    return {
        "id": str(current_user.id),
        "username": current_user.username,
        "role": current_user.role,
        "supplier_id": str(current_user.supplier_id) if current_user.supplier_id else None,
        "must_change_password": bool(current_user.must_change_password),
    }
