"""The customer's own account. Deliberately tiny.

Project 1 gives customers the CONSOLE pages (D16), gated on activation (D17).
This router is only the things that are about the account itself and have no
admin equivalent: who am I, and delete me.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import User
from app.services.account_tier import account_tier
from app.services.auth_service import require_account_user, verify_password

router = APIRouter(prefix="/api/account", tags=["account"])

# The same generic body /api/auth/login uses for a bad password. Nothing here
# needs to say more: the caller already proved they hold a session, so the only
# information this 401 carries is "that is not your password".
INVALID_CREDENTIALS_DETAIL = "Invalid credentials"


class DeleteAccountRequest(BaseModel):
    # extra="forbid" for the same reason signup has it: this body must never be
    # able to carry a field that steers the delete (an id, a supplier_id).
    model_config = ConfigDict(extra="forbid")

    password: str


@router.get("/me")
def me(db: Session = Depends(get_db), user: User = Depends(require_account_user)):
    full_name = " ".join(p for p in (user.first_name, user.last_name) if p).strip()
    return {
        "id": str(user.id),
        "full_name": full_name or user.username,
        "email": user.email,
        "created_at": user.created_at,
        "tier": account_tier(db, user),
        "activated": user.activated_at is not None,
        # D18 — capability is the links. Both may be set (Avnet).
        "is_supplier": user.supplier_id is not None,
        "is_manufacturer": user.manufacturer_id is not None,
    }


@router.delete("/me")
def delete_me(
    body: DeleteAccountRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_account_user),
):
    """Danger Zone. Deletes the LOGIN and that user's messages.

    Never the linked Supplier, never a Sponsor, never anything in Stripe: a
    live placement is paid inventory on a public board, and cancelling it
    because someone closed their sign-in would be destroying revenue. An
    account is a key to the building, not the building.

    The only rows that follow the user out are the ones whose FK says so:
    ``messages.user_id`` is ON DELETE CASCADE (that customer's own inbox, and
    ONLY theirs — a public form submission carries user_id NULL and stays),
    while ``bom_shares.user_id`` and ``calendar_events.created_by_id`` are ON
    DELETE SET NULL, so the artifact survives, unowned.
    """
    # Re-authenticate: a stolen session must not be able to destroy an account.
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=INVALID_CREDENTIALS_DETAIL,
        )
    db.delete(user)  # messages cascade via the FK; nothing else is touched
    db.commit()
    return {"status": "ok"}
