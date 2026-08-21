"""Public BOM tool endpoints — match now; resolve/share added by later tasks.

Identity fields only reach /match (D7). Rate limits are per-IP sliding
windows on the SHARED client_ip helper (the checkout.py pattern — never fork
client_ip)."""

import time
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.bom import BomMatchRequest
from app.services.bom_match import build_row, footprint_token, match_line
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
