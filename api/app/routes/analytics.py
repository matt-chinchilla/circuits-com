import hashlib
import re
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import User
from app.models.page_view import PageView
from app.services.auth_service import get_current_user
from app.services.geoip import country_for_ip
from app.services.rate_limit import client_ip
from app.services.traffic_segments import crawler_family, split_user_agents

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
            # Fail-open by contract: any geo problem stores NULL, never raises.
            # client_ip(), not request.client.host: the middleware puts the
            # ATTACKER-TYPED leftmost X-Forwarded-For hop in client.host — a
            # forged header must not place a visitor on the map.
            country=country_for_ip(client_ip(request)),
        )
    )
    db.commit()


@router.get("/dashboard/analytics")
def get_analytics(
    days: int = 30,
    segment: str = Query("humans", pattern="^(humans|bots|all)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    days = min(days, 365)
    cutoff = datetime.now(UTC) - timedelta(days=days)
    recent = PageView.created_at >= cutoff
    view_count = func.count(PageView.id)
    unique_sessions = func.count(func.distinct(PageView.session_id))

    # Bot/human segmentation is READ-time: classify the window's DISTINCT
    # user agents in Python (exact regex semantics, retroactive over all
    # history), then filter rows with plain IN/NOT IN so every aggregation
    # below stays in SQL. Defaults to "humans" — crawler floods must not
    # read as visitors (2026-08-20: one Meta crawler = "712 visitors").
    distinct_uas = [row[0] for row in db.query(PageView.user_agent).filter(recent).distinct()]
    bot_uas, _ = split_user_agents(distinct_uas)

    if segment == "humans" and bot_uas:
        # NULL user_agent carries no bot evidence → counts as human. A bare
        # NOT IN would silently drop NULL rows (three-valued logic).
        seg = [or_(PageView.user_agent.is_(None), PageView.user_agent.notin_(bot_uas))]
    elif segment == "bots":
        seg = [PageView.user_agent.in_(bot_uas)] if bot_uas else [PageView.id.is_(None)]
    else:
        seg = []

    total_views = db.query(PageView).filter(recent, *seg).count()
    unique_visitors = db.query(unique_sessions).filter(recent, *seg).scalar() or 0

    # Segment-independent totals for the toggle badges.
    all_views = db.query(PageView).filter(recent).count()
    bot_views = (
        db.query(view_count).filter(recent, PageView.user_agent.in_(bot_uas)).scalar() or 0
        if bot_uas
        else 0
    )
    human_views = all_views - bot_views

    avg_pages = round(total_views / max(unique_visitors, 1), 1)

    day_col = func.date(PageView.created_at)
    daily_traffic = (
        db.query(
            day_col.label("day"),
            view_count.label("views"),
            unique_sessions.label("visitors"),
        )
        .filter(recent, *seg)
        .group_by(day_col)
        .order_by(day_col)
        .all()
    )

    top_pages = (
        db.query(PageView.path, view_count.label("views"), unique_sessions.label("visitors"))
        .filter(recent, *seg)
        .group_by(PageView.path)
        .order_by(view_count.desc())
        .limit(20)
        .all()
    )

    referrers = (
        db.query(PageView.referrer, view_count.label("views"))
        .filter(recent, *seg, PageView.referrer.isnot(None))
        .group_by(PageView.referrer)
        .order_by(view_count.desc())
        .limit(10)
        .all()
    )

    devices = (
        db.query(PageView.device_type, view_count.label("count"))
        .filter(recent, *seg)
        .group_by(PageView.device_type)
        .all()
    )

    browsers = (
        db.query(PageView.browser, view_count.label("count"))
        .filter(recent, *seg)
        .group_by(PageView.browser)
        .order_by(view_count.desc())
        .limit(8)
        .all()
    )

    def _top_by_prefix(prefix: str, limit: int = 10):
        return (
            db.query(PageView.path, view_count.label("views"))
            .filter(recent, *seg, PageView.path.like(f"{prefix}%"))
            .group_by(PageView.path)
            .order_by(view_count.desc())
            .limit(limit)
            .all()
        )

    top_parts = _top_by_prefix("/part/")
    top_categories = _top_by_prefix("/category/")

    daily_by_device = (
        db.query(
            day_col.label("day"),
            PageView.device_type,
            view_count.label("count"),
        )
        .filter(recent, *seg)
        .group_by(day_col, PageView.device_type)
        .order_by(day_col)
        .all()
    )
    device_trend: dict[str, dict[str, int]] = {}
    for row in daily_by_device:
        d = str(row.day)
        if d not in device_trend:
            device_trend[d] = {"day": d, "desktop": 0, "mobile": 0, "tablet": 0}
        dtype = row.device_type or "desktop"
        if dtype in device_trend[d]:
            device_trend[d][dtype] = row.count
    daily_devices = sorted(device_trend.values(), key=lambda x: x["day"])

    # Named crawler families — always computed over the window's BOT rows,
    # independent of the segment toggle (the panel is the bots' home even
    # when the rest of the page shows humans). Sessions are summed per UA
    # group; crawlers mint a session per fetch, so views ≈ sessions here.
    crawlers: list[dict] = []
    if bot_uas:
        fam_views: dict[str, int] = {}
        fam_sessions: dict[str, int] = {}
        fam_seen: dict[str, str] = {}
        rows = (
            db.query(
                PageView.user_agent,
                view_count.label("views"),
                unique_sessions.label("sessions"),
                func.max(PageView.created_at).label("last_seen"),
            )
            .filter(recent, PageView.user_agent.in_(bot_uas))
            .group_by(PageView.user_agent)
            .all()
        )
        for row in rows:
            family = crawler_family(row.user_agent) or "Other bots"
            fam_views[family] = fam_views.get(family, 0) + row.views
            fam_sessions[family] = fam_sessions.get(family, 0) + row.sessions
            last = str(row.last_seen)
            if last > fam_seen.get(family, ""):
                fam_seen[family] = last
        crawlers = sorted(
            (
                {
                    "family": family,
                    "views": views,
                    "sessions": fam_sessions[family],
                    "last_seen": fam_seen.get(family),
                }
                for family, views in fam_views.items()
            ),
            key=lambda e: e["views"],
            reverse=True,
        )

    # Visitors by country — segment-filtered like the rest of the page.
    # NULL country = pre-geo history or a failed lookup; reported separately
    # so the map never pretends coverage it doesn't have.
    country_rows = (
        db.query(
            PageView.country,
            view_count.label("views"),
            unique_sessions.label("visitors"),
        )
        .filter(recent, *seg, PageView.country.isnot(None))
        .group_by(PageView.country)
        .order_by(view_count.desc())
        .all()
    )
    geo_unknown = (
        db.query(view_count).filter(recent, *seg, PageView.country.is_(None)).scalar() or 0
    )
    geo_since = (
        db.query(func.min(PageView.created_at))
        .filter(recent, PageView.country.isnot(None))
        .scalar()
    )

    return {
        "period_days": days,
        "segment": segment,
        "total_views": total_views,
        "unique_visitors": unique_visitors,
        "avg_pages_per_visit": avg_pages,
        "human_views": human_views,
        "bot_views": bot_views,
        "crawlers": crawlers,
        "countries": [
            {"code": row.country, "views": row.views, "visitors": row.visitors}
            for row in country_rows
        ],
        "geo_unknown_views": geo_unknown,
        "geo_tracked_since": str(geo_since) if geo_since is not None else None,
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
        "daily_devices": daily_devices,
    }
