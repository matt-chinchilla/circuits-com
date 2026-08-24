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
    unpatchable from a test (and unreplaceable by any future wrapper).

    SEE ALSO :func:`app.services.part_feed.registry.live_feed_slugs`, the other
    function asking "which providers can we call". It wants the SET of callable
    slugs and touches no supplier row; this wants the FIRST supplier it can
    actually call and so returns a constructed provider. Both funnel through
    `get_feed_key`, so neither is a second home for the key precedence — the
    pointer exists so a third one does not get written."""
    # ORDERED. An unordered `.all()` let Postgres physical row order decide
    # which distributor prices a BOM miss — stable in practice and free to
    # change after a VACUUM, with nothing in the code admitting it.
    for supplier in db.query(Supplier).order_by(Supplier.name).all():
        matched = match_provider(supplier)
        if matched is None:
            continue
        slug, provider_cls = matched
        key = registry.get_feed_key(db, slug)
        if not key:
            continue
        # from_credential, NOT provider_cls(api_key=…). This was the last
        # `api_key=` construction site in app/, and it could not build a
        # Digi-Key provider at all: Digi-Key needs an id AND a secret, so the
        # call raised TypeError. Because this runs in resolve_bom's HANDLER
        # BODY — outside stream(), outside any try — it escaped as an unhandled
        # 500 on a public unauthenticated endpoint rather than as a stream
        # event, and it became reachable the moment Digi-Key was registered and
        # keyed, since the first matching supplier wins and Mouser is then
        # never reached.
        return supplier, provider_cls.from_credential(key, client=_provider_client())
    return None
