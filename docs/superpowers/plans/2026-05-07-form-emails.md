# Form Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/api/contact`, `/api/join`, and `/api/keyword-request` actually deliver email via Hover SMTP — drop the inert n8n hop, send via FastAPI `BackgroundTasks` + `aiosmtplib`.

**Architecture:** Frontend already wired correctly (no changes there). Each route validates Pydantic, schedules a background task, returns 200. Background task composes a `MIMEText` and `await aiosmtplib.send(...)` to `mail.hover.com:587` (STARTTLS). When `SMTP_HOST` is unset, the service runs in demo mode and logs the message instead of sending — local dev needs no creds. Notifications default to `no-reply@circuits.com` (loopback test); flip to `john@/mike@` via env var.

**Tech Stack:** FastAPI 0.115 · `aiosmtplib>=3.0.0` (new) · pydantic-settings · pytest + pytest-asyncio · Docker Compose (dev + prod).

**Spec:** [`docs/superpowers/specs/2026-05-07-form-emails-design.md`](../specs/2026-05-07-form-emails-design.md)

**Estimated:** 3–4 hours of focused work.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `api/pyproject.toml` | modify | Add `aiosmtplib` dep |
| `api/app/config.py` | modify | Add SMTP settings (host, port, user, password, from, recipients) |
| `api/app/services/email.py` | **create** | All email composition + send. 4 send functions + 1 helper + 4 composers. ~150 LOC. |
| `api/app/routes/forms.py` | rewrite | Replace n8n webhook with `BackgroundTasks.add_task(...)` calls |
| `api/tests/test_forms.py` | rewrite | Update existing 3 tests; remove httpx mocks; add SMTP-mock assertions |
| `api/tests/test_email_service.py` | **create** | Unit tests for the 4 composer/sender functions, demo mode, SMTP-failure path |
| `docker-compose.yml` | modify | Add SMTP env vars to `api` service |
| `docker-compose.prod.yml` | modify | Same env vars on prod side (real values come from EC2 `.env`) |
| `CLAUDE.md` | modify | Add gotcha about SMTP creds in `.env` on prod EC2 |

---

## Task 1: Set up feature branch and verify dependencies install

**Files:**
- Modify: `api/pyproject.toml`

- [ ] **Step 1: Verify clean working tree on master**

```bash
cd /home/matthew/circuits-com && git status
```

Expected: `nothing to commit, working tree clean` and branch `master`.

- [ ] **Step 2: Reset and check out the `updates` branch**

```bash
git fetch origin
git checkout -B updates origin/master
```

Expected: `Switched to a new branch 'updates'` (or "Reset branch 'updates'"). `updates` now points at `master` HEAD (commit `7dc61cb` or later).

- [ ] **Step 3: Add `aiosmtplib` to dependencies in `api/pyproject.toml`**

Edit lines 5-18 of `api/pyproject.toml`. The current dependencies list ends with `"pyjwt>=2.8.0",` — insert `"aiosmtplib>=3.0.0",` after it.

```toml
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.34.0",
    "sqlalchemy>=2.0.0",
    "psycopg2-binary>=2.9.0",
    "alembic>=1.14.0",
    "pydantic-settings>=2.7.0",
    "httpx>=0.28.0",
    "email-validator>=2.0.0",
    "sqladmin>=0.20.0",
    "itsdangerous>=2.2.0",
    "bcrypt>=4.0.0",
    "pyjwt>=2.8.0",
    "aiosmtplib>=3.0.0",
]
```

- [ ] **Step 4: Install the new dependency locally**

```bash
cd /home/matthew/circuits-com/api && pip install -e ".[dev]"
```

Expected: `Successfully installed aiosmtplib-3.x.x` (alongside reinstalling `circuits-api`).

- [ ] **Step 5: Verify import works**

```bash
cd /home/matthew/circuits-com/api && python -c "import aiosmtplib; print(aiosmtplib.__version__)"
```

Expected: a version string `3.0.0` or higher prints. No `ModuleNotFoundError`.

- [ ] **Step 6: Commit the dependency change**

```bash
cd /home/matthew/circuits-com
git add api/pyproject.toml
git commit -m "deps(api): add aiosmtplib for transactional emails"
```

---

## Task 2: Extend Settings with SMTP configuration

**Files:**
- Modify: `api/app/config.py`

- [ ] **Step 1: Replace the contents of `api/app/config.py`**

```python
from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str
    N8N_WEBHOOK_BASE_URL: str = "http://n8n:5678"
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost"]
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "admin"
    ADMIN_SECRET_KEY: str = "change-me-in-production"

    # SMTP — when SMTP_HOST is unset, services/email.py runs in demo mode
    # (logs the email payload to stderr instead of sending). Lets local dev
    # work without exposing the prod mailbox password.
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_USERNAME: str | None = None
    SMTP_PASSWORD: str | None = None
    SMTP_FROM: str = "no-reply@circuits.com"
    # Loopback default so initial testing sends to no-reply@ itself. Flip to
    # ["john@circuits.com", "mike@circuits.com"] via env var override
    # (NOTIFY_RECIPIENTS=john@circuits.com,mike@circuits.com) once verified.
    NOTIFY_RECIPIENTS: list[str] = ["no-reply@circuits.com"]

    @field_validator("NOTIFY_RECIPIENTS", "CORS_ORIGINS", mode="before")
    @classmethod
    def _split_csv(cls, v):
        """Accept either a JSON list OR a comma-separated string from env vars.

        pydantic-settings v2 only auto-parses JSON for list fields by default.
        This validator lets compose set NOTIFY_RECIPIENTS=a@x.com,b@y.com
        without forcing the operator to write JSON syntax in env vars.
        """
        if isinstance(v, str):
            stripped = v.strip()
            if stripped.startswith("["):
                # Let pydantic do its normal JSON parsing.
                return v
            return [s.strip() for s in stripped.split(",") if s.strip()]
        return v


settings = Settings()
```

- [ ] **Step 2: Verify config loads without error**

```bash
cd /home/matthew/circuits-com/api && DATABASE_URL=sqlite:///./test.db python -c "from app.config import settings; print(settings.SMTP_HOST, settings.SMTP_FROM, settings.NOTIFY_RECIPIENTS)"
```

Expected: `None no-reply@circuits.com ['no-reply@circuits.com']`.

- [ ] **Step 3: Commit**

```bash
cd /home/matthew/circuits-com
git add api/app/config.py
git commit -m "feat(api): add SMTP settings to config (loopback default for testing)"
```

---

## Task 3: Create services/email.py with helper + demo-mode behavior (TDD)

**Files:**
- Create: `api/app/services/email.py`
- Create: `api/tests/test_email_service.py`

- [ ] **Step 1: Write the failing demo-mode test**

Create `api/tests/test_email_service.py`:

```python
"""Tests for app.services.email — the SMTP-and-compose layer."""
import logging
from email.message import EmailMessage
from unittest.mock import AsyncMock, patch

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
```

- [ ] **Step 2: Run the test to verify it fails for the right reason**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py::test_smtp_send_demo_mode_logs_does_not_call_smtp -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.email'`.

- [ ] **Step 3: Create the minimal module**

Create `api/app/services/email.py`:

```python
"""Transactional email composition and delivery via aiosmtplib.

Used by the form routes to notify John and Mike (or, during testing, the
no-reply@ mailbox itself) when someone submits Contact, Join, or
Keyword-Request forms — and to send auto-reply confirmations to applicants.

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
        # Don't re-raise — we're in a BackgroundTask, the response is already
        # gone. Log with full message context so failures are debuggable.
        logger.exception(
            "[email] SMTP send failed; to=%s subject=%r",
            message["To"],
            message["Subject"],
        )
```

- [ ] **Step 4: Run the test again to verify it passes**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py::test_smtp_send_demo_mode_logs_does_not_call_smtp -v
```

Expected: PASS.

- [ ] **Step 5: Add a failing test for the SMTP-real-call path**

Append to `api/tests/test_email_service.py`:

```python
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
```

- [ ] **Step 6: Run and verify it passes (implementation already covers this)**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py -v
```

Expected: 2 tests pass.

- [ ] **Step 7: Add a failing test for the SMTP-failure-doesn't-raise path**

Append to `api/tests/test_email_service.py`:

```python
@pytest.mark.asyncio
async def test_smtp_send_swallows_exceptions_and_logs(caplog, monkeypatch):
    """SMTP failure must not propagate (we're in a BackgroundTask)."""
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
```

- [ ] **Step 8: Run and verify it passes**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py -v
```

Expected: 3 tests pass.

- [ ] **Step 9: Commit**

```bash
cd /home/matthew/circuits-com
git add api/app/services/email.py api/tests/test_email_service.py
git commit -m "feat(api): add email service skeleton with demo mode + SMTP failure handling"
```

---

## Task 4: Implement send_contact_notification (TDD)

**Files:**
- Modify: `api/app/services/email.py`
- Modify: `api/tests/test_email_service.py`

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_email_service.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py::test_send_contact_notification_composes_correct_message -v
```

Expected: FAIL with `AttributeError: module 'app.services.email' has no attribute 'send_contact_notification'`.

- [ ] **Step 3: Add the function to `api/app/services/email.py`**

After the `_smtp_send` function, add:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py -v
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/matthew/circuits-com
git add api/app/services/email.py api/tests/test_email_service.py
git commit -m "feat(api): add send_contact_notification email composer"
```

---

## Task 5: Implement send_join_notification (TDD)

**Files:**
- Modify: `api/app/services/email.py`
- Modify: `api/tests/test_email_service.py`

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_email_service.py`:

```python
@pytest.mark.asyncio
async def test_send_join_notification_includes_company_tier_categories(monkeypatch):
    """Join notification: subject mentions company, body has tier + categories."""
    from app.schemas import JoinForm
    from app.services import email as email_service

    monkeypatch.setattr(email_service.settings, "NOTIFY_RECIPIENTS", ["alerts@circuits.com"])
    monkeypatch.setattr(email_service.settings, "SMTP_FROM", "no-reply@circuits.com")
    monkeypatch.setattr(email_service.settings, "SMTP_HOST", "mail.hover.com")
    monkeypatch.setattr(email_service.settings, "SMTP_USERNAME", "x")
    monkeypatch.setattr(email_service.settings, "SMTP_PASSWORD", "y")

    form = JoinForm(
        company_name="Arrow Electronics",
        contact_person="Jane Buyer",
        email="jane@arrow.com",
        phone="631-555-0143",
        website="arrow.com",
        categories_of_interest=["Resistors", "Capacitors"],
        tier="platinum",
        message="We'd like priority placement.",
    )

    with patch("app.services.email.aiosmtplib.send", new_callable=AsyncMock) as mock_send:
        await email_service.send_join_notification(form)

    msg = mock_send.call_args[0][0]
    assert msg["From"] == "no-reply@circuits.com"
    assert msg["To"] == "alerts@circuits.com"
    assert msg["Reply-To"] == "jane@arrow.com"
    assert "Arrow Electronics" in msg["Subject"]
    body = msg.get_content()
    assert "Arrow Electronics" in body
    assert "Jane Buyer" in body
    assert "platinum" in body
    assert "Resistors" in body and "Capacitors" in body
    assert "priority placement" in body
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py::test_send_join_notification_includes_company_tier_categories -v
```

Expected: FAIL with `AttributeError: module 'app.services.email' has no attribute 'send_join_notification'`.

- [ ] **Step 3: Add the function to `api/app/services/email.py`**

After `send_contact_notification`, add:

```python
async def send_join_notification(form) -> None:
    """Notify recipients of a new supplier-onboarding submission."""
    categories = ", ".join(form.categories_of_interest) or "(none specified)"
    tier = form.tier or "(no tier selected)"
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
        f"Tier:       {tier}\n"
        f"Categories: {categories}\n"
        "\n"
        "Message:\n"
        "---\n"
        f"{extra_message}\n"
        "---\n"
        "\n"
        "Reply to this email to respond to the applicant directly.\n"
    )
    msg = _build_notification(
        subject=f"[Circuits Join] {form.company_name} wants to list ({tier})",
        reply_to=form.email,
        body=body,
    )
    await _smtp_send(msg)
```

- [ ] **Step 4: Run all email-service tests**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py -v
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/matthew/circuits-com
git add api/app/services/email.py api/tests/test_email_service.py
git commit -m "feat(api): add send_join_notification email composer"
```

---

## Task 6: Implement send_join_autoreply (TDD)

**Files:**
- Modify: `api/app/services/email.py`
- Modify: `api/tests/test_email_service.py`

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_email_service.py`:

```python
@pytest.mark.asyncio
async def test_send_join_autoreply_addresses_applicant(monkeypatch):
    """Join autoreply: To=applicant, From=no-reply, body greets contact_person."""
    from app.schemas import JoinForm
    from app.services import email as email_service

    monkeypatch.setattr(email_service.settings, "SMTP_FROM", "no-reply@circuits.com")
    monkeypatch.setattr(email_service.settings, "SMTP_HOST", "mail.hover.com")
    monkeypatch.setattr(email_service.settings, "SMTP_USERNAME", "x")
    monkeypatch.setattr(email_service.settings, "SMTP_PASSWORD", "y")

    form = JoinForm(
        company_name="Arrow Electronics",
        contact_person="Jane Buyer",
        email="jane@arrow.com",
        phone="631-555-0143",
        categories_of_interest=[],
    )

    with patch("app.services.email.aiosmtplib.send", new_callable=AsyncMock) as mock_send:
        await email_service.send_join_autoreply(form)

    msg = mock_send.call_args[0][0]
    assert msg["From"] == "no-reply@circuits.com"
    assert msg["To"] == "jane@arrow.com"
    assert "Reply-To" not in msg  # auto-reply doesn't need one
    assert "received" in msg["Subject"].lower() or "circuits" in msg["Subject"].lower()
    body = msg.get_content()
    assert "Jane Buyer" in body
    assert "Arrow Electronics" in body
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py::test_send_join_autoreply_addresses_applicant -v
```

Expected: FAIL with `AttributeError: module 'app.services.email' has no attribute 'send_join_autoreply'`.

- [ ] **Step 3: Add the function to `api/app/services/email.py`**

After `send_join_notification`, add:

```python
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
```

- [ ] **Step 4: Run all email-service tests**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py -v
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/matthew/circuits-com
git add api/app/services/email.py api/tests/test_email_service.py
git commit -m "feat(api): add send_join_autoreply for supplier applicants"
```

---

## Task 7: Implement send_keyword_notification (TDD)

**Files:**
- Modify: `api/app/services/email.py`
- Modify: `api/tests/test_email_service.py`

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_email_service.py`:

```python
@pytest.mark.asyncio
async def test_send_keyword_notification_includes_keyword(monkeypatch):
    """Keyword notification: subject and body feature the keyword prominently."""
    from app.schemas import KeywordRequestForm
    from app.services import email as email_service

    monkeypatch.setattr(email_service.settings, "NOTIFY_RECIPIENTS", ["alerts@circuits.com"])
    monkeypatch.setattr(email_service.settings, "SMTP_FROM", "no-reply@circuits.com")
    monkeypatch.setattr(email_service.settings, "SMTP_HOST", "mail.hover.com")
    monkeypatch.setattr(email_service.settings, "SMTP_USERNAME", "x")
    monkeypatch.setattr(email_service.settings, "SMTP_PASSWORD", "y")

    form = KeywordRequestForm(
        company_name="Vishay Intertechnology",
        email="partnerships@vishay.com",
        keyword="low-noise op-amps",
        message="12-month commit OK.",
    )

    with patch("app.services.email.aiosmtplib.send", new_callable=AsyncMock) as mock_send:
        await email_service.send_keyword_notification(form)

    msg = mock_send.call_args[0][0]
    assert msg["From"] == "no-reply@circuits.com"
    assert msg["To"] == "alerts@circuits.com"
    assert msg["Reply-To"] == "partnerships@vishay.com"
    assert "low-noise op-amps" in msg["Subject"]
    body = msg.get_content()
    assert "Vishay Intertechnology" in body
    assert "low-noise op-amps" in body
    assert "12-month commit OK." in body
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py::test_send_keyword_notification_includes_keyword -v
```

Expected: FAIL with `AttributeError: module 'app.services.email' has no attribute 'send_keyword_notification'`.

- [ ] **Step 3: Add the function to `api/app/services/email.py`**

After `send_join_autoreply`, add:

```python
async def send_keyword_notification(form) -> None:
    """Notify recipients of a new keyword-sponsorship request."""
    extra_message = form.message or "(no message)"
    body = (
        "New keyword-sponsorship request via circuits.com:\n"
        "\n"
        f"Company: {form.company_name}\n"
        f"Email:   {form.email}\n"
        f"Keyword: {form.keyword}\n"
        "\n"
        "Message:\n"
        "---\n"
        f"{extra_message}\n"
        "---\n"
        "\n"
        "Reply to this email to respond to the applicant directly.\n"
    )
    msg = _build_notification(
        subject=f"[Circuits Keyword] {form.keyword} — {form.company_name}",
        reply_to=form.email,
        body=body,
    )
    await _smtp_send(msg)
```

- [ ] **Step 4: Run all email-service tests**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_email_service.py -v
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/matthew/circuits-com
git add api/app/services/email.py api/tests/test_email_service.py
git commit -m "feat(api): add send_keyword_notification email composer"
```

---

## Task 8: Rewrite forms.py to schedule BackgroundTasks (TDD)

**Files:**
- Rewrite: `api/app/routes/forms.py`
- Rewrite: `api/tests/test_forms.py`

- [ ] **Step 1: Replace `api/tests/test_forms.py` with the new tests**

```python
"""Tests for /api/contact, /api/join, /api/keyword-request endpoints.

The route handlers schedule email sends as FastAPI BackgroundTasks. Each
test patches services.email.* and asserts the route returned 200 + that
the correct background functions were registered.
"""
from unittest.mock import AsyncMock, patch


def test_contact_form_valid_schedules_notification_only(client):
    """POST /api/contact returns 200 and schedules send_contact_notification."""
    payload = {
        "name": "Alice Smith",
        "email": "alice@example.com",
        "subject": "Test inquiry",
        "message": "Hello, this is a test message.",
    }
    with patch("app.routes.forms.send_contact_notification", new_callable=AsyncMock) as mock_notify:
        response = client.post("/api/contact", json=payload)

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    mock_notify.assert_called_once()
    sent_form = mock_notify.call_args[0][0]
    assert sent_form.email == "alice@example.com"
    assert sent_form.subject == "Test inquiry"


def test_contact_form_invalid_email(client):
    """POST /api/contact with invalid email returns 422 (Pydantic validation)."""
    payload = {
        "name": "Bob Jones",
        "email": "not-an-email",
        "subject": "Test",
        "message": "Test message",
    }
    response = client.post("/api/contact", json=payload)
    assert response.status_code == 422


def test_join_form_valid_schedules_notification_AND_autoreply(client):
    """POST /api/join schedules BOTH the notification and the auto-reply."""
    payload = {
        "company_name": "Acme Electronics",
        "contact_person": "Jane Doe",
        "email": "jane@acme.com",
        "phone": "555-123-4567",
        "website": "https://acme.com",
        "categories_of_interest": ["Integrated Circuits"],
        "tier": "gold",
        "message": "We want to join.",
    }
    with patch("app.routes.forms.send_join_notification", new_callable=AsyncMock) as mock_notify:
        with patch("app.routes.forms.send_join_autoreply", new_callable=AsyncMock) as mock_autoreply:
            response = client.post("/api/join", json=payload)

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    mock_notify.assert_called_once()
    mock_autoreply.assert_called_once()
    notify_form = mock_notify.call_args[0][0]
    autoreply_form = mock_autoreply.call_args[0][0]
    assert notify_form.company_name == "Acme Electronics"
    assert autoreply_form.email == "jane@acme.com"


def test_keyword_request_valid_schedules_notification(client):
    """POST /api/keyword-request schedules send_keyword_notification."""
    payload = {
        "company_name": "Vishay",
        "email": "partnerships@vishay.com",
        "keyword": "low-noise op-amps",
        "message": "12-month commit OK.",
    }
    with patch("app.routes.forms.send_keyword_notification", new_callable=AsyncMock) as mock_notify:
        response = client.post("/api/keyword-request", json=payload)

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    mock_notify.assert_called_once()
    sent_form = mock_notify.call_args[0][0]
    assert sent_form.keyword == "low-noise op-amps"
```

- [ ] **Step 2: Run the tests to verify they fail correctly**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_forms.py -v
```

Expected: 3 tests FAIL with `AttributeError: module 'app.routes.forms' has no attribute 'send_contact_notification'` (and similar for the other two). The `invalid_email` test should still pass (it doesn't touch the new attrs).

- [ ] **Step 3: Replace `api/app/routes/forms.py` with the new implementation**

```python
"""Form-submission routes — Contact, Join, Keyword Request.

Each route validates the incoming Pydantic schema and schedules email
sends as FastAPI BackgroundTasks. The handler returns immediately so the
client doesn't wait on SMTP. Sends are processed after the response is
flushed (still in the request lifecycle, no Celery/Redis required).

The previous n8n webhook hop has been removed — it was inert (workflows
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
```

- [ ] **Step 4: Run the form tests**

```bash
cd /home/matthew/circuits-com/api && pytest tests/test_forms.py -v
```

Expected: 4 tests pass.

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

```bash
cd /home/matthew/circuits-com/api && pytest tests/ -v
```

Expected: all tests pass (existing ~110 + 7 new email-service + 4 form-route = ~120). Pay attention to the count and any unexpected failures.

- [ ] **Step 6: Commit**

```bash
cd /home/matthew/circuits-com
git add api/app/routes/forms.py api/tests/test_forms.py
git commit -m "feat(api): replace n8n webhook with BackgroundTasks for form emails"
```

---

## Task 9: Add SMTP env vars to docker-compose.yml and docker-compose.prod.yml

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Update the `api` service environment in `docker-compose.yml`**

Find the `api:` service block (lines 18–30 in `docker-compose.yml`). Replace its `environment:` map with:

```yaml
    environment:
      DATABASE_URL: postgresql://circuits:circuits@db:5432/circuits
      N8N_WEBHOOK_BASE_URL: http://n8n:5678
      ADMIN_USERNAME: john
      ADMIN_PASSWORD: circuits2026
      ADMIN_SECRET_KEY: change-me-in-production
      SMTP_HOST: ${SMTP_HOST:-}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_USERNAME: ${SMTP_USERNAME:-}
      SMTP_PASSWORD: ${SMTP_PASSWORD:-}
      SMTP_FROM: ${SMTP_FROM:-no-reply@circuits.com}
      NOTIFY_RECIPIENTS: ${NOTIFY_RECIPIENTS:-no-reply@circuits.com}
```

The `${VAR:-}` syntax means: if `VAR` is unset in the environment or `.env` file, the var is empty inside the container — which triggers demo mode in `services/email.py`.

- [ ] **Step 2: Mirror the env-var additions in `docker-compose.prod.yml`**

Add an `environment:` block to the `api:` service in `docker-compose.prod.yml` (currently lines 11–17). The override merges into the base service:

```yaml
  api:
    build:
      context: ./api
    command: >
      sh -c "alembic upgrade head &&
             python -m app.db.seed &&
             uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4"
    environment:
      SMTP_HOST: ${SMTP_HOST:-mail.hover.com}
      SMTP_PORT: ${SMTP_PORT:-587}
      SMTP_USERNAME: ${SMTP_USERNAME:-no-reply@circuits.com}
      SMTP_PASSWORD: ${SMTP_PASSWORD:-}
      SMTP_FROM: ${SMTP_FROM:-no-reply@circuits.com}
      NOTIFY_RECIPIENTS: ${NOTIFY_RECIPIENTS:-no-reply@circuits.com}
```

(Note: the prod override defaults `SMTP_HOST` to `mail.hover.com`. Empty `SMTP_PASSWORD` still triggers demo mode — won't actually send until you populate the `.env` on EC2.)

- [ ] **Step 3: Validate compose syntax**

```bash
cd /home/matthew/circuits-com && docker compose config > /dev/null
```

Expected: command exits 0, no syntax errors. (If you see warnings about env vars not set, that's fine — `${VAR:-}` defaults handle them.)

- [ ] **Step 4: Commit**

```bash
cd /home/matthew/circuits-com
git add docker-compose.yml docker-compose.prod.yml
git commit -m "chore(infra): add SMTP env vars to compose (defaults to demo mode)"
```

---

## Task 10: Update CLAUDE.md with the SMTP gotcha

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a gotcha to the `## Gotchas` section of `CLAUDE.md`**

Find the gotchas section. Add this bullet at the end of the list (after the last existing gotcha about the supplier list `response_model` stripping computed attributes):

```markdown
- **SMTP creds for forms live in `.env` on the prod EC2 host** — not committed. Populate `SMTP_HOST=mail.hover.com`, `SMTP_PORT=587`, `SMTP_USERNAME=no-reply@circuits.com`, `SMTP_PASSWORD=<from Hover admin>` in `/opt/circuits-com/.env` next to `docker-compose.prod.yml`. Without `SMTP_HOST` set, `app.services.email._smtp_send` runs in demo mode and logs the message instead of sending — local dev works without leaking creds. `NOTIFY_RECIPIENTS` defaults to `["no-reply@circuits.com"]` (loopback for testing); set the env var to `john@circuits.com,mike@circuits.com` (comma-separated, pydantic-settings parses it) when ready to flip.
- **n8n is no longer in the form-submission path** — `routes/forms.py` (post-2026-05-07) sends emails directly via `app.services.email` (aiosmtplib + Hover SMTP) using FastAPI `BackgroundTasks`. The n8n container stays in `docker-compose.yml` for future workflow needs but the webhook fire was removed because workflows were never auto-imported and SMTP creds were never wired. If you re-add n8n for a workflow, import it via the n8n CLI on first boot — copying JSON to `/home/node/.n8n/workflows/` does not auto-load.
```

- [ ] **Step 2: Verify CLAUDE.md still parses (basic sanity check — no syntax-checker, just eyeball)**

```bash
cd /home/matthew/circuits-com && wc -l CLAUDE.md && tail -20 CLAUDE.md
```

Expected: line count increased by ~4–6, the new gotchas appear at the end of the gotchas list.

- [ ] **Step 3: Commit**

```bash
cd /home/matthew/circuits-com
git add CLAUDE.md
git commit -m "docs(claude-md): document SMTP env vars and n8n removal from form path"
```

---

## Task 11: Local manual verification (rebuild api, submit forms, check logs)

**Files:**
- (no edits — verification only)

- [ ] **Step 1: Rebuild and restart the api container**

```bash
cd /home/matthew/circuits-com && docker compose up -d --build api
```

Expected: `api` container rebuilt and recreated. Log should show `Started server process` from uvicorn.

- [ ] **Step 2: Tail the api logs in a separate terminal (or use `--tail` here)**

```bash
docker compose logs --tail=20 -f api &
```

Keep this running for the next 3 steps.

- [ ] **Step 3: Submit a Contact form via curl**

```bash
curl -i -X POST http://localhost/api/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com","subject":"Test","message":"Hello from curl."}'
```

Expected: HTTP 200, body `{"status":"ok"}`. In the api log: a line like `[email demo-mode] would send to=no-reply@circuits.com subject='[Circuits Contact] Test — Test User'`.

- [ ] **Step 4: Submit a Join form via curl**

```bash
curl -i -X POST http://localhost/api/join \
  -H "Content-Type: application/json" \
  -d '{"company_name":"Test Corp","contact_person":"Jane Test","email":"jane@test.com","phone":"555-0100","categories_of_interest":["Resistors"],"tier":"gold","message":"From curl."}'
```

Expected: HTTP 200. In the api log: TWO demo-mode lines — one for the notification (`To=no-reply@circuits.com`, subject contains "Test Corp"), one for the auto-reply (`To=jane@test.com`, subject "We received your application").

- [ ] **Step 5: Submit a Keyword Request via curl**

```bash
curl -i -X POST http://localhost/api/keyword-request \
  -H "Content-Type: application/json" \
  -d '{"company_name":"Test Corp","email":"alice@test.com","keyword":"current sense amps","message":"Pilot interest."}'
```

Expected: HTTP 200. In the api log: a demo-mode line with `subject='[Circuits Keyword] current sense amps — Test Corp'`.

- [ ] **Step 6: Open the public site in a browser and submit the real Contact form**

Navigate to `http://localhost/contact`, fill in the form fields, click "Send Message →".

Expected: in-page success state ("Thanks, [name]. We'll reply to ..."). In `docker logs api`: another demo-mode line for the notification.

- [ ] **Step 7: Stop the log-tail and confirm no errors**

```bash
kill %1 2>/dev/null  # stops the backgrounded `docker compose logs -f`
docker compose logs --tail=100 api | grep -iE "error|traceback|exception"
```

Expected: no error/traceback lines from the form submissions. If aiosmtplib errors appear, the SMTP_HOST env var leaked in somehow — check `.env` and compose config.

- [ ] **Step 8: No commit (verification only). If everything looks good, proceed to Task 12.**

---

## Task 12: Code review and simplify pass

**Files:**
- Possibly modify: `api/app/services/email.py`, `api/app/routes/forms.py`

- [ ] **Step 1: Run `/simplify` on the new code**

Invoke the `simplify` skill manually:

```
/simplify
```

Then point it at `api/app/services/email.py` and `api/app/routes/forms.py`. It will scan for:
- Repeated body-composition patterns that could fold into a helper
- Unused imports
- Unused parameters
- Dead branches

Apply suggested edits if they preserve all test behavior. Re-run `pytest tests/test_email_service.py tests/test_forms.py -v` after each edit batch to confirm nothing regressed.

- [ ] **Step 2: Dispatch the `pr-review-toolkit:code-reviewer` agent**

Launch a review agent against the diff:

```
[Use Agent tool with subagent_type="pr-review-toolkit:code-reviewer"]
prompt: "Review the code change introducing form-email functionality. Files of interest:
api/app/services/email.py (new), api/app/routes/forms.py (rewritten),
api/app/config.py (added SMTP settings), api/tests/test_email_service.py (new),
api/tests/test_forms.py (rewritten). Spec at docs/superpowers/specs/2026-05-07-form-emails-design.md.
Check: SMTP failure handling, type safety, naming consistency,
test coverage of the spec's must-haves, adherence to project conventions
in CLAUDE.md (esp. error-handling style — no swallowed exceptions)."
```

- [ ] **Step 3: Dispatch the `pr-review-toolkit:silent-failure-hunter` agent**

```
[Use Agent tool with subagent_type="pr-review-toolkit:silent-failure-hunter"]
prompt: "Hunt for silent failures in api/app/services/email.py and api/app/routes/forms.py.
Special attention: the try/except in _smtp_send is intentional (we're in BackgroundTasks
post-response), but verify the catch is appropriately scoped and the log captures
enough context to diagnose. Flag anything else that swallows errors silently."
```

- [ ] **Step 4: Address any HIGH/CRITICAL findings from the agents**

If the agents return findings, fix them inline and re-run the test suite:

```bash
cd /home/matthew/circuits-com/api && pytest tests/ -v
```

Expected: all tests still pass after fixes.

- [ ] **Step 5: Commit any fixes from review**

```bash
cd /home/matthew/circuits-com
git add -A
git diff --cached --stat
git commit -m "refactor(api): code-review polish on email service"
```

(Skip this step if no fixes were needed.)

---

## Task 13: Merge to master and deploy (USER-GATED)

**Files:**
- (no edits — git + deploy operations only)

> ⚠️ **Stop here and confirm with the user before proceeding.** Phase 2 plan ends at Task 12. Deploy is its own decision; the user may want to:
> 1. Eyeball the diff first
> 2. Wait until they have the SMTP password from Hover before deploying (otherwise prod runs in demo mode too — no real harm, but no real test of the integration either)
> 3. Run a `/pr-review-toolkit:review-pr` cycle before merging

- [ ] **Step 1: Show the user the full diff summary**

```bash
cd /home/matthew/circuits-com && git log --oneline master..updates && git diff --stat master..updates
```

Expected: ~10 commits on `updates`, a stat summary showing `api/app/services/email.py` (new), `api/app/routes/forms.py` (rewritten), tests, compose files, CLAUDE.md.

- [ ] **Step 2: Confirm with user before continuing**

Wait for explicit "merge and deploy" / "ship it" direction. If they want changes, loop back to the relevant task. If they want to wait on the SMTP password, this branch can sit until then — demo-mode default means deploying it doesn't break prod.

- [ ] **Step 3 (after user approval): Merge `updates` → `master`**

```bash
cd /home/matthew/circuits-com
git checkout master
git merge --ff-only updates
```

Expected: fast-forward merge (no conflict, since `updates` was branched from `master` HEAD at start of Task 1).

- [ ] **Step 4: Push to origin**

```bash
git push origin master
```

Expected: `<old-sha>..<new-sha> master -> master`.

- [ ] **Step 5: Deploy to circuits.com**

```bash
cd /home/matthew/circuits-com && ./deploy.sh
```

Wait for it to complete (~3 min). Then chase with the nginx-restart workaround:

```bash
./deploy.sh --frontend
```

(See CLAUDE.md gotcha — `./deploy.sh` alone leaves nginx with stale upstream DNS; the `--frontend` chase rebuilds frontend cached + restarts nginx.)

- [ ] **Step 6: Live verification on circuits.com**

```bash
curl -i -X POST https://circuits.com/api/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Production Smoke Test","email":"test@example.com","subject":"deploy verification","message":"if you see this in the no-reply@ inbox, the pipeline works."}'
```

Expected: HTTP 200. Then SSH to EC2 and check the api log:

```bash
# (via mosh / ssh / instance-connect to EC2)
docker logs $(docker ps -qf name=api) --tail 50 | grep -iE "email|smtp"
```

Expected: a `[email demo-mode]` line if `SMTP_PASSWORD` isn't yet set on the host, OR a real send (no demo-mode prefix) if it is. No tracebacks.

- [ ] **Step 7 (when SMTP password ready): populate `.env` on EC2 and test real delivery**

```bash
# (via SSH on EC2)
sudo -i
cat >> /opt/circuits-com/.env <<EOF
SMTP_HOST=mail.hover.com
SMTP_PORT=587
SMTP_USERNAME=no-reply@circuits.com
SMTP_PASSWORD=<paste from Hover admin>
SMTP_FROM=no-reply@circuits.com
NOTIFY_RECIPIENTS=no-reply@circuits.com
EOF
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps api
```

Then re-run the smoke-test curl from Step 6 and verify the test message lands in the `no-reply@circuits.com` inbox at `mail.hover.com`.

- [ ] **Step 8: Run `/claude-md-management:revise-claude-md` to capture any new gotchas surfaced during implementation**

```
/claude-md-management:revise-claude-md
```

Argument: "Review the form-email implementation session for new gotchas worth persisting (e.g., aiosmtplib quirks, BackgroundTasks behavior in tests, Hover SMTP details discovered during deploy)."

Apply suggested CLAUDE.md additions if they're not already covered by the gotcha added in Task 10.

---

## Self-review (filled in by plan author)

**1. Spec coverage:**

| Spec section | Implementing task |
|---|---|
| Goal: deliver email on submit | Tasks 4–7 (composers) + Task 8 (route wiring) |
| Loopback test recipient | Task 2 (default in `Settings.NOTIFY_RECIPIENTS`) + Task 9 (compose env var defaults) |
| Auto-reply for Join only | Task 6 (`send_join_autoreply`) + Task 8 (route schedules both for Join, only notification for Contact/Keyword) |
| Reply-To = applicant email | Task 4–5 + 7 (`_build_notification` sets `Reply-To`) |
| `BackgroundTasks` non-blocking | Task 8 (route handlers use `BackgroundTasks` parameter) |
| Demo mode when SMTP_HOST unset | Task 3 (`_smtp_send` early-return + log) |
| Drop n8n hop | Task 8 (route file no longer imports httpx; CLAUDE.md updated in Task 10) |
| Failure handling: log, don't raise | Task 3 (`_smtp_send` try/except + Step 7 test) |
| Tests for happy + failure paths | Tasks 3–8 (TDD, ~11 tests total) |
| Env-var configuration | Task 9 (compose) + Task 2 (Settings) |
| CLAUDE.md gotcha | Task 10 |
| Production verification | Task 13 |

All spec must-haves covered. ✓

**2. Placeholder scan:** searched for "TBD", "TODO", "implement later", "similar to". None found.

**3. Type consistency:** all four `send_*` functions have signature `async def f(form) -> None`. The form parameter is duck-typed (each function accesses fields specific to its form type — `form.name`, `form.company_name`, etc.). All consumers pass the validated Pydantic instance. `_build_notification` uses keyword-only args.

---

## Execution Handoff

**Plan complete and saved to** `docs/superpowers/plans/2026-05-07-form-emails.md`. **Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — I execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
