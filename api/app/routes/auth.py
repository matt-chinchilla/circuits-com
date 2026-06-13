import uuid as uuid_mod

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
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
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Recovery endpoints always return this, whether or not an account matched, so a
# caller can't probe which usernames/emails exist (anti-enumeration).
GENERIC_OK = {"status": "ok"}


class LoginRequest(BaseModel):
    username: str
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


class ForgotPasswordRequest(BaseModel):
    identifier: str  # email OR username


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8)


class ForgotUsernameRequest(BaseModel):
    email: str


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == body.username).first()
    if not user or not verify_password(body.password, user.password_hash):
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
    )


@router.post("/logout")
def logout():
    return {"status": "ok"}


@router.post("/forgot-password")
def forgot_password(
    body: ForgotPasswordRequest,
    background_tasks: BackgroundTasks,
    request: Request,
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
            base = (settings.APP_BASE_URL or str(request.base_url)).rstrip("/")
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
    db.commit()
    return GENERIC_OK


@router.post("/forgot-username")
def forgot_username(
    body: ForgotUsernameRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Email the username(s) tied to an address. Always GENERIC_OK (anti-enum)."""
    email = body.email.strip()
    if email:
        users = db.query(User).filter(func.lower(User.email) == email.lower()).all()
        usernames = [u.username for u in users]
        if usernames:
            background_tasks.add_task(
                email_service.send_username_reminder, email, usernames
            )
    return GENERIC_OK


@router.get("/me")
def me(current_user: User = Depends(get_current_user)):
    return {
        "id": str(current_user.id),
        "username": current_user.username,
        "role": current_user.role,
        "supplier_id": str(current_user.supplier_id) if current_user.supplier_id else None,
    }
