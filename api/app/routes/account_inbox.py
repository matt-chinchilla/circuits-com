"""The customer's own inbox.

One table, two doors. ``messages.user_id`` NULL is the shared STAFF inbox —
every public form submission and every pre-043 row — and a populated value is
exactly one person's mail. This router is the customer's door and it never
opens onto the other side of that line; ``routes/admin_messages`` is the staff
door and, since the same review that produced this file, never opens onto this
one.

Three things here are decisions, not defaults.

**A row that is not yours is 404, never 403.** A 403 says "it exists and you
may not have it", which is an existence oracle for message ids. Every
id-addressed handler below resolves the row THROUGH the scope filter, so a
message belonging to another customer and a message that was never created
produce the identical reply, byte for byte. There is no branch that can be made
to answer differently, because there is no branch: the row is simply not found.

**A customer's PATCH is a two-valued read flag, not the staff workflow.**
``messages.status`` also carries 'archived' and 'responded', ``assigned_to``
routes a queue between four staff, and ``spam_score`` is anti-abuse
bookkeeping. None of that is the recipient's to set, so the body is
``{"read": bool}`` with ``extra="forbid"``: an attempt to name a staff field is
REFUSED with a 422 rather than quietly dropped, because a silently-ignored
field lets a client believe it worked.

**The response is a narrow projection, not the row.** It omits the staff
workflow fields for the reason above, and it omits ``seq`` — which is a GLOBAL
counter across every message in the table, so handing it to a customer would
publish the company's total inbound volume and, across two logins, its rate.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Message
from app.services.account_scope import AccountScope, account_scope, messages_visible_to

router = APIRouter(
    prefix="/api/account",
    tags=["account-inbox"],
    # Every route here is scoped, so the scope dependency IS the gate: it
    # resolves through require_account_user, which refuses staff and refuses an
    # unactivated customer (D17). A route in this file cannot forget it.
    dependencies=[Depends(account_scope)],
)

# The one reply for "not yours" and for "no such row" alike. A single constant
# so the two can never drift into distinguishable bodies.
MESSAGE_NOT_FOUND_DETAIL = "message_not_found"

# What "read" means on the wire, mapped onto the column the staff inbox shares.
# 'new' rather than a nullable flag because status is NOT NULL and 'new' is its
# default: marking unread returns the row to the state it was created in.
READ_STATUS = "read"
UNREAD_STATUS = "new"


class InboxMessage(BaseModel):
    """What the recipient sees. Deliberately smaller than ``MessageResponse``."""

    id: str
    type: str
    read: bool
    created_at: datetime
    payload: dict


class InboxMessageUpdate(BaseModel):
    # extra="forbid" is the enforcement, not the docstring: without it a body
    # naming `assigned_to` or `status: "responded"` would be accepted and
    # ignored, and the caller could not tell the difference from success.
    model_config = ConfigDict(extra="forbid")

    read: bool


def _projection(msg: Message) -> dict:
    """Read is derived from ``status``, never from ``read_at``.

    ``read_at`` is the durable fact "first opened at T" and survives a later
    mark-as-unread, so it would answer the wrong question here.
    """
    return {
        "id": msg.id,
        "type": msg.type,
        "read": msg.status == READ_STATUS,
        "created_at": msg.created_at,
        "payload": msg.payload,
    }


def _my_message(db: Session, scope: AccountScope, message_id: str) -> Message:
    """Resolve an id THROUGH the scope, or 404.

    The filter and the lookup are one query on purpose: a two-step "fetch then
    compare" is where an ownership check gets forgotten, inverted, or turned
    into a 403.
    """
    msg = db.query(Message).filter(Message.id == message_id, messages_visible_to(scope)).first()
    if msg is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=MESSAGE_NOT_FOUND_DETAIL)
    return msg


@router.get("/messages", response_model=list[InboxMessage])
def list_my_messages(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """This customer's mail, newest first. Never the staff inbox.

    Keyed on the USER, not the company: two colleagues at the same distributor
    each have their own inbox, and ``messages_visible_to`` is what says so.
    """
    rows = (
        db.query(Message)
        .filter(messages_visible_to(scope))
        .order_by(Message.created_at.desc())
        .all()
    )
    return [_projection(msg) for msg in rows]


@router.get("/messages/{message_id}", response_model=InboxMessage)
def get_my_message(
    message_id: str,
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    return _projection(_my_message(db, scope, message_id))


@router.patch("/messages/{message_id}", response_model=InboxMessage)
def mark_my_message(
    message_id: str,
    body: InboxMessageUpdate,
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """Mark one of MY messages read or unread. That is the whole verb."""
    msg = _my_message(db, scope, message_id)

    updates: dict[str, object] = {"status": READ_STATUS if body.read else UNREAD_STATUS}
    # Stamp on the FIRST read only — same rule the staff inbox follows. The
    # timestamp records when this person first opened it, and toggling the flag
    # back and forth must not keep rewriting history.
    if body.read and msg.read_at is None:
        updates["read_at"] = datetime.now(UTC)
    for key, value in updates.items():
        setattr(msg, key, value)

    db.commit()
    db.refresh(msg)
    return _projection(msg)
