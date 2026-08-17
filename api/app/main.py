from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.admin import setup_admin
from app.config import settings
from app.routes import (
    admin_expenses,
    admin_media,
    admin_messages,
    admin_presence,
    admin_quotes,
    admin_sponsors,
    analytics,
    auth,
    calendar,
    categories,
    checkout,
    dashboard,
    feed_credentials,
    forms,
    parts,
    search,
    sitemap,
    sponsors,
    stripe_webhooks,
    suppliers,
)

app = FastAPI(title="Circuit Center API", version="0.1.0")

app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=["*"])
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(categories.router)
app.include_router(suppliers.router)
app.include_router(search.router)
app.include_router(forms.router)
app.include_router(sponsors.router)
app.include_router(auth.router)
app.include_router(dashboard.router)
# Dashboard also owns a small /api/admin/* lookup router (sales reps).
app.include_router(dashboard.admin_router)
app.include_router(parts.router)
app.include_router(admin_messages.router)
app.include_router(admin_sponsors.router)
app.include_router(admin_expenses.router)
app.include_router(admin_media.router)
app.include_router(admin_presence.router)
app.include_router(analytics.router)
app.include_router(calendar.router)
app.include_router(sitemap.router)
app.include_router(stripe_webhooks.router)
app.include_router(admin_quotes.router)
app.include_router(feed_credentials.router)
app.include_router(checkout.router)


setup_admin(app)


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
