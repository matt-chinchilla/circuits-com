"""Transactional email composition and delivery via aiosmtplib.

Used by the form routes to notify John and Mike (or, during testing, the
no-reply@ mailbox itself) when someone submits Contact, Join, or
Keyword-Request forms - and to send auto-reply confirmations to applicants.

Demo mode: when settings.SMTP_HOST is None, _smtp_send logs the message
instead of opening a connection. This lets local dev and the test suite
work without a real mailbox password.
"""

from __future__ import annotations

import logging
from email.message import EmailMessage

import aiosmtplib

from app.config import settings

logger = logging.getLogger(__name__)


async def _smtp_send(message: EmailMessage) -> None:
    """Send a prepared EmailMessage. Demo-mode aware. Catches SMTP errors."""
    if not settings.SMTP_HOST:
        logger.info(
            "[email demo-mode] would send to=%s subject=%r",
            message["To"],
            message["Subject"],
        )
        return

    try:
        await aiosmtplib.send(
            message,
            hostname=settings.SMTP_HOST,
            port=settings.SMTP_PORT,
            username=settings.SMTP_USERNAME,
            password=settings.SMTP_PASSWORD,
            start_tls=True,
        )
    except Exception:
        # Don't re-raise - we're inside a BackgroundTask, the response is
        # already gone. Log with full message context so failures are
        # debuggable in `docker logs api`.
        logger.exception(
            "[email] SMTP send failed; to=%s subject=%r",
            message["To"],
            message["Subject"],
        )
