"""Tests for app.services.email - the SMTP-and-compose layer."""

import logging
from email.message import EmailMessage
from unittest.mock import AsyncMock, patch

import aiosmtplib
import pytest


@pytest.mark.asyncio
async def test_smtp_send_demo_mode_logs_does_not_call_smtp(caplog, monkeypatch):
    """When SMTP_HOST is unset, _smtp_send logs and skips aiosmtplib."""
    from app.services import email as email_service

    monkeypatch.setattr(email_service.settings, "SMTP_HOST", None)

    msg = EmailMessage()
    msg["From"] = "no-reply@circuits.com"
    msg["To"] = "test@example.com"
    msg["Subject"] = "Demo mode probe"
    msg.set_content("Hello from the test suite.")

    with patch("app.services.email.aiosmtplib.send", new_callable=AsyncMock) as mock_send:
        with caplog.at_level(logging.INFO, logger="app.services.email"):
            await email_service._smtp_send(msg)

    mock_send.assert_not_called()
    assert any("demo-mode" in rec.message for rec in caplog.records), (
        f"expected demo-mode log line, got: {[r.message for r in caplog.records]}"
    )


@pytest.mark.asyncio
async def test_smtp_send_calls_aiosmtplib_when_host_configured(monkeypatch):
    """When SMTP_HOST is set, _smtp_send delegates to aiosmtplib.send."""
    from app.services import email as email_service

    monkeypatch.setattr(email_service.settings, "SMTP_HOST", "mail.hover.com")
    monkeypatch.setattr(email_service.settings, "SMTP_PORT", 587)
    monkeypatch.setattr(email_service.settings, "SMTP_USERNAME", "no-reply@circuits.com")
    monkeypatch.setattr(email_service.settings, "SMTP_PASSWORD", "secret")

    msg = EmailMessage()
    msg["From"] = "no-reply@circuits.com"
    msg["To"] = "test@example.com"
    msg["Subject"] = "Real send probe"
    msg.set_content("body")

    with patch("app.services.email.aiosmtplib.send", new_callable=AsyncMock) as mock_send:
        await email_service._smtp_send(msg)

    mock_send.assert_called_once()
    _, kwargs = mock_send.call_args
    assert kwargs["hostname"] == "mail.hover.com"
    assert kwargs["port"] == 587
    assert kwargs["username"] == "no-reply@circuits.com"
    assert kwargs["password"] == "secret"
    assert kwargs["start_tls"] is True


@pytest.mark.asyncio
async def test_smtp_send_swallows_exceptions_and_logs(caplog, monkeypatch):
    """SMTP failure must not propagate (we're inside a BackgroundTask)."""
    from app.services import email as email_service

    monkeypatch.setattr(email_service.settings, "SMTP_HOST", "mail.hover.com")
    monkeypatch.setattr(email_service.settings, "SMTP_USERNAME", "user@x")
    monkeypatch.setattr(email_service.settings, "SMTP_PASSWORD", "pw")

    msg = EmailMessage()
    msg["From"] = "no-reply@circuits.com"
    msg["To"] = "test@example.com"
    msg["Subject"] = "Failure probe"
    msg.set_content("body")

    async def explode(*args, **kwargs):
        raise aiosmtplib.SMTPException("upstream blew up")

    with patch("app.services.email.aiosmtplib.send", side_effect=explode):
        with caplog.at_level(logging.ERROR, logger="app.services.email"):
            await email_service._smtp_send(msg)  # must not raise

    assert any("SMTP send failed" in rec.message for rec in caplog.records)


@pytest.mark.asyncio
async def test_send_contact_notification_composes_correct_message(monkeypatch):
    """Contact notification: To=NOTIFY_RECIPIENTS, Reply-To=applicant, body has fields."""
    from app.schemas import ContactForm
    from app.services import email as email_service

    monkeypatch.setattr(email_service.settings, "NOTIFY_RECIPIENTS", ["alerts@circuits.com"])
    monkeypatch.setattr(email_service.settings, "SMTP_FROM", "no-reply@circuits.com")
    monkeypatch.setattr(email_service.settings, "SMTP_HOST", "mail.hover.com")
    monkeypatch.setattr(email_service.settings, "SMTP_USERNAME", "x")
    monkeypatch.setattr(email_service.settings, "SMTP_PASSWORD", "y")

    form = ContactForm(
        name="Tom Reilly",
        email="t.reilly@gizmodo.com",
        subject="Press inquiry",
        message="Working on a comparison piece.",
    )

    with patch("app.services.email.aiosmtplib.send", new_callable=AsyncMock) as mock_send:
        await email_service.send_contact_notification(form)

    mock_send.assert_called_once()
    msg = mock_send.call_args[0][0]
    assert msg["From"] == "no-reply@circuits.com"
    assert msg["To"] == "alerts@circuits.com"
    assert msg["Reply-To"] == "t.reilly@gizmodo.com"
    assert "Press inquiry" in msg["Subject"]
    assert "Tom Reilly" in msg["Subject"]
    body = msg.get_content()
    assert "Tom Reilly" in body
    assert "t.reilly@gizmodo.com" in body
    assert "Press inquiry" in body
    assert "Working on a comparison piece." in body
