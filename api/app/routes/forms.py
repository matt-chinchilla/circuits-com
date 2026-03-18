import logging
import httpx
from fastapi import APIRouter
from app.config import settings
from app.schemas import ContactForm, JoinForm, KeywordRequestForm

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["forms"])


async def fire_webhook(path: str, data: dict):
    """Fire n8n webhook, gracefully handle failures."""
    url = f"{settings.N8N_WEBHOOK_BASE_URL}/webhook/{path}"
    try:
        async with httpx.AsyncClient() as client:
            await client.post(url, json=data, timeout=5.0)
    except Exception as e:
        logger.warning(f"n8n webhook failed ({url}): {e}")


@router.post("/contact")
async def contact(form: ContactForm):
    await fire_webhook("contact", form.model_dump())
    return {"status": "ok"}


@router.post("/join")
async def join(form: JoinForm):
    await fire_webhook("supplier-onboard", form.model_dump())
    return {"status": "ok"}


@router.post("/keyword-request")
async def keyword_request(form: KeywordRequestForm):
    await fire_webhook("keyword-request", form.model_dump())
    return {"status": "ok"}
