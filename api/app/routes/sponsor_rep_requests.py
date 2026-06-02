"""POST /api/sponsor-rep-request — public "talk to a rep" request from
the CategorySponsorBanner.

Mirrors the routes/forms.py pattern: validate Pydantic body, persist a
Message row (so the admin /admin/messages dashboard sees it), then
schedule the SMTP notification as a FastAPI BackgroundTask.

The request_id returned to the caller is derived from `Message.seq`
(NOT message.id — the UUID is too long to read off a confirmation
chip). Format is f"CS-{seq:06X}" — six uppercase hex chars covers a
seq space of ~16M, well past the demo lifetime.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Sponsor
from app.models.message import Message
from app.services.email import send_sponsor_rep_notification

router = APIRouter(prefix="/api", tags=["sponsor-rep-requests"])


class SponsorRepRequestForm(BaseModel):
    sponsor_id: uuid.UUID
    # Bounded at the validator boundary so a scripted abuse POST cannot
    # blow up the messages.payload JSON column or the SMTP body. Realistic
    # UX bounds — a 120-char name and 2 KB note are well past any genuine
    # rep request.
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    note: str | None = Field(default=None, max_length=2000)


def _next_seq(db: Session) -> int:
    """Single-sequence-space counter shared across all Message types."""
    return (db.query(func.max(Message.seq)).scalar() or 0) + 1


@router.post("/sponsor-rep-request")
async def sponsor_rep_request(
    form: SponsorRepRequestForm,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    sponsor = db.query(Sponsor).filter(Sponsor.id == form.sponsor_id).first()
    if not sponsor:
        raise HTTPException(status_code=404, detail="Sponsor not found")

    msg = Message(
        id=str(uuid.uuid4()),
        type="sponsor_rep_request",
        status="new",
        seq=_next_seq(db),
        payload={
            "sponsor_id": str(form.sponsor_id),
            "name": form.name,
            "email": form.email,
            "note": form.note,
        },
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # Materialize every field the email composer needs into plain
    # primitives BEFORE scheduling the background task. The
    # `Depends(get_db)` session may be torn down before the task runs;
    # lazy-loading `sponsor.supplier.name` after that point raises
    # DetachedInstanceError which `_smtp_send`'s broad except would
    # silently swallow as a fake "SMTP failed" log.
    sponsor_data = {
        "company_name": sponsor.supplier.name if sponsor.supplier else None,
        "contact_name": sponsor.contact_name,
        "role": sponsor.role,
        "phone": sponsor.phone,
        "email": sponsor.email,
        "hours": sponsor.hours,
        "division": sponsor.division,
    }
    request_id = f"CS-{msg.seq:06X}"
    # Build the requester payload from the validated form directly, NOT
    # from msg.payload — the ORM-attached JSON column is typed Column[Any]
    # and pulling primitives from `form` keeps the BackgroundTask
    # ORM-free top to bottom.
    requester_payload = {"name": form.name, "email": form.email, "note": form.note}
    background_tasks.add_task(
        send_sponsor_rep_notification, sponsor_data, requester_payload, request_id
    )
    return {"request_id": request_id}
