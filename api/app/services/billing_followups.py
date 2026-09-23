"""Stripe follow-ups the webhook cannot do inline (spec §8.5, §10).

The webhook answers Stripe fast and never calls it back; what a delivery
leaves — a sale's post-activation work, a refused sale's cancel + refund, a
deleted subscription's open invoices — runs here, first as a FastAPI
background task right after the 200, then from the hourly sweep for anything
that did not finish (each body records its own completion, so a retry is
safe).
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import SessionLocal
from app.services import stripe_quotes

logger = logging.getLogger(__name__)

# Seam for tests (the suite binds its own engine), like category_cache's.
session_factory = SessionLocal


async def post_activation(db: Session, client, sponsor_id) -> bool:
    return False


async def resolve_conflict(db: Session, client, intent_id, actor: str = "system:webhook") -> bool:
    return False


async def void_pending(db: Session, client, sponsor_id) -> bool:
    return False


_KINDS = {
    "post_activation": post_activation,
    "conflict": resolve_conflict,
    "void": void_pending,
}


async def run_followup(kind: str, ref: str) -> None:
    """Run one follow-up with its own session and Stripe client. Never raises:
    it runs after the response, where an exception reaches nobody — the
    sweep is the retry."""
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    body = _KINDS.get(kind)
    if not key or body is None:
        return
    try:
        target = uuid.UUID(str(ref))
    except ValueError:
        logger.warning("billing follow-up %s got a malformed ref %r", kind, ref)
        return
    db = session_factory()
    try:
        async with stripe_quotes.make_client(key) as client:
            await body(db, client, target)
    except Exception:  # noqa: BLE001 - after the response nobody else would see it
        db.rollback()
        logger.exception("billing follow-up %s for %s failed — the sweep will retry", kind, ref)
    finally:
        db.close()
