# Form Emails — Design Spec

**Date:** 2026-05-07
**Status:** Awaiting user review
**Owner:** Matthew

## Goal

Make the **Contact** (`/contact`) and **Join** (`/join`) form submit buttons actually deliver email when clicked:

- Notify the configured recipients for every submission. **Default for testing: `no-reply@circuits.com` (loopback to self)** so we can verify the pipeline end-to-end without bothering John/Mike yet. Flip to `john@circuits.com, mike@circuits.com` via env var override once verified.
- Auto-reply to the applicant for **Join** submissions only (Contact gets the in-page success state but no email)
- Sender: `no-reply@circuits.com` (real Hover mailbox at `mail.hover.com:587`)
- `Reply-To` on notifications = applicant's email, so when notifications eventually flip to John/Mike, they can hit Reply and respond to the applicant directly. (Works the same way during loopback testing — Matthew can verify by replying from the no-reply mailbox.)

## Non-goals

- Building the **Messages** admin tab right now (future-work; design is forward-compatible)
- Persisting form submissions to the database (deferred — see Future Work)
- Bounce/complaint dashboard, retry queues, rate limiting (YAGNI for prototype scale)
- Re-enabling n8n for forms (the workflows are inert; we're removing the dependency)
- Frontend changes — `ContactPage` and `JoinPage` already POST to `/api/contact/` and `/api/join/` with the right payloads

## Current state (what exists today)

| Layer | Status |
|---|---|
| Frontend submit handlers | ✅ Wired correctly to `api.submitContact` / `api.submitJoin` |
| Pydantic schemas (`ContactForm`, `JoinForm`) | ✅ Validate the payloads |
| `forms.py` route handlers | ⚠️ Validate, then fire `httpx.post` to n8n. Failures swallowed via `logger.warning`. Returns 200 OK regardless. |
| n8n workflows (`n8n/workflows/*.json`) | 📦 Designed but not loaded (n8n reads from `database.sqlite`, not the `workflows/` folder). All `emailSend` nodes lack a SMTP credential reference. |
| SMTP credentials anywhere in repo | ❌ None |
| Email library in `pyproject.toml` | ❌ None (`email-validator` is for Pydantic regex only) |
| DNS records on circuits.com (SPF/DKIM/DMARC) | ⚙️ Auto-provisioned by Hover when mailbox was created — needs verification before first send |

## Architecture

```
Frontend (UNCHANGED)
   │ POST /api/contact/   { name, email, subject, message }
   │ POST /api/join/      { company_name, contact_person, email, phone,
   │                       website?, categories_of_interest[], tier?, message? }
   ▼
FastAPI route handler (forms.py)
   │ Pydantic validates
   │ background_tasks.add_task(send_<form>_notification, payload)
   │ if Join: background_tasks.add_task(send_<form>_autoreply, payload)
   │ return 200 OK   ← user sees success immediately
   ▼ (after response is flushed; non-blocking)
app.services.email
   │ aiosmtplib.send via mail.hover.com:587 (STARTTLS)
   │   notification → ["john@circuits.com", "mike@circuits.com"]
   │     From: no-reply@circuits.com
   │     Reply-To: <applicant_email>
   │   auto-reply (Join only) → <applicant_email>
   │     From: no-reply@circuits.com
   │ on failure: logger.error(...) with full payload, no swallow
```

### Why `BackgroundTasks` instead of `await`-in-handler

SMTP STARTTLS handshake + send takes 1–3 seconds. Blocking the response on it makes the form feel laggy. `BackgroundTasks` runs *after* the response is flushed but in the same request lifecycle — no Celery/Redis required.

### Why drop the n8n hop

- Workflows are not auto-imported (`Dockerfile` copies them to `/home/node/.n8n/workflows/` but n8n loads from `database.sqlite`).
- `emailSend` nodes lack a credential reference, so even if loaded they'd fail at the SMTP step.
- Indirection adds two failure modes (n8n down, n8n misconfigured) and 5 seconds of timeout on every submit.
- n8n stays in `docker-compose.yml` for future workflow needs — we just stop *depending* on it.

## File-level changes

### 1. `api/pyproject.toml`

```toml
dependencies = [
  ...,
  "aiosmtplib>=3.0.0",
]
```

### 2. `api/app/config.py`

Add SMTP settings to `Settings`:

```python
class Settings(BaseSettings):
    DATABASE_URL: str
    N8N_WEBHOOK_BASE_URL: str = "http://n8n:5678"
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost"]
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "admin"
    ADMIN_SECRET_KEY: str = "change-me-in-production"

    # SMTP — when SMTP_HOST is unset, services/email.py runs in "demo mode"
    # (logs the email payload to stderr instead of sending). Lets local dev
    # work without exposing the prod mailbox password.
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_USERNAME: str | None = None
    SMTP_PASSWORD: str | None = None
    SMTP_FROM: str = "no-reply@circuits.com"
    # During testing, notifications loop back to no-reply@ itself so Matthew
    # can verify the pipeline without bothering John/Mike. Override via the
    # NOTIFY_RECIPIENTS env var (comma-separated) to flip to real recipients
    # once verified.
    NOTIFY_RECIPIENTS: list[str] = ["no-reply@circuits.com"]
```

### 3. `api/app/services/email.py` (NEW)

Four async functions. Each composes a `MIMEText`, awaits `aiosmtplib.send(...)`, and on exception logs `error` with full payload context.

```python
# Pseudocode skeleton — exact implementation in plan
async def send_contact_notification(form: ContactForm) -> None: ...
async def send_join_notification(form: JoinForm) -> None: ...
async def send_join_autoreply(form: JoinForm) -> None: ...
# (no send_contact_autoreply per design decision)

async def _smtp_send(message: EmailMessage) -> None:
    if not settings.SMTP_HOST:
        logger.info("[email demo-mode] would send: %s", message.as_string())
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
        logger.exception("[email] SMTP send failed; payload=%s", message.as_string())
```

**Notification body shape** (Contact and Join both follow this pattern):

```
From:     no-reply@circuits.com
To:       john@circuits.com, mike@circuits.com
Reply-To: <applicant_email>
Subject:  [Circuits Contact] <subject> — <applicant_name>
          [Circuits Join] <company_name> wants to list (<tier or "—">)

Body (text/plain):
  New <contact|join> submission via circuits.com:

  <field-value pairs, one per line>

  Message:
  ---
  <message body>
  ---

  Reply to this email to respond directly.
```

**Auto-reply body shape (Join only):**

```
From:    no-reply@circuits.com
To:      <applicant_email>
Subject: We received your application — Circuits.com

Body (text/plain):
  Hi <contact_person>,

  Thanks for applying to list <company_name> on Circuits.com.

  John and Mike will review your submission and get back to you within
  1–2 business days. If you have time-sensitive questions, you can reach
  us directly at john@circuits.com or mike@circuits.com.

  — The Circuits.com Team
```

### 4. `api/app/routes/forms.py` (REWRITE)

Replace `fire_webhook` with `BackgroundTasks` calls. Keep route signatures and response shapes identical so frontend is untouched.

```python
from fastapi import APIRouter, BackgroundTasks
from app.schemas import ContactForm, JoinForm, KeywordRequestForm
from app.services import email as email_service

router = APIRouter(prefix="/api", tags=["forms"])

@router.post("/contact")
async def contact(form: ContactForm, background_tasks: BackgroundTasks):
    background_tasks.add_task(email_service.send_contact_notification, form)
    return {"status": "ok"}

@router.post("/join")
async def join(form: JoinForm, background_tasks: BackgroundTasks):
    background_tasks.add_task(email_service.send_join_notification, form)
    background_tasks.add_task(email_service.send_join_autoreply, form)
    return {"status": "ok"}

@router.post("/keyword-request")
async def keyword_request(form: KeywordRequestForm, background_tasks: BackgroundTasks):
    # Out of scope for this spec but stays consistent — notification only.
    background_tasks.add_task(email_service.send_keyword_notification, form)
    return {"status": "ok"}
```

(Keyword-request handler also gets converted, since leaving it on n8n while contact+join migrate would create a confusing split-brain. One more `send_keyword_notification` function in `email.py`. Lightweight — same shape as contact.)

### 5. `docker-compose.yml`

Add 5 SMTP env vars to the `api` service. Use `${VAR:-}` syntax so missing values fall back to demo mode:

```yaml
api:
  environment:
    DATABASE_URL: postgresql://circuits:circuits@db:5432/circuits
    N8N_WEBHOOK_BASE_URL: http://n8n:5678   # kept for future, not used by forms
    ADMIN_USERNAME: john
    ADMIN_PASSWORD: circuits2026
    ADMIN_SECRET_KEY: change-me-in-production
    SMTP_HOST: ${SMTP_HOST:-}
    SMTP_PORT: ${SMTP_PORT:-587}
    SMTP_USERNAME: ${SMTP_USERNAME:-}
    SMTP_PASSWORD: ${SMTP_PASSWORD:-}
    SMTP_FROM: ${SMTP_FROM:-no-reply@circuits.com}
```

### 6. `docker-compose.prod.yml`

Same env-var additions on the `api` service. Real values come from a `.env` file on the EC2 host (next to `docker-compose.prod.yml`) — committed-out via `.gitignore`, populated manually:

```
SMTP_HOST=mail.hover.com
SMTP_PORT=587
SMTP_USERNAME=no-reply@circuits.com
SMTP_PASSWORD=<from Hover admin>
```

### 7. `api/tests/test_forms_email.py` (NEW)

Pytest with `aiosmtplib.send` patched out. Cases:

- `test_contact_notification_sent_with_correct_recipients` — asserts `to=[john, mike]` and `Reply-To: <applicant>`.
- `test_contact_no_autoreply` — asserts no email is sent to applicant.
- `test_join_notification_and_autoreply` — asserts both emails fire with correct content.
- `test_smtp_failure_logs_but_returns_200` — patches `aiosmtplib.send` to raise, asserts route still returns `{"status": "ok"}` and `caplog` contains the error with payload.
- `test_demo_mode_when_smtp_host_unset` — asserts `aiosmtplib.send` is NOT called and an info log is emitted.

### 8. `CLAUDE.md`

Add gotcha:

> - **SMTP creds for forms live in `.env` on the prod EC2 host** — not committed. Provision the password via `mail.hover.com` admin → no-reply@circuits.com mailbox settings. The SMTP host (`mail.hover.com`) and port (587, STARTTLS) are stable. Without `SMTP_HOST` set, `services/email.py` runs in "demo mode" and logs the message instead of sending — local dev works without leaking creds.

## Configuration matrix

| Environment | `SMTP_HOST` | Behavior |
|---|---|---|
| Local dev (no `.env` override) | unset | Demo mode — logs to stderr |
| Local dev with real creds | `mail.hover.com` | Sends real email (use a personal test address as `SMTP_USERNAME`) |
| Prod (EC2) | `mail.hover.com` | Sends real email via `no-reply@circuits.com` |
| Tests | unset (or mocked) | Demo mode + assertion via mock |

## Failure handling

- **Validation failure** (Pydantic): FastAPI returns 422 — same as today.
- **SMTP failure** (network, auth, rate limit): caught in `_smtp_send`, logged via `logger.exception` with the full message body, and the BackgroundTask completes silently. The user already received their 200 OK.
- **No structured retry queue.** If a send fails, it stays failed. This is acceptable for prototype scale (~tens of submissions/day). When the **Messages** admin tab is built (Future Work), persistence + retry will be added.

## Testing strategy

1. **Unit (pytest, in-memory mocks):** the 5 cases listed above, run by the existing `pytest` PostToolUse hook on every `.py` edit.
2. **Local manual:** with `SMTP_HOST` unset, submit both forms via `localhost`, confirm "demo mode" log lines in `docker logs api`.
3. **Local with real SMTP (one-off):** populate a `.env`, hit the forms, verify a real email lands in a personal test address.
4. **Production smoke test (post-deploy):** submit one Contact + one Join from circuits.com. Verify (a) john@ + mike@ receive the notifications, (b) the Join applicant receives the auto-reply, (c) `Reply-To` works in Gmail/Outlook.

## Future work (out of scope for this spec)

These are all enabled by what we build here, but explicitly NOT included:

- **Messages admin tab** (`/admin/messages`): a new page in `frontend/src/admin/pages/messages/` that lists incoming form submissions, ties into the existing notification bell in `AdminLayout` topbar, and lets John/Mike read/archive/respond. Requires:
  - `Message` SQLAlchemy model (id, type, payload jsonb, status, created_at, read_at)
  - Alembic migration
  - `/api/admin/messages` CRUD endpoints (auth-gated)
  - Replace `logger.info(...)` calls in `email.py` with `db.add(Message(...))` + email send
  - List/detail pages following the existing admin Plan-B structure (`messages/list/`, `messages/detail/`)
- **Bounce/complaint webhooks** (if we ever switch to an ESP)
- **Rate limiting per IP** on the form endpoints (currently unbounded — could be spammed)
- **HTML email templates** (currently text/plain — readable but plain)
- **Re-enabling n8n** for downstream workflows (CRM sync, Slack notifications) — the webhook fires would be re-added if/when needed

## Risks & open verification items

1. **Hover SMTP exact hostname/port** — `mail.hover.com:587` is the published Hover Email config. Validate at implementation time by sending a real test message from a local script before wiring it into the API.
2. **DNS records (SPF/DKIM/DMARC) on circuits.com** — Hover provisions these automatically, but worth checking via `dig TXT circuits.com` before first prod send. If missing, deliveries to Gmail will go to spam.
3. **Hover sending quota** — typical mailbox plans cap at 250 messages/day. Demo volume is well under this. Worth knowing for when the team starts demoing to investors.
4. **`no-reply@` Sent folder pollution** — every notification appears in the no-reply mailbox's Sent folder. Cosmetic only.
5. **No persistence on failures** — explicitly accepted per the user's "Option 1 for now" decision; resolved when Messages admin tab lands.

## Decisions captured (from brainstorming)

| Question | Decision |
|---|---|
| `Reply-To` header on notifications | Set to applicant's email (John/Mike can hit Reply) |
| Auto-reply to applicant | **Yes for Join, No for Contact** |
| n8n webhook fire | Remove entirely from `forms.py` |
| Failure visibility | Structured logging only; future Messages admin tab will replace |
| Transport | `aiosmtplib` to `mail.hover.com:587` (no ESP) |
| Architecture | FastAPI direct, `BackgroundTasks`-scheduled |

## Next step

Once user approves this spec → invoke `superpowers:writing-plans` to produce a step-by-step implementation plan, then execute in a feature branch.
