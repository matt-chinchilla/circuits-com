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


# ── Account recovery (2026-06-13 admin login redesign) ─────────────────────
# Unlike the form notifications above (which go to NOTIFY_RECIPIENTS), these are
# addressed to the account holder. The pure _build_* helpers return the message
# so they can be unit-tested without an SMTP connection; the async wrappers send.


def _build_password_reset(to_email: str, username: str, reset_url: str) -> EmailMessage:
    """Compose the password-reset email (one secure link, 30-minute validity)."""
    body = (
        f"Hi {username},\n"
        "\n"
        "We received a request to reset the password on your Circuits.com\n"
        "account. Use the secure link below to choose a new password:\n"
        "\n"
        f"{reset_url}\n"
        "\n"
        "This link expires in 30 minutes and can only be used once. If you didn't\n"
        "request a reset, you can safely ignore this email — your password won't\n"
        "change.\n"
        "\n"
        "- The Circuits.com Team\n"
    )
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to_email
    msg["Subject"] = "Reset your Circuits.com password"
    msg.set_content(body)
    return msg


def _build_username_reminder(to_email: str, usernames: list[str]) -> EmailMessage:
    """Compose the forgot-username email listing the account's username(s)."""
    listed = "\n".join(f"  - {u}" for u in usernames)
    body = (
        "Hi,\n"
        "\n"
        "You asked us to remind you of the username on your Circuits.com account.\n"
        f"The {'usernames' if len(usernames) > 1 else 'username'} linked to this "
        "email address:\n"
        "\n"
        f"{listed}\n"
        "\n"
        "Head to https://circuits.com/admin/login to sign in. If you didn't make\n"
        "this request, you can ignore this email.\n"
        "\n"
        "- The Circuits.com Team\n"
    )
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to_email
    msg["Subject"] = "Your Circuits.com username"
    msg.set_content(body)
    return msg


async def send_password_reset(to_email: str, username: str, reset_url: str) -> None:
    """Email the account holder a secure password-reset link. Demo-mode aware."""
    await _smtp_send(_build_password_reset(to_email, username, reset_url))


async def send_username_reminder(to_email: str, usernames: list[str]) -> None:
    """Email the account holder their username(s). Demo-mode aware."""
    await _smtp_send(_build_username_reminder(to_email, usernames))
