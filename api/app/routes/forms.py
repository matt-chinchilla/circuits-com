"""Form-submission routes — Contact, Join, Keyword Request.

Each route validates the incoming Pydantic schema, persists a Message
row, and schedules email sends as FastAPI BackgroundTasks. The handler
returns immediately so the client doesn't wait on SMTP. Sends are
processed after the response is flushed (still in the request lifecycle,
no Celery/Redis required).

Persistence happens BEFORE the background task is queued so a SMTP
failure can't lose the inbound submission — the admin Messages
dashboard sources from the `messages` table.

The previous n8n webhook hop has been removed - it was inert (workflows
weren't auto-imported and SMTP credentials weren't wired). The n8n service
remains in docker-compose for potential future workflow needs.
"""

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.message import Message
from app.schemas import ContactForm, JoinForm, KeywordRequestForm
from app.services.email import (
    send_contact_notification,
    send_join_autoreply,
    send_join_notification,
    send_keyword_notification,
)

router = APIRouter(prefix="/api", tags=["forms"])


def _next_seq(db: Session) -> int:
    """Single-sequence-space counter for the MSG-#### designator."""
    return (db.query(func.max(Message.seq)).scalar() or 0) + 1


@router.post("/contact")
async def contact(
    form: ContactForm,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    msg = Message(
        id=str(uuid.uuid4()),
        type="contact",
        status="new",
        seq=_next_seq(db),
        payload={
            "name": form.name,
            "email": form.email,
            "subject": form.subject,
            "message": form.message,
        },
    )
    db.add(msg)
    db.commit()
    background_tasks.add_task(send_contact_notification, form)
    return {"status": "ok", "message_id": msg.id}


@router.post("/join")
async def join(
    form: JoinForm,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    msg = Message(
        id=str(uuid.uuid4()),
        type="join",
        status="new",
        seq=_next_seq(db),
        payload={
            "company_name": form.company_name,
            "contact_person": form.contact_person,
            "email": form.email,
            "phone": form.phone,
            "website": form.website,
            "categories_of_interest": form.categories_of_interest,
            "tier": form.tier,
            "message": form.message,
        },
    )
    db.add(msg)
    db.commit()
    background_tasks.add_task(send_join_notification, form)
    background_tasks.add_task(send_join_autoreply, form)
    return {"status": "ok", "message_id": msg.id}


@router.post("/keyword-request")
async def keyword_request(
    form: KeywordRequestForm,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    msg = Message(
        id=str(uuid.uuid4()),
        type="keyword",
        status="new",
        seq=_next_seq(db),
        payload={
            "company_name": form.company_name,
            "email": form.email,
            "keyword": form.keyword,
            "name": form.name,
            "tier": form.tier,
            "message": form.message,
        },
    )
    db.add(msg)
    db.commit()
    background_tasks.add_task(send_keyword_notification, form)
    return {"status": "ok", "message_id": msg.id}
