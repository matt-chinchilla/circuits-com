"""Transactional email composition and delivery via aiosmtplib.

Used by the form routes to notify the configured recipients
(settings.NOTIFY_RECIPIENTS) when someone submits Contact, Join, or
Keyword-Request forms - and to send auto-reply confirmations to applicants.

Demo mode: when settings.SMTP_HOST is None, _smtp_send logs the message
instead of opening a connection. This lets local dev and the test suite
work without a real mailbox password.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, tzinfo
from email.message import EmailMessage
from html import escape
from zoneinfo import ZoneInfo

import aiosmtplib

from app.config import settings
from app.models.calendar_event import safe_meeting_url

logger = logging.getLogger(__name__)


async def _smtp_send(message: EmailMessage) -> bool:
    """Send a prepared EmailMessage. Demo-mode aware. Catches SMTP errors.

    Returns True only if the relay accepted the message; False for demo mode
    and for any failure. It still does not RAISE — every original caller is a
    BackgroundTask where the response is long gone and an exception has nowhere
    to go, so that behaviour is unchanged and those callers simply ignore the
    result.

    The return value exists for the calendar reminder job, which is not a
    background task: it records a permanent "this was sent" row, so it has to
    be able to tell a delivery from a swallowed failure. Without this it read
    a dead relay as success — verified against a real one, where a pass over a
    due event reported `sent=1` while nothing left the building.
    """
    if not settings.SMTP_HOST:
        # WARNING level so it surfaces under uvicorn's default log config
        # (which suppresses INFO from non-uvicorn loggers). Demo mode is a
        # notable signal — operators want to see it without tweaking config.
        logger.warning(
            "[email demo-mode] would send to=%s subject=%r",
            message["To"],
            message["Subject"],
        )
        return False

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
        return False
    return True


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
        "New contact submission via circuitcenter.ai:\n"
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
        "New supplier-onboarding submission via circuitcenter.ai:\n"
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
        f"Thanks for applying to list {form.company_name} on Circuit Center.\n"
        "\n"
        "Our team will review your submission and get back to you within\n"
        "1-2 business days. If you have time-sensitive questions, you can reach\n"
        "us directly at matthew@circuitcenter.ai.\n"
        "\n"
        "- The Circuit Center Team\n"
    )
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = form.email
    msg["Subject"] = "We received your application — Circuit Center"
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
        "New keyword-sponsorship request via circuitcenter.ai:\n"
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
        "We received a request to reset the password on your Circuit Center\n"
        "account. Use the secure link below to choose a new password:\n"
        "\n"
        f"{reset_url}\n"
        "\n"
        "This link expires in 30 minutes and can only be used once. If you didn't\n"
        "request a reset, you can safely ignore this email — your password won't\n"
        "change.\n"
        "\n"
        "- The Circuit Center Team\n"
    )
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to_email
    msg["Subject"] = "Reset your Circuit Center password"
    msg.set_content(body)
    return msg


def _build_username_reminder(to_email: str, usernames: list[str]) -> EmailMessage:
    """Compose the forgot-username email listing the account's username(s)."""
    listed = "\n".join(f"  - {u}" for u in usernames)
    body = (
        "Hi,\n"
        "\n"
        "You asked us to remind you of the username on your Circuit Center account.\n"
        f"The {'usernames' if len(usernames) > 1 else 'username'} linked to this "
        "email address:\n"
        "\n"
        f"{listed}\n"
        "\n"
        "Head to https://circuitcenter.ai/admin/login to sign in. If you didn't make\n"
        "this request, you can ignore this email.\n"
        "\n"
        "- The Circuit Center Team\n"
    )
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to_email
    msg["Subject"] = "Your Circuit Center username"
    msg.set_content(body)
    return msg


# ── Calendar reminders (2026-08-04 shared calendar) ────────────────────────
# Sent by app/jobs/send_reminders.py, not by a request. Addressed to the fixed
# mailbox roster (settings.CALENDAR_RECIPIENTS), not to per-event attendees —
# an attendees field is the obvious next step and is not needed to ship.


def _event_timezone() -> tzinfo:
    """The configured display timezone, falling back to UTC.

    A reminder that states the WRONG time is worse than one that says "UTC" out
    loud, so a missing tzdata entry degrades to UTC rather than guessing.
    """
    try:
        return ZoneInfo(settings.CALENDAR_TIMEZONE)
    except Exception:
        logger.warning(
            "[calendar] unknown CALENDAR_TIMEZONE %r — falling back to UTC",
            settings.CALENDAR_TIMEZONE,
        )
        return UTC


def _format_when(starts_at: datetime, ends_at: datetime, all_day: bool) -> str:
    """Human "when" line, rendered in the configured timezone.

    Inputs are aware-UTC (the job normalizes with
    ``models.calendar_event.as_utc``); a naive value is read as UTC rather than
    as the server's local clock, which is what every other datetime path in
    this codebase does.
    """
    tz = _event_timezone()
    start = (starts_at if starts_at.tzinfo else starts_at.replace(tzinfo=UTC)).astimezone(tz)
    end = (ends_at if ends_at.tzinfo else ends_at.replace(tzinfo=UTC)).astimezone(tz)
    if all_day:
        return start.strftime("%A, %B %-d, %Y (all day)")
    label = start.strftime("%A, %B %-d, %Y at %-I:%M %p")
    if end.date() == start.date():
        return f"{label} - {end.strftime('%-I:%M %p %Z')}"
    return f"{label} {start.strftime('%Z')} - {end.strftime('%A, %B %-d at %-I:%M %p %Z')}"


def format_event_when(starts_at: datetime, ends_at: datetime, *, all_day: bool = False) -> str:
    """Public face of ``_format_when``, so the SMS channel can share the clock.

    The two channels formatted the same event independently — this one through
    CALENDAR_TIMEZONE, the SMS one hard-coded to UTC — and an event with both
    switched on told you "2:00 PM EDT" in your inbox and "18:00 UTC" on your
    phone. One formatter, one answer.
    """
    return _format_when(starts_at, ends_at, all_day)


def _build_event_reminder(
    to_emails: list[str],
    *,
    title: str,
    starts_at: datetime,
    ends_at: datetime,
    all_day: bool = False,
    location: str | None = None,
    meeting_url: str | None = None,
    notes: str | None = None,
    lead_label: str = "soon",
) -> EmailMessage:
    """Compose one calendar reminder. Pure — returns the message, sends nothing.

    ``meeting_url`` goes through ``safe_meeting_url`` even though the write
    boundary already validated it and this body is plain text: a row written
    before the validator existed (or by hand in psql) must not be able to put a
    ``javascript:`` string in front of five people, and mail clients autolink.
    """
    lines = [
        f"Reminder: {title}",
        "",
        f"When:  {_format_when(starts_at, ends_at, all_day)}",
    ]
    if location:
        lines.append(f"Where: {location}")
    link = safe_meeting_url(meeting_url)
    if link:
        lines.append(f"Join:  {link}")
    if notes:
        lines += ["", "Notes:", "---", notes, "---"]
    lines += [
        "",
        "This is an automated reminder from the Circuit Center shared calendar.",
        "",
    ]

    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = ", ".join(to_emails)
    msg["Subject"] = f"Reminder ({lead_label}): {title}"
    msg.set_content("\n".join(lines))
    return msg


async def send_event_reminder(to_emails: list[str], **event) -> bool:
    """Email the roster one calendar reminder. True only if the relay took it.

    Unlike every other sender here this one is NOT fire-and-forget: the caller
    writes a permanent ledger row on success, so it must be able to tell a
    delivery from a swallowed failure.
    """
    return await _smtp_send(_build_event_reminder(to_emails, **event))


async def send_password_reset(to_email: str, username: str, reset_url: str) -> None:
    """Email the account holder a secure password-reset link. Demo-mode aware."""
    await _smtp_send(_build_password_reset(to_email, username, reset_url))


async def send_username_reminder(to_email: str, usernames: list[str]) -> None:
    """Email the account holder their username(s). Demo-mode aware."""
    await _smtp_send(_build_username_reminder(to_email, usernames))


# ── Account lifecycle mail (alembic 043) ────────────────────────────────────
# The only HTML mail in this codebase. Constraints, all learned the hard way by
# everyone who has ever sent HTML mail:
#   * inline styles only — no <style> block survives Gmail reliably
#   * table layout, max-width 600px
#   * NO remote images. They are blocked by default, and fetching one confirms
#     to the sender that the address is live.
# Every message carries a text/plain part saying the same thing, so a text-only
# reader still gets the link.

_MAIL_MAX_WIDTH = 600
_INK = "#1a1f23"
_GREEN = "#44bd13"


def _html_shell(heading: str, body_html: str, cta_label: str = "", cta_url: str = "") -> str:
    """Wrap already-escaped body markup in the shared table shell.

    `body_html` is markup by contract — callers escape anything user-typed
    before it gets here (see _greeting_html).
    """
    button = ""
    if cta_label and cta_url:
        href = escape(cta_url, quote=True)
        button = (
            f'<tr><td style="padding:24px 0 8px 0;">'
            f'<a href="{href}" style="background:{_GREEN};color:#ffffff;'
            f"text-decoration:none;padding:13px 26px;border-radius:6px;"
            f'font-weight:600;display:inline-block;">{escape(cta_label)}</a></td></tr>'
            f'<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">'
            f"If the button does not work, paste this into your browser:<br>"
            f'<span style="color:{_INK};word-break:break-all;">{href}</span>'
            f"</td></tr>"
        )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:#eef1f5;padding:32px 0;">'
        f'<tr><td align="center">'
        f'<table role="presentation" width="{_MAIL_MAX_WIDTH}" cellpadding="0" '
        f'cellspacing="0" style="max-width:{_MAIL_MAX_WIDTH}px;background:#ffffff;'
        f"border-radius:10px;padding:32px;font-family:-apple-system,Segoe UI,"
        f'Helvetica,Arial,sans-serif;color:{_INK};">'
        f'<tr><td style="font-size:22px;font-weight:700;padding-bottom:12px;">'
        f"{heading}</td></tr>"
        f'<tr><td style="font-size:15px;line-height:1.6;">{body_html}</td></tr>'
        f"{button}"
        f'<tr><td style="padding-top:28px;color:#6b7280;font-size:12px;'
        f'border-top:1px solid #eef1f5;">Circuit Center</td></tr>'
        f"</table></td></tr></table>"
    )


def _build_html_email(*, to_email: str, subject: str, text: str, html: str) -> EmailMessage:
    """One multipart/alternative message. set_content then add_alternative
    puts text/plain first, which is the order the RFC wants."""
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    return msg


def _greeting(first_name: str | None) -> str:
    return f"Hi {first_name}" if first_name else "Hi"


def _greeting_html(first_name: str | None) -> str:
    """The same greeting, safe to drop into markup.

    first_name is whatever the registrant typed, so it is escaped on the way
    into the HTML part. The text/plain part keeps it verbatim.
    """
    return _greeting(escape(first_name) if first_name else None)


def _build_verification_email(
    to_email: str, first_name: str | None, verify_url: str
) -> EmailMessage:
    text = (
        f"{_greeting(first_name)},\n\n"
        "Confirm your email address to finish setting up your Circuit Center\n"
        "account:\n\n"
        f"{verify_url}\n\n"
        "This link expires in 24 hours. If you did not create an account, you\n"
        "can ignore this email.\n\n"
        "- Circuit Center\n"
    )
    html = _html_shell(
        "Confirm your email",
        f"{_greeting_html(first_name)} — confirm this address to finish setting up "
        "your Circuit Center account. The link expires in 24 hours.",
        "Confirm email",
        verify_url,
    )
    return _build_html_email(
        to_email=to_email,
        subject="Confirm your email — Circuit Center",
        text=text,
        html=html,
    )


def _build_welcome_email(to_email: str, first_name: str | None) -> EmailMessage:
    text = (
        f"{_greeting(first_name)},\n\n"
        "Your email is confirmed. A member of our team reviews new accounts\n"
        "before switching them on — we will email you the moment yours is\n"
        "ready.\n\n"
        "- Circuit Center\n"
    )
    html = _html_shell(
        "Email confirmed",
        f"{_greeting_html(first_name)} — your email is confirmed. A member of our "
        "team reviews new accounts before switching them on, and we will email "
        "you the moment yours is ready.",
    )
    return _build_html_email(
        to_email=to_email,
        subject="Email confirmed — Circuit Center",
        text=text,
        html=html,
    )


def _build_activation_email(
    to_email: str, first_name: str | None, account_url: str
) -> EmailMessage:
    text = (
        f"{_greeting(first_name)},\n\n"
        "Your Circuit Center account is live. Sign in to see it:\n\n"
        f"{account_url}\n\n"
        "- Circuit Center\n"
    )
    html = _html_shell(
        "Your account is live",
        f"{_greeting_html(first_name)} — your Circuit Center account is switched on. "
        "Sign in whenever you are ready.",
        "Open my account",
        account_url,
    )
    return _build_html_email(
        to_email=to_email,
        subject="Your account is live — Circuit Center",
        text=text,
        html=html,
    )


async def send_verification_email(to_email: str, first_name: str | None, verify_url: str) -> bool:
    """Email the registrant their one-time verification link. Demo-mode aware."""
    return await _smtp_send(_build_verification_email(to_email, first_name, verify_url))


async def send_welcome_email(to_email: str, first_name: str | None) -> bool:
    """Confirm the address landed and say a human reviews the account next."""
    return await _smtp_send(_build_welcome_email(to_email, first_name))


async def send_activation_email(to_email: str, first_name: str | None, account_url: str) -> bool:
    """Tell the customer an admin switched their account on."""
    return await _smtp_send(_build_activation_email(to_email, first_name, account_url))
