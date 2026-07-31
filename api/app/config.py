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
    # ships in the public JS bundle. Flip DEMO_LOGIN_ENABLED=false in the prod
    # .env to switch prospect access off WITHOUT a frontend redeploy (the route
    # then 404s, indistinguishable from a route that was never deployed).
    DEMO_LOGIN_ENABLED: bool = True
    DEMO_LOGIN_EMAIL: str = "demo@circuitcenter.ai"

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

    @field_validator("NOTIFY_RECIPIENTS", mode="before")
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
