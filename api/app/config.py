from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode


class Settings(BaseSettings):
    DATABASE_URL: str
    N8N_WEBHOOK_BASE_URL: str = "http://n8n:5678"
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost"]
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "admin"
    ADMIN_SECRET_KEY: str = "change-me-in-production"
    # Trusted canonical origin for absolute links in recovery emails (the
    # password-reset link). MUST be a fixed, trusted value — NEVER derived from
    # the incoming request's Host/X-Forwarded-Host (ProxyHeadersMiddleware trusts
    # all hosts), or an attacker could poison the reset link sent to a victim
    # (host-header injection / password-reset poisoning). Override per-host in
    # the prod .env only with another trusted domain.
    APP_BASE_URL: str = "https://circuitcenter.ai"

    # One-click demo access (POST /api/auth/demo). The endpoint takes NO
    # credentials — it mints a token for DEMO_LOGIN_EMAIL — so no password ever
    # ships in the public JS bundle.
    #
    # Default OFF, deliberately. This is an unauthenticated endpoint that hands
    # out a real session, so it must be OPTED INTO per environment rather than
    # switched off per environment: a deployment that forgets to configure it
    # gets no demo door at all, which is the safe direction. Both compose files
    # pass the value through to the api container
    # (`DEMO_LOGIN_ENABLED: ${DEMO_LOGIN_ENABLED:-...}`) — pydantic-settings
    # reads process env only, so WITHOUT that passthrough this switch is inert
    # no matter what /opt/circuits-com/.env says (the api container has no
    # volume mount and never sees that file). Guarded by
    # tests/test_compose_env_passthrough.py.
    #
    # Flip DEMO_LOGIN_ENABLED=true/false in the host .env and recreate the api
    # container to open/close prospect access WITHOUT a frontend redeploy (the
    # route 404s when off, indistinguishable from one never deployed).
    DEMO_LOGIN_ENABLED: bool = False
    DEMO_LOGIN_EMAIL: str = "demo@circuitcenter.ai"

    # Fictional demo catalog in `python -m app.db.seed` (runs on EVERY api
    # container start — see the entrypoint).
    #
    # True (default, local/dev/demo): seeds the invented demo companies
    # ("Kennedy Electronics", "Mike's Electric", …) plus their showcase
    # sponsorships, so a fresh laptop DB has sold Platinum/Gold boards to look at.
    #
    # False (prod): seeds ONLY the real catalog — real distributors, real parts.
    # This is a data-HYGIENE switch, not a feature flag: with it on, an owner who
    # deletes a fictional supplier in /admin finds it re-created by the next
    # deploy, forever. Turning it off never DELETES anything (seeding is
    # get-or-create); it just stops resurrecting rows a human removed, and the
    # now-unsold category boards render their designed Open-Placement state.
    #
    # Both compose files pass this through (`SEED_DEMO_CATALOG: ${SEED_DEMO_CATALOG:-…}`)
    # — pydantic-settings reads process env only and the api container has no
    # volume mount, so without that passthrough the switch is inert whatever
    # /opt/circuits-com/.env says. Guarded by tests/test_compose_env_passthrough.py.
    SEED_DEMO_CATALOG: bool = True
    # Leads CRM seeds (2026-08-20). True everywhere by owner decision L6: the
    # CSVs are the source of truth and a deploy always restores the roster.
    SEED_MANUFACTURERS: bool = True
    SEED_LEADS: bool = True

    # uvicorn worker count the container actually runs. COUPLED to the
    # `--workers` flag in docker-compose.prod.yml: the same ${API_WORKERS}
    # interpolation feeds both the command and this env var, so the process
    # count and the number this app believes cannot drift.
    #
    # app.services.rate_limit keeps its counters in PROCESS memory, so the
    # login/recovery thresholds are divided by this value (see
    # per_worker_threshold). 1 keeps the limiter exact — read that module's
    # docstring before raising it.
    API_WORKERS: int = 1

    @field_validator("API_WORKERS", mode="after")
    @classmethod
    def _at_least_one_worker(cls, v: int) -> int:
        """0 or a negative worker count would make the rate-limit division
        nonsense (and uvicorn wouldn't start either)."""
        return max(1, v)

    # ── P3 mailbox credential push-sync (app/services/mail_sync.py) ─────────
    # One password opens the site and the mailbox: at every password-set moment
    # the site derives the SHA512-crypt hash and POSTs it to the mail box. The
    # PLAINTEXT never leaves this host and the mail box holds no DB credential.
    #
    # DISABLED unless BOTH the URL and the secret are set — a URL without a
    # secret would push unauthenticated, and an unset URL must never raise (dev
    # boxes and the test suite have no mail box, and none of them may lose the
    # ability to change a password over it). Origin only, no path: mail_sync
    # appends SYNC_PATH itself so the route can't be mistyped into a 404 that
    # looks like an outage. Both values come from /opt/circuits-com/.env and
    # need the compose passthrough (no volume mount — see
    # tests/test_compose_env_passthrough.py).
    MAIL_SYNC_URL: str | None = None
    MAIL_SYNC_SECRET: str | None = None
    # Bounded on purpose: this call sits inline in /auth/change-password,
    # /auth/reset-password and the login retry, so an unreachable mail box adds
    # AT MOST this to a password change (which still succeeds — the row is just
    # marked mail_sync_pending).
    MAIL_SYNC_TIMEOUT: float = 4.0
    # TLS verification for the push. Leave TRUE. It exists only for the window
    # where the mail host is reachable by IP before its certificate is issued;
    # the hash is not a plaintext password, but an unverified channel is still
    # a channel someone else can answer.
    MAIL_SYNC_VERIFY_SSL: bool = True
    # Per-address cooldown (seconds) on the LOGIN retry path only, so a mail
    # box that is down can't add the timeout above to every sign-in.
    MAIL_SYNC_RETRY_COOLDOWN: float = 60.0
    # The addresses that actually HAVE a mailbox (design P2). `demo@` is a
    # login identity only — syncing it would park its row in a pending state
    # that can never clear. Same NoDecode + JSON/CSV handling as
    # NOTIFY_RECIPIENTS so the .env line can be either form.
    MAIL_SYNC_MAILBOXES: Annotated[list[str], NoDecode] = [
        "anthony@circuitcenter.ai",
        "daniel@circuitcenter.ai",
        "matthew@circuitcenter.ai",
        "ronald@circuitcenter.ai",
        "no-reply@circuitcenter.ai",
    ]

    # ── Shared calendar (docs/…/2026-08-04-shared-calendar-design.md) ───────
    # The Roundcube plugin calls /api/calendar/* SERVER-SIDE from PHP, never
    # from the browser: no CORS, and no credential ever reaches a webmail
    # user's tab. It authenticates with this shared secret, mirroring the
    # MAIL_SYNC_SECRET channel between the same two boxes (the value lives in
    # /opt/circuits-com/.env here and /opt/circuits-mail/.env there, never in
    # git).
    #
    # UNSET = the door does not exist. An empty secret must never match an
    # empty header, or leaving this blank would publish the company's meeting
    # schedule to anyone who can reach the API. Human callers are unaffected —
    # they authenticate with their normal admin bearer token.
    CALENDAR_API_SECRET: str | None = None

    # Who gets a meeting reminder. The fixed roster, NOT per-event attendees
    # (attendees are the obvious next step and are not needed to ship). Same
    # NoDecode + JSON/CSV handling as NOTIFY_RECIPIENTS so the .env line can be
    # either form.
    #
    # The four humans, deliberately — MAIL_SYNC_MAILBOXES additionally carries
    # no-reply@, which is a relay identity with nobody reading it.
    CALENDAR_RECIPIENTS: Annotated[list[str], NoDecode] = [
        "anthony@circuitcenter.ai",
        "daniel@circuitcenter.ai",
        "matthew@circuitcenter.ai",
        "ronald@circuitcenter.ai",
    ]

    # Timezone the reminder emails render times in. Falls back to UTC if the
    # container has no tzdata for the key (python:3.12-slim is Debian; the
    # fallback is insurance, not an expectation) — a reminder that says the
    # wrong time is worse than one that says "UTC" out loud.
    CALENDAR_TIMEZONE: str = "America/New_York"

    # How far BACK the reminder job looks (minutes). Windows are a lookback
    # RANGE, not an instant, so a cron tick that runs late — or one that is
    # missed entirely — still delivers. Must comfortably exceed the cron
    # interval. Clamped per lead time inside the job so the hour-before window
    # can never reach past an event's start (see app/jobs/send_reminders.py).
    # 12 hours, not 30 minutes. The window only ever moves forward, so a
    # day-before slot that passes while the box is down is never revisited by
    # any later run — at 30 minutes, an hour of downtime silently dropped that
    # reminder for good, with no ledger row and no log line to show for it.
    # Twelve hours makes the day-before genuinely catch-up-able. It costs
    # nothing when nothing is missed: the ledger's UNIQUE means a wider window
    # re-examines rows it has already sent and sends none of them again.
    # The hour-before is unaffected either way — the job clamps each window to
    # its own lead time, so that one can never look back more than 60 minutes
    # (you cannot send "in one hour" after the meeting has started).
    CALENDAR_REMINDER_LOOKBACK_MINUTES: int = 720

    # ── SMS reminders (app/services/sms.py) ─────────────────────────────────
    # OFF by default and inert when off: with SMS_TOPIC_ARN unset the service
    # sends nothing, raises nothing, and imports no AWS SDK. `notify_sms` on an
    # event then silently does nothing while email keeps working — a calendar
    # must not acquire a hard dependency on AWS credentials.
    #
    # The topic's SUBSCRIPTIONS are the recipient list; there is no phone
    # number in this config. Region is parsed from the ARN unless overridden.
    SMS_TOPIC_ARN: str | None = None
    SMS_REGION: str | None = None

    # ── Stripe (Billing / Invoicing / Tax) ──────────────────────────────────
    # Sponsorship placements bill as monthly subscriptions. Two keys, two very
    # different risk profiles:
    #
    #   STRIPE_PUBLIC_KEY  — publishable. Designed to be public; it is safe in a
    #                        browser bundle. Held here only so the API can hand
    #                        it to a client that needs it, which on the current
    #                        plan (hosted invoice pages) nothing does.
    #   STRIPE_SECRET_KEY  — full account access, including moving money. Server
    #                        side ONLY. It must never reach a template, a JSON
    #                        response, a log line, or the Vite build.
    #
    # Both default to None so a deployment without them simply has no billing
    # rather than failing to boot — the same posture as SMS and mail sync. A
    # `sk_test_` key is a SANDBOX key and cannot move real money; swapping to
    # `sk_live_` is the deliberate act that makes billing real.
    STRIPE_SECRET_KEY: str | None = None
    STRIPE_PUBLIC_KEY: str | None = None

    # Who onboards self-serve Silver buyers. Stamped into Sponsor.sold_by by
    # the checkout webhook so the dashboard's sales-reps chart credits the
    # partners desk for deals it onboards, not only deals it closes by hand.
    SELF_SERVE_ONBOARDING_REP: str = "Daniel"

    # Flat recurring bills the cost sync plants monthly — semicolon-separated
    # `category:vendor:amount` triples (see services/cost_sources/recurring.py).
    # Ships defaulted to the Claude Max subscription because that bill exists
    # TODAY and no API anywhere reports it; the compose files MIRROR this
    # default (the allowlist rule — an empty `${VAR:-}` would DESTROY it).
    # Override or blank it from the host .env when the plan changes.
    RECURRING_MONTHLY_EXPENSES: str = "ai:Claude Max subscription:200.00"

    # STRIPE_WEBHOOK_SECRET — the `whsec_…` signing secret minted when the
    # webhook endpoint is registered (Dashboard → Developers → Webhooks) at
    # deploy time. Verifies that POST /api/stripe/webhook bodies were signed
    # by Stripe; it cannot CALL Stripe, so its blast radius is forged events,
    # not money. Unset, the route 404s — the demo-door posture: an
    # unconfigured endpoint does not exist, and nothing unsigned can ever
    # reach the sponsors table.
    STRIPE_WEBHOOK_SECRET: str | None = None

    # MOUSER_API_KEY — the Mouser SEARCH API key powering the supplier
    # inventory sync (routes/suppliers.py) and the import_parts CLI. Compose
    # maps it from the HOST variable MOUSER_SEARCH_API_KEY (the host .env's own
    # MOUSER_API_KEY line is a dead Order-API key — never pass that through).
    # A FALLBACK since migration 031: a key stored from Admin → Settings
    # (provider_credentials) WINS over this one, so rotating no longer needs a
    # host .env edit and a container recreate. With neither present, POST
    # /suppliers/{id}/sync 404s — the same feature-off posture as Stripe.
    # `registry.get_feed_key()` is the one place that asks.
    MOUSER_API_KEY: str | None = None

    # ── Nightly feed import (app/jobs/feed_import_daily.py) ─────────────────
    # The hour (UTC) the nightly catalog import runs, and the provider-call
    # budget it may spend across every supplier whose "Nightly auto-import"
    # switch is on. Both need the compose passthrough in BOTH files (the job
    # runs in its OWN container — `feed-import` — which inherits nothing from
    # api), and the compose defaults MUST MIRROR these numbers: an empty
    # `${VAR:-}` does not fall back to the code default, it overwrites it.
    #
    # 06:00 UTC is ~01:00/02:00 ET — after Mouser's daily quota reset and well
    # clear of the working day, so a run that takes hours (the provider sleeps
    # ~2.1s between calls to stay under ~30/min) is finished before anyone
    # clicks anything.
    #
    # BUDGET ARITHMETIC, and its honest limit: the free tier allows ~1,000
    # calls/day. One click of "Import new parts" may spend up to 900
    # (routes/suppliers.py clamps there) and this nightly run spends up to 850,
    # so the two CAN jointly exceed the tier — a heavy day of manual imports
    # followed by the nightly run will hit the quota wall. That is deliberate:
    # nothing here tracks daytime spend (the click path and this job are
    # separate processes with no shared counter, and inventing one would be a
    # new distributed-state problem to keep correct), so the failure is left
    # visible instead of guessed at — the wall arrives as a FeedFatalError,
    # which ends the run with a `sync_error` event carrying Mouser's own
    # message. Lower this number, or the click ceiling, if that trade is wrong
    # for a given key. See docs/part-import-runbook.md.
    FEED_IMPORT_HOUR_UTC: int = 6
    FEED_IMPORT_CALL_BUDGET: int = 850

    # BOM live-resolve daily provider-call budget (spec §6). Per-worker,
    # in-process — the documented single-worker posture.
    BOM_RESOLVE_DAILY_BUDGET: int = 100

    # ── Automated cost sync (app/jobs/sync_costs.py) ────────────────────────
    # ANTHROPIC_ADMIN_KEY — an ORGANIZATION admin key (`sk-ant-admin…`), not a
    # regular API key: the Admin API's cost report is the only way to get real
    # Claude spend, and that key can read and manage the whole organization.
    # None by default and the source is a stub today
    # (services/cost_sources/anthropic.py), so an unset key is the normal
    # state, not a misconfiguration — the Anthropic line stays a manual entry
    # typed from the invoice. AWS needs no setting at all: Cost Explorer is
    # reached through boto3's default credential chain (the
    # circuits-cost-explorer-read instance profile in prod), and Stripe reuses
    # STRIPE_SECRET_KEY above.
    ANTHROPIC_ADMIN_KEY: str | None = None

    # SMTP - when SMTP_HOST is unset, services/email.py runs in demo mode
    # (logs the email payload to stderr instead of sending). Lets local dev
    # work without exposing the prod mailbox password.
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_USERNAME: str | None = None
    SMTP_PASSWORD: str | None = None
    SMTP_FROM: str = "no-reply@circuitcenter.ai"
    # Annotated[..., NoDecode] tells pydantic-settings NOT to JSON-parse the
    # env var first. The validator below then handles both JSON-list form
    # AND comma-separated string form. Defaults to the owner's inbox so form
    # submissions reach them; override via NOTIFY_RECIPIENTS env var.
    NOTIFY_RECIPIENTS: Annotated[list[str], NoDecode] = ["mc@matthew-chirichella.com"]

    @field_validator(
        "NOTIFY_RECIPIENTS", "MAIL_SYNC_MAILBOXES", "CALENDAR_RECIPIENTS", mode="before"
    )
    @classmethod
    def _split_csv(cls, v):
        """Accept either a JSON list OR a comma-separated string."""
        if isinstance(v, str):
            stripped = v.strip()
            if stripped.startswith("["):
                import json

                return json.loads(stripped)
            return [s.strip() for s in stripped.split(",") if s.strip()]
        return v


settings = Settings()
