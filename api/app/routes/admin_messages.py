"""Admin inbox CRUD for the messages table.

Backs the React admin /admin/messages page. Public-form handlers
(routes/forms.py) write rows; this router reads them back and lets the
admin mutate status/assignment/reply-body in place.
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
from app.services.auth_service import get_current_user, is_demo_user, require_owner
from app.services.demo_messages import demo_messages, find_demo_message

router = APIRouter(prefix="/api/admin/messages", tags=["admin-messages"])

# One request may name at most this many ids. The inbox selects rows the
# operator can actually see, so a legitimate batch is small; the cap is what
# stops a single crafted request turning into a table-wide DELETE.
MAX_BULK_DELETE_IDS = 200

# ── Why the demo gets a different inbox ──────────────────────────────────────
# These rows are REAL public form submissions: the name, email, phone and
# free-text message of members of the public. `POST /api/auth/demo` puts an
# anonymous visitor one click from this table, so a demo session is served a
# synthetic roster instead (app/services/demo_messages.py). The read-only gate
# in get_current_user stops the demo WRITING; this stops it READING other
# people's contact details.


@router.get("/", response_model=list[MessageResponse])
def list_messages(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if is_demo_user(current_user):
        return demo_messages()
    return db.query(Message).order_by(Message.created_at.desc()).all()


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
# verbs and `get_current_user` 403s `demo_account_read_only` on every write from
# that session (allowlist, not blocklist — no per-route opt-in to forget).


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
    deleted = db.query(Message).filter(Message.id.in_(unique_ids)).delete(synchronize_session=False)
    db.commit()
    return {"deleted": deleted, "missing": len(unique_ids) - deleted}


@router.delete("/{message_id}", response_model=MessageDeleteResponse)
def delete_message(
    message_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_owner),
):
    msg = db.query(Message).filter(Message.id == message_id).first()
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
    if is_demo_user(current_user):
        # Never falls through to the real table on a miss: a demo id that
        # doesn't match is a 404, not a lookup of somebody's real message.
        demo = find_demo_message(message_id)
        if demo is None:
            raise HTTPException(404, "Message not found")
        return demo
    msg = db.query(Message).filter(Message.id == message_id).first()
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
    msg = db.query(Message).filter(Message.id == message_id).first()
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
