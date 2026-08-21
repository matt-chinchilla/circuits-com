"""Public BOM tool endpoints — match and live resolve; share added by a later task.

Identity fields only reach /match (D7). Rate limits are per-IP sliding
windows on the SHARED client_ip helper (the checkout.py pattern — never fork
client_ip)."""

import json
import time
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.bom import BomMatchRequest, BomResolveRequest
from app.services import bom_resolve
from app.services.bom_match import build_row, footprint_token, match_line
from app.services.bom_resolve import bom_event, pick_feed_source
from app.services.part_feed.importer import resolve_single
from app.services.part_feed.mouser import FeedFatalError
from app.services.rate_limit import client_ip

router = APIRouter(prefix="/api/bom", tags=["bom"])

_WINDOW_SECONDS = 60
_MAX_KEYS = 4096


class _SlidingWindow:
    def __init__(self, max_per_window: int):
        self.max = max_per_window
        self.buckets: dict[str, list[float]] = defaultdict(list)

    def limited(self, ip: str) -> bool:
        now = time.monotonic()
        if len(self.buckets) > _MAX_KEYS:
            for key in [
                k for k, v in self.buckets.items() if not v or now - v[-1] >= _WINDOW_SECONDS
            ]:
                del self.buckets[key]
        bucket = self.buckets[ip]
        bucket[:] = [t for t in bucket if now - t < _WINDOW_SECONDS]
        if len(bucket) >= self.max:
            return True
        bucket.append(now)
        return False


_match_limiter = _SlidingWindow(20)


@router.post("/match")
def match_bom(body: BomMatchRequest, request: Request, db: Session = Depends(get_db)):
    if _match_limiter.limited(client_ip(request)):
        raise HTTPException(
            status_code=429,
            detail="Too many match requests — try again in a minute.",
        )
    rows = []
    for line in body.lines:
        m = match_line(db, line.mpn, line.value, line.footprint)
        rows.append(
            build_row(
                db,
                line.index,
                m.status,
                m.part,
                m.approx_reason,
                m.resolve_query,
                footprint_token(line.footprint),
            )
        )
    return {"rows": rows}


_resolve_limiter = _SlidingWindow(4)
_UNAVAILABLE = "Live lookups are exhausted for today — request a quote instead."


@router.post("/resolve")
def resolve_bom(body: BomResolveRequest, request: Request, db: Session = Depends(get_db)):
    """Stream one NDJSON event per miss, in order.

    `def`, not `async def` — the provider sleeps between calls; Starlette runs
    a sync generator in the threadpool (the suppliers.py precedent), so a
    resolve run never blocks the event loop."""
    if _resolve_limiter.limited(client_ip(request)):
        raise HTTPException(
            status_code=429,
            detail="Too many resolve requests — try again in a minute.",
        )
    source = pick_feed_source(db)

    def stream():
        fatal = False
        for miss in body.misses:
            if source is None or fatal or not bom_resolve.budget.try_spend():
                yield (
                    json.dumps(bom_event("resolve_unavailable", miss.index, detail=_UNAVAILABLE))
                    + "\n"
                )
                continue
            supplier, provider = source
            try:
                part = resolve_single(db, provider, supplier, miss.query, miss.mpn)
            except FeedFatalError:
                fatal = True
                yield (
                    json.dumps(bom_event("resolve_unavailable", miss.index, detail=_UNAVAILABLE))
                    + "\n"
                )
                continue
            if part is None:
                yield (
                    json.dumps(
                        bom_event(
                            "not_found",
                            miss.index,
                            detail=f"No distributor result for {miss.query}",
                        )
                    )
                    + "\n"
                )
                continue
            row = build_row(db, miss.index, "exact_live", part, None, None, None)
            yield json.dumps(bom_event("resolved", miss.index, row=row)) + "\n"

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )
