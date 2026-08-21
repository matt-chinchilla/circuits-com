"""BOM live-resolve orchestration (spec §6).

One event constructor (bom_event) for this wire — the admin sync_event()
contract is a different surface and stays untouched. The daily budget is a
per-worker in-process counter, same documented posture as the login rate
limiter (single uvicorn worker today).
"""

import threading
from datetime import UTC, datetime

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Supplier
from app.services.part_feed import match_provider, registry


def bom_event(kind: str, index: int, detail: str | None = None, row: dict | None = None) -> dict:
    return {"kind": kind, "index": index, "detail": detail, "row": row}


class DailyBudget:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._day: str | None = None
        self._used = 0

    def try_spend(self, n: int = 1) -> bool:
        with self._lock:
            today = datetime.now(UTC).date().isoformat()
            if self._day != today:
                self._day, self._used = today, 0
            if self._used + n > max(0, int(settings.BOM_RESOLVE_DAILY_BUDGET)):
                return False
            self._used += n
            return True

    def reset(self) -> None:
        with self._lock:
            self._day, self._used = None, 0


budget = DailyBudget()


def _provider_client() -> httpx.Client | None:
    """Test seam — monkeypatched to a MockTransport client in tests."""
    return None


def pick_feed_source(db: Session):
    """First supplier with a registered provider AND a key — generalizes past
    Mouser the day a second provider lands in the registry.

    `registry.get_feed_key` is reached through the MODULE, not bound at import:
    a from-import would freeze the reference and make the key source
    unpatchable from a test (and unreplaceable by any future wrapper)."""
    for supplier in db.query(Supplier).all():
        matched = match_provider(supplier)
        if matched is None:
            continue
        slug, provider_cls = matched
        key = registry.get_feed_key(db, slug)
        if not key:
            continue
        return supplier, provider_cls(api_key=key, client=_provider_client())
    return None
