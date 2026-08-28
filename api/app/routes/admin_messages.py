"""Admin inbox CRUD for the messages table.

Backs the React admin /admin/messages page. Public-form handlers
(routes/forms.py) write rows; this router reads them back and lets the
admin mutate status/assignment/reply-body in place.

THE STAFF INBOX IS ``user_id IS NULL`` AND NOTHING ELSE (2026-08-25).
``messages`` is one table with two audiences. A NULL ``user_id`` is the
company's own correspondence — every public contact/join/keyword submission and
the `signup` notice — and that is what this router exists to work. A populated
``user_id`` is one customer's personal mail (their `welcome` row today, their
whole console inbox tomorrow), which arrives here only because it shares a
table, and which no staff workflow acts on: nobody assigns it, nobody replies to
it, nobody marks it read on the customer's behalf. It was being listed anyway,
because ``MessageResponse`` omits ``user_id`` and nothing filtered — so the
staff inbox showed rows that are not staff mail and gave no way to tell.

So the filter lives on EVERY query in this file, not just the list. An
id-addressed route is the same leak through a narrower door, and bulk-delete is
the dangerous one: a single crafted request naming ids the operator was never
shown would otherwise delete customers' mail out from under them. A customer row
is simply not in this collection, so it reads 404 and counts as `missing`.

Staff needing to see a customer's account act on the CUSTOMER (/api/admin/users)
— which is also where deleting one takes their inbox with it, by FK cascade.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Message, User
from app.schemas.messages import (
    MessageBulkDeleteRequest,
    MessageBulkDeleteResponse,
    MessageDeleteResponse,
    MessageResponse,
    MessageUpdate,
)
from app.services.auth_service import get_current_user, require_owner, require_staff

router = APIRouter(
    prefix="/api/admin/messages",
    tags=["admin-messages"],
    # The customer/staff wall (D16) sits on the router: everything served
    # here is company-wide STAFF data, so an activated customer is refused
    # with 403 staff_only rather than admitted as a console user. It COMPOSES
    # with the per-route get_current_user gates — it does not replace them.
    dependencies=[Depends(require_staff)],
)

# One request may name at most this many ids. The inbox selects rows the
# operator can actually see, so a legitimate batch is small; the cap is what
# stops a single crafted request turning into a table-wide DELETE.
MAX_BULK_DELETE_IDS = 200

# The staff inbox, as a WHERE clause. One home, applied by every query below:
# a rule spelled out five times is a rule that gets forgotten once. It must stay
# `.is_(None)` — `== None` works but reads as an equality test, and an equality
# test against NULL is exactly the mistake this file is fixing the other side of.
STAFF_INBOX_ONLY = Message.user_id.is_(None)


@router.get("/", response_model=list[MessageResponse])
def list_messages(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return db.query(Message).filter(STAFF_INBOX_ONLY).order_by(Message.created_at.desc()).all()


# ── Deletes ─────────────────────────────────────────────────────────────────
# DECLARED BEFORE the `/{message_id}` routes on purpose: a path parameter would
# happily match the literal segment "bulk-delete" and try to delete a message
# with that id. Registration order is what keeps the two apart — do not move
# these below.
#
# Both are OWNER-ONLY (2026-08-19 owner decision): deletion is irreversible and
# these rows are real public correspondence, so `require_owner` 403s
# `owner_only` for every other admin. It composes with — never replaces —
# get_current_user, which still runs first: an unauthenticated caller gets 401
# and the demo account never reaches either body, because both are mutating


@router.post("/bulk-delete", response_model=MessageBulkDeleteResponse)
def bulk_delete_messages(
    body: MessageBulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    """Delete many messages in ONE transaction.

    Unknown ids are counted, not fatal: the client's selection list is a
    snapshot and rows legitimately disappear underneath it.
    """
    if len(body.ids) > MAX_BULK_DELETE_IDS:
        raise HTTPException(422, "too_many_ids")

    # dict.fromkeys dedups while preserving the caller's order, so a list that
    # names the same row twice reports one deletion, not two.
    unique_ids = list(dict.fromkeys(body.ids))
    if not unique_ids:
        # An empty selection is a no-op, not an error.
        return {"deleted": 0, "missing": 0}

    # ONE statement, ONE commit: the batch lands whole or not at all. Never a
    # per-id loop with a commit inside — a failure halfway would leave the
    # inbox in a state neither the operator nor the client asked for.
    deleted = (
        db.query(Message)
        .filter(Message.id.in_(unique_ids), STAFF_INBOX_ONLY)
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"deleted": deleted, "missing": len(unique_ids) - deleted}


@router.delete("/{message_id}", response_model=MessageDeleteResponse)
def delete_message(
    message_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    msg = db.query(Message).filter(Message.id == message_id, STAFF_INBOX_ONLY).first()
    if not msg:
        raise HTTPException(404, "Message not found")
    # Nothing references messages (no FK, no association row), so the delete is
    # a single-table operation — unlike suppliers, which cascade 8 surfaces.
    db.delete(msg)
    db.commit()
    return {"status": "ok"}


@router.get("/{message_id}", response_model=MessageResponse)
def get_message(
    message_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    msg = db.query(Message).filter(Message.id == message_id, STAFF_INBOX_ONLY).first()
    if not msg:
        raise HTTPException(404, "Message not found")
    return msg


@router.patch("/{message_id}", response_model=MessageResponse)
def update_message(
    message_id: str,
    body: MessageUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    msg = db.query(Message).filter(Message.id == message_id, STAFF_INBOX_ONLY).first()
    if not msg:
        raise HTTPException(404, "Message not found")

    update_data = body.model_dump(exclude_unset=True)

    # Status transition side-effects: stamp read_at / responded_at on first
    # transition only — never overwrite a pre-existing timestamp. Folded into
    # update_data so the single setattr loop below applies everything (avoids
    # direct Column[datetime] assignment that trips Pyright).
    if "status" in update_data:
        new_status = update_data["status"]
        if new_status == "read" and msg.read_at is None:
            update_data["read_at"] = datetime.now(UTC)
        if new_status == "responded" and msg.responded_at is None:
            update_data["responded_at"] = datetime.now(UTC)

    for key, value in update_data.items():
        setattr(msg, key, value)

    db.commit()
    db.refresh(msg)
    return msg
