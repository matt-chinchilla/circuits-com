import hashlib
import re
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import User
from app.models.page_view import PageView
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api", tags=["analytics"])

_UA_MOBILE = re.compile(r"Mobi|Android|iPhone|iPad|iPod|webOS|BlackBerry", re.I)
_UA_TABLET = re.compile(r"iPad|Tablet|PlayBook|Silk", re.I)

_UA_BROWSERS = [
    (re.compile(r"Edg/", re.I), "Edge"),
    (re.compile(r"OPR/|Opera", re.I), "Opera"),
    (re.compile(r"Chrome/", re.I), "Chrome"),
    (re.compile(r"Safari/", re.I), "Safari"),
    (re.compile(r"Firefox/", re.I), "Firefox"),
]


def _parse_device(ua: str) -> str:
    if _UA_TABLET.search(ua):
        return "tablet"
    if _UA_MOBILE.search(ua):
        return "mobile"
    return "desktop"


def _parse_browser(ua: str) -> str:
    for pattern, name in _UA_BROWSERS:
        if pattern.search(ua):
            return name
    return "other"


def _hash_ip(ip: str | None) -> str | None:
    if not ip:
        return None
    return hashlib.sha256(ip.encode()).hexdigest()[:16]


class TrackPayload(BaseModel):
    path: str = Field(max_length=500)
    referrer: str | None = Field(default=None, max_length=1000)
    session_id: str = Field(min_length=1, max_length=64)


_RATE_WINDOW = 60
_RATE_MAX = 30
_rate_buckets: dict[str, list[float]] = defaultdict(list)


@router.post("/track", status_code=204)
def track_page_view(
    payload: TrackPayload,
    request: Request,
    db: Session = Depends(get_db),
):
    now = time.monotonic()
    bucket = _rate_buckets[payload.session_id]
    bucket[:] = [t for t in bucket if now - t < _RATE_WINDOW]
    if len(bucket) >= _RATE_MAX:
        return
    bucket.append(now)

    ua = request.headers.get("user-agent", "")
    ip = request.client.host if request.client else None

    db.add(
        PageView(
            path=payload.path,
            referrer=payload.referrer or None,
            user_agent=ua[:500] if ua else None,
            session_id=payload.session_id,
            ip_hash=_hash_ip(ip),
            device_type=_parse_device(ua),
            browser=_parse_browser(ua),
        )
    )
    db.commit()


@router.get("/dashboard/analytics")
def get_analytics(
    days: int = 30,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    days = min(days, 365)
    cutoff = datetime.now(UTC) - timedelta(days=days)
    recent = PageView.created_at >= cutoff
    view_count = func.count(PageView.id)
    unique_sessions = func.count(func.distinct(PageView.session_id))

    total_views = db.query(PageView).filter(recent).count()
    unique_visitors = db.query(unique_sessions).filter(recent).scalar() or 0

    avg_pages = round(total_views / max(unique_visitors, 1), 1)

    day_col = func.date(PageView.created_at)
    daily_traffic = (
        db.query(
            day_col.label("day"),
            view_count.label("views"),
            unique_sessions.label("visitors"),
        )
        .filter(recent)
        .group_by(day_col)
        .order_by(day_col)
        .all()
    )

    top_pages = (
        db.query(PageView.path, view_count.label("views"), unique_sessions.label("visitors"))
        .filter(recent)
        .group_by(PageView.path)
        .order_by(view_count.desc())
        .limit(20)
        .all()
    )

    referrers = (
        db.query(PageView.referrer, view_count.label("views"))
        .filter(recent, PageView.referrer.isnot(None))
        .group_by(PageView.referrer)
        .order_by(view_count.desc())
        .limit(10)
        .all()
    )

    devices = (
        db.query(PageView.device_type, view_count.label("count"))
        .filter(recent)
        .group_by(PageView.device_type)
        .all()
    )

    browsers = (
        db.query(PageView.browser, view_count.label("count"))
        .filter(recent)
        .group_by(PageView.browser)
        .order_by(view_count.desc())
        .limit(8)
        .all()
    )

    def _top_by_prefix(prefix: str, limit: int = 10):
        return (
            db.query(PageView.path, view_count.label("views"))
            .filter(recent, PageView.path.like(f"{prefix}%"))
            .group_by(PageView.path)
            .order_by(view_count.desc())
            .limit(limit)
            .all()
        )

    top_parts = _top_by_prefix("/part/")
    top_categories = _top_by_prefix("/category/")

    return {
        "period_days": days,
        "total_views": total_views,
        "unique_visitors": unique_visitors,
        "avg_pages_per_visit": avg_pages,
        "daily_traffic": [
            {"day": str(row.day), "views": row.views, "visitors": row.visitors}
            for row in daily_traffic
        ],
        "top_pages": [
            {"path": row.path, "views": row.views, "visitors": row.visitors} for row in top_pages
        ],
        "referrers": [{"source": row.referrer, "views": row.views} for row in referrers],
        "devices": [{"type": row.device_type or "unknown", "count": row.count} for row in devices],
        "browsers": [{"name": row.browser or "unknown", "count": row.count} for row in browsers],
        "top_parts": [{"path": row.path, "views": row.views} for row in top_parts],
        "top_categories": [{"path": row.path, "views": row.views} for row in top_categories],
    }
