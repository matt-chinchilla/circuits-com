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
        # WARNING level so it surfaces under uvicorn's default log config
        # (which suppresses INFO from non-uvicorn loggers). Demo mode is a
        # notable signal — operators want to see it without tweaking config.
        logger.warning(
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


def _build_notification(
    *,
    subject: str,
    reply_to: str,
    body: str,
) -> EmailMessage:
    """Compose a notification email (to NOTIFY_RECIPIENTS, with Reply-To)."""
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = ", ".join(settings.NOTIFY_RECIPIENTS)
    msg["Reply-To"] = reply_to
    msg["Subject"] = subject
    msg.set_content(body)
    return msg


async def send_contact_notification(form) -> None:
    """Notify recipients that someone submitted the Contact form."""
    body = (
        "New contact submission via circuits.com:\n"
        "\n"
        f"Name:    {form.name}\n"
        f"Email:   {form.email}\n"
        f"Subject: {form.subject}\n"
        "\n"
        "Message:\n"
        "---\n"
        f"{form.message}\n"
        "---\n"
        "\n"
        "Reply to this email to respond to the applicant directly.\n"
    )
    msg = _build_notification(
        subject=f"[Circuits Contact] {form.subject} — {form.name}",
        reply_to=form.email,
        body=body,
    )
    await _smtp_send(msg)


async def send_join_notification(form) -> None:
    """Notify recipients of a new supplier-onboarding submission."""
    categories = ", ".join(form.categories_of_interest) or "(none specified)"
    tier_display = form.tier or "(no tier selected)"
    extra_message = form.message or "(no message)"
    website = form.website or "(none)"
    body = (
        "New supplier-onboarding submission via circuits.com:\n"
        "\n"
        f"Company:    {form.company_name}\n"
        f"Contact:    {form.contact_person}\n"
        f"Email:      {form.email}\n"
        f"Phone:      {form.phone}\n"
        f"Website:    {website}\n"
        f"Tier:       {tier_display}\n"
        f"Categories: {categories}\n"
        "\n"
        "Message:\n"
        "---\n"
        f"{extra_message}\n"
        "---\n"
        "\n"
        "Reply to this email to respond to the applicant directly.\n"
    )
    # Subject only shows tier when explicitly set — avoids "((no tier selected))"
    # double-paren ugliness when applicants skip the optional field.
    subject_tail = f" ({form.tier})" if form.tier else ""
    msg = _build_notification(
        subject=f"[Circuits Join] {form.company_name} wants to list{subject_tail}",
        reply_to=form.email,
        body=body,
    )
    await _smtp_send(msg)


async def send_join_autoreply(form) -> None:
    """Confirm receipt of a Join submission to the applicant."""
    body = (
        f"Hi {form.contact_person},\n"
        "\n"
        f"Thanks for applying to list {form.company_name} on Circuits.com.\n"
        "\n"
        "John and Mike will review your submission and get back to you within\n"
        "1-2 business days. If you have time-sensitive questions, you can reach\n"
        "us directly at john@circuits.com or mike@circuits.com.\n"
        "\n"
        "- The Circuits.com Team\n"
    )
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = form.email
    msg["Subject"] = "We received your application — Circuits.com"
    msg.set_content(body)
    await _smtp_send(msg)


async def send_sponsor_rep_notification(sponsor_data: dict, payload: dict, request_id: str) -> None:
    """Notify recipients that someone clicked "Talk to a Rep" on a sponsor banner.

    Takes plain primitive dicts — NOT ORM instances. FastAPI's
    `Depends(get_db)` finalizer can close the session before BackgroundTasks
    fully execute on some Starlette versions; lazy-loading
    `sponsor.supplier.name` from inside this function would raise
    DetachedInstanceError which `_smtp_send`'s broad except would mask as a
    silent "SMTP failed" with no email ever delivered. The route materializes
    everything it needs before scheduling the task.

    sponsor_data keys: company_name, contact_name, role, phone, email, hours, division
    payload keys (mirror Message.payload JSON): name, email, note
    """
    requester_name = payload.get("name") or "(no name)"
    requester_email = payload.get("email") or ""
    note = payload.get("note") or "(no note)"

    company_name = sponsor_data.get("company_name") or "(unknown sponsor)"
    rep_name = sponsor_data.get("contact_name") or "(no rep name on file)"
    rep_role = sponsor_data.get("role") or "(no role on file)"
    rep_phone = sponsor_data.get("phone") or "(no phone on file)"
    rep_email = sponsor_data.get("email") or "(no rep email on file)"
    rep_hours = sponsor_data.get("hours") or "(no hours on file)"
    division = sponsor_data.get("division") or "(no division on file)"

    body = (
        "New sponsor-rep request via circuits.com:\n"
        "\n"
        f"Request ID: {request_id}\n"
        f"Sponsor:    {company_name}\n"
        f"Division:   {division}\n"
        "\n"
        "Rep contact (forwarded from sponsor record):\n"
        f"  Name:  {rep_name}\n"
        f"  Role:  {rep_role}\n"
        f"  Phone: {rep_phone}\n"
        f"  Email: {rep_email}\n"
        f"  Hours: {rep_hours}\n"
        "\n"
        "Requester:\n"
        f"  Name:  {requester_name}\n"
        f"  Email: {requester_email}\n"
        "\n"
        "Note:\n"
        "---\n"
        f"{note}\n"
        "---\n"
        "\n"
        "Reply to this email to respond to the requester directly.\n"
    )
    subject_tail = f" ({sponsor_data['division']})" if sponsor_data.get("division") else ""
    msg = _build_notification(
        subject=f"[Sponsor Rep Request] {company_name}{subject_tail}",
        reply_to=requester_email or settings.SMTP_FROM,
        body=body,
    )
    await _smtp_send(msg)


async def send_keyword_notification(form) -> None:
    """Notify recipients of a new keyword-sponsorship request.

    V2 design parity (2026-05-16): the body now lists Name + Tier alongside
    the existing fields, and the subject appends ` (tier)` when the user picked
    one in the modal's tier-preference selector. Mirrors the JoinForm pattern
    so recipients can scan their inbox by tier without opening every email.
    """
    extra_message = form.message or "(no message)"
    tier_display = form.tier or "(no tier selected)"
    body = (
        "New keyword-sponsorship request via circuits.com:\n"
        "\n"
        f"Company: {form.company_name}\n"
        f"Name:    {form.name}\n"
        f"Email:   {form.email}\n"
        f"Keyword: {form.keyword}\n"
        f"Tier:    {tier_display}\n"
        "\n"
        "Message:\n"
        "---\n"
        f"{extra_message}\n"
        "---\n"
        "\n"
        "Reply to this email to respond to the applicant directly.\n"
    )
    # Subject only shows tier when explicitly set — avoids the
    # "((no tier selected))" double-paren ugliness, same convention as
    # send_join_notification's subject_tail.
    subject_tail = f" ({form.tier})" if form.tier else ""
    msg = _build_notification(
        subject=f"[Circuits Keyword] {form.keyword} — {form.company_name}{subject_tail}",
        reply_to=form.email,
        body=body,
    )
    await _smtp_send(msg)
