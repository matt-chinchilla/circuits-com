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
from app.schemas.messages import MessageResponse, MessageUpdate
from app.services.auth_service import get_current_user, is_demo_user
from app.services.demo_messages import demo_messages, find_demo_message

router = APIRouter(prefix="/api/admin/messages", tags=["admin-messages"])

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
