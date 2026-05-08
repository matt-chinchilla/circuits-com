"""Form-submission routes — Contact, Join, Keyword Request.

Each route validates the incoming Pydantic schema and schedules email
sends as FastAPI BackgroundTasks. The handler returns immediately so the
client doesn't wait on SMTP. Sends are processed after the response is
flushed (still in the request lifecycle, no Celery/Redis required).

The previous n8n webhook hop has been removed - it was inert (workflows
weren't auto-imported and SMTP credentials weren't wired). The n8n service
remains in docker-compose for potential future workflow needs.
"""

from fastapi import APIRouter, BackgroundTasks

from app.schemas import ContactForm, JoinForm, KeywordRequestForm
from app.services.email import (
    send_contact_notification,
    send_join_autoreply,
    send_join_notification,
    send_keyword_notification,
)

router = APIRouter(prefix="/api", tags=["forms"])


@router.post("/contact")
async def contact(form: ContactForm, background_tasks: BackgroundTasks):
    background_tasks.add_task(send_contact_notification, form)
    return {"status": "ok"}


@router.post("/join")
async def join(form: JoinForm, background_tasks: BackgroundTasks):
    background_tasks.add_task(send_join_notification, form)
    background_tasks.add_task(send_join_autoreply, form)
    return {"status": "ok"}


@router.post("/keyword-request")
async def keyword_request(form: KeywordRequestForm, background_tasks: BackgroundTasks):
    background_tasks.add_task(send_keyword_notification, form)
    return {"status": "ok"}
