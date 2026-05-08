from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str
    N8N_WEBHOOK_BASE_URL: str = "http://n8n:5678"
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost"]
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "admin"
    ADMIN_SECRET_KEY: str = "change-me-in-production"

    # SMTP - when SMTP_HOST is unset, services/email.py runs in demo mode
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
