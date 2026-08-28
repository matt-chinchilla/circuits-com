"""The registered-account roster. Staff-only.

These rows are real people's addresses and IP-derived locations. The demo
account that once made every authed page one click from anonymous is retired
(Task 1a), so require_staff is the whole gate.
"""

import uuid as uuid_mod
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Expense, Lead, Manufacturer, Supplier, User
from app.services import email as email_service
from app.services.account_tier import account_tier
from app.services.auth_service import require_owner, require_staff

# Refused body for an attempted deactivation. A machine-readable code, not
# prose: the console matches it to explain that the only way back is deletion.
ONE_WAY_DETAIL = "activation_is_one_way"

router = APIRouter(
    prefix="/api/admin/users",
    tags=["admin-users"],
    dependencies=[Depends(require_staff)],
)


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    activated: bool | None = None
    supplier_id: str | None = None
    manufacturer_id: str | None = None


def _row(db: Session, u: User) -> dict:
    supplier = (
        db.query(Supplier).filter(Supplier.id == u.supplier_id).first()
        if u.supplier_id
        else None
    )
    full_name = " ".join(p for p in (u.first_name, u.last_name) if p).strip()
    return {
        "id": str(u.id),
        "full_name": full_name or u.username,
        "email": u.email,
        "created_at": u.created_at,
        "signup_country": u.signup_country,
        # From the linked supplier, so "-" for an unlinked account, which is
        # most rows at launch and is correct rather than broken.
        "website": supplier.website if supplier else None,
        "company": supplier.name if supplier else None,
        "tier": account_tier(db, u),
        "email_verified_at": u.email_verified_at,
        "activated_at": u.activated_at,
        "supplier_id": str(u.supplier_id) if u.supplier_id else None,
        "manufacturer_id": str(u.manufacturer_id) if u.manufacturer_id else None,
    }


@router.get("/")
def list_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    # Unactivated first: the page's job is to show you who is waiting.
    rows = (
        db.query(User)
        .filter(User.role == "user")
        .order_by(User.activated_at.isnot(None), User.created_at.desc())
        .all()
    )
    return [_row(db, u) for u in rows]


def _as_uuid(raw: str | None):
    if raw in (None, ""):
        return None
    try:
        return uuid_mod.UUID(raw)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail="invalid_id") from None


def _linked_id(db: Session, model, raw: str | None, detail: str):
    """Resolve a capability link (D18) to a uuid that names a REAL row, or 4xx.

    A well-formed uuid naming nothing used to sail past ``_as_uuid`` and come
    back from ``db.commit()`` as an unhandled FK violation — a 500 on an admin
    form, which reads as "the server is broken" rather than "that company is
    gone". Checked here, before the write, so the answer can name WHICH link is
    wrong; a bare 500 named neither.
    """
    linked = _as_uuid(raw)
    if linked is None:
        return None
    if db.query(model.id).filter(model.id == linked).first() is None:
        raise HTTPException(status_code=422, detail=detail)
    return linked


@router.patch("/{user_id}")
def update_user(
    user_id: str,
    body: UserUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    user = db.query(User).filter(User.id == _as_uuid(user_id)).first()
    if user is None or user.role != "user":
        raise HTTPException(status_code=404, detail="not_found")

    fields = body.model_dump(exclude_unset=True)
    # Resolved BEFORE anything is mutated: a body carrying both an activation
    # and a dead supplier_id must not leave the activation pending on the
    # session after the 422 — the request either happens or it does not.
    links: dict[str, object] = {}
    if "supplier_id" in fields:
        links["supplier_id"] = _linked_id(db, Supplier, fields["supplier_id"], "unknown_supplier")
    if "manufacturer_id" in fields:
        links["manufacturer_id"] = _linked_id(
            db, Manufacturer, fields["manufacturer_id"], "unknown_manufacturer"
        )

    activating = False
    if "activated" in fields:
        if not fields["activated"]:
            # Activation is a ONE-WAY DOOR (owner decision, 2026-08-26). It is
            # refused here rather than merely hidden in the console, because an
            # invariant that lives only in the UI is not an invariant.
            #
            # This is also what makes the activation email safe. The old guard
            # was `if activated_at is None`, which correctly refused to re-send
            # while an account was ALREADY active — but deactivating set that
            # column back to NULL, so the next activation was a genuinely fresh
            # edge and mailed again (measured: one off/on cycle sent a second
            # email, two cycles a third). With no route back to NULL, the same
            # check now means "has never been activated", so no
            # email-already-sent column is needed.
            #
            # Revoking access is DELETE /api/admin/users/{id} (owner-only).
            raise HTTPException(status_code=409, detail=ONE_WAY_DETAIL)
        # Idempotent: pressing Activate on an active account is a no-op, never
        # a second welcome.
        if user.activated_at is None:
            user.activated_at = datetime.now(UTC)
            activating = True
    for attr, value in links.items():
        setattr(user, attr, value)
    db.commit()
    db.refresh(user)

    if activating:
        background_tasks.add_task(
            email_service.send_activation_email,
            user.email,
            user.first_name,
            f"{settings.APP_BASE_URL.rstrip('/')}/account?activated=1",
        )
    return _row(db, user)


@router.delete("/{user_id}")
def delete_user(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Owner-only, matching how message deletion is gated for being
    irreversible. Deletes the LOGIN — never the linked Supplier or Sponsor,
    and never anything in Stripe.

    It also deletes the two kinds of row the customer OWNED OUTRIGHT: their
    private expense lines and their private leads (migration 045). Those
    columns are plain UUIDs with no foreign key — deliberately, because an FK
    into `users` would enrol both tables in `deploy.sh --reseed`'s TRUNCATE
    CASCADE and a routine reseed would destroy the company's whole cost book
    and CRM. The price of that choice is that no cascade cleans up after a
    delete, so this handler pays it explicitly. Skip it and the rows outlive
    the account: invisible to staff (both staff lists filter `user_id IS
    NULL`), unreachable by their owner, and re-attachable to a stranger the
    day uuid4 ever repeats.

    `messages` is different and stays untouched here — it has a REAL
    `ON DELETE CASCADE` foreign key, which is safe because `messages` was
    already inside the reseed graph and is carried by hand in deploy.sh.
    """
    user = db.query(User).filter(User.id == _as_uuid(user_id)).first()
    if user is None or user.role != "user":
        raise HTTPException(status_code=404, detail="not_found")
    # Before the user row goes, while `user.id` is still the key to them.
    db.query(Expense).filter(Expense.user_id == user.id).delete(synchronize_session=False)
    db.query(Lead).filter(Lead.user_id == user.id).delete(synchronize_session=False)
    db.delete(user)  # messages cascade via the FK
    db.commit()
    return {"status": "ok"}
