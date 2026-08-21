"""Public BOM tool endpoints — match, live resolve and share links.

Identity fields only reach /match (D7). Rate limits are per-IP sliding
windows on the SHARED client_ip helper (the checkout.py pattern — never fork
client_ip)."""

import base64
import json
import secrets
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import BomShare
from app.schemas.bom import BomMatchRequest, BomResolveRequest, BomShareCreate
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


_share_limiter = _SlidingWindow(5)
_SHARE_TTL_DAYS = 180
_SHARE_MAX_BYTES = 1_000_000


@router.post("/share")
def create_share(body: BomShareCreate, request: Request, db: Session = Depends(get_db)):
    if _share_limiter.limited(client_ip(request)):
        raise HTTPException(
            status_code=429,
            detail="Too many share links — try again in a minute.",
        )
    encoded = json.dumps(body.payload)
    if len(encoded.encode("utf-8")) > _SHARE_MAX_BYTES:
        raise HTTPException(status_code=422, detail="Shared BOM is larger than the 1 MB limit.")
    now = datetime.now(UTC)
    # Opportunistic prune — no cron (spec §4).
    db.query(BomShare).filter(BomShare.expires_at < now).delete()
    slug = base64.urlsafe_b64encode(secrets.token_bytes(16)).decode().rstrip("=")
    share = BomShare(
        slug=slug, payload=body.payload, expires_at=now + timedelta(days=_SHARE_TTL_DAYS)
    )
    db.add(share)
    db.commit()
    return {"slug": slug, "expires_at": share.expires_at.isoformat()}


@router.get("/share/{slug}")
def read_share(slug: str, db: Session = Depends(get_db)):
    share = db.query(BomShare).filter(BomShare.slug == slug).first()
    if share is None or share.expires_at.replace(tzinfo=UTC) < datetime.now(UTC):
        raise HTTPException(status_code=404, detail="Share link not found or expired.")
    return {
        "payload": share.payload,
        "created_at": share.created_at.isoformat() if share.created_at else None,
        "expires_at": share.expires_at.isoformat(),
    }
