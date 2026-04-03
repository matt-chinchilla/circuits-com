from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str
    N8N_WEBHOOK_BASE_URL: str = "http://n8n:5678"
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost"]
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "admin"
    ADMIN_SECRET_KEY: str = "change-me-in-production"


settings = Settings()
