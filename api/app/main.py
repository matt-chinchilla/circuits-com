from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
from app.config import settings
from app.routes import categories, suppliers, search, forms, sponsors
from app.admin import setup_admin

app = FastAPI(title="Circuits.com API", version="0.1.0")

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


setup_admin(app)


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
