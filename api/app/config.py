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

    @field_validator("NOTIFY_RECIPIENTS", "MAIL_SYNC_MAILBOXES", mode="before")
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
