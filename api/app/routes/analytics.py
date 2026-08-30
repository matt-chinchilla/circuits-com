import hashlib
import json
import re
import time
import uuid as uuid_mod
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import OutboundClick, PartListing, User
from app.models.page_view import PageView
from app.services.auth_service import require_staff
from app.services.geoip import geo_for_ip
from app.services.rate_limit import client_ip, trusted_client_addr
from app.services.traffic_segments import crawler_family, human_ua_filter, window_bot_uas

router = APIRouter(prefix="/api", tags=["analytics"])

# ── The customer/staff wall on a MIXED router (D16) ─────────────────────────
# This module serves BOTH the public site and staff tooling, so the wall cannot
# sit on the APIRouter the way it does on every /api/admin/* router — a router
# dependency here would gate the public reads too. Each staff route names
# `require_staff` in its signature instead; that dependency runs
# get_current_user first, so the forced-password gate is unchanged. A staff
# route added here must name it too — test_every_route_is_gated.py is what
# notices if it does not.


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
# Bounds the memory a flood can make us allocate. Each bucket is a short list
# of floats; keying on the edge-observed address (below) already caps distinct
# keys at "real hosts", and this is the backstop for a botnet.
_RATE_MAX_KEYS = 8192
_rate_buckets: dict[str, list[float]] = defaultdict(list)


def _throttled(key: str, now: float) -> bool:
    """True when `key` has already spent its window allowance.

    Keyed on the EDGE-observed address, never on anything in the body: the
    key used to be `payload.session_id`, which the caller types, so any
    flooder got a virgin 30-view allowance per invented id — an unlimited
    write channel into `page_views` AND an unbounded key table. `client_ip`
    (not `trusted_client_addr`) is deliberate for a THROTTLE key: it collapses
    IPv6 to the /64, and a host that owns 2**64 addresses would otherwise
    rotate its way out of the bucket exactly the way forged session ids did.

    Trade-off, recorded rather than accidental: a large NAT now shares one
    30/min allowance, so a very busy office can have views dropped. That has
    always been this endpoint's failure mode (it returns 204 and stores
    nothing), and analytics under-count beats an open write channel.
    """
    bucket = _rate_buckets[key]
    bucket[:] = [t for t in bucket if now - t < _RATE_WINDOW]
    if len(bucket) >= _RATE_MAX:
        return True
    if len(_rate_buckets) > _RATE_MAX_KEYS:
        # Sweep only when the table is actually big: drop every key whose
        # window has fully drained (including this one if it is still empty,
        # hence the re-read of `bucket` afterwards).
        for stale in [k for k, v in _rate_buckets.items() if not v or now - v[-1] >= _RATE_WINDOW]:
            del _rate_buckets[stale]
        bucket = _rate_buckets[key]
    bucket.append(now)
    return False


@router.post("/track", status_code=204)
def track_page_view(
    payload: TrackPayload,
    request: Request,
    db: Session = Depends(get_db),
):
    if _throttled(client_ip(request), time.monotonic()):
        return

    ua = request.headers.get("user-agent", "")
    # The one address we trust, un-bucketed. NOT request.client.host: with
    # ProxyHeadersMiddleware on trusted_hosts="*" that holds the ATTACKER-TYPED
    # leftmost X-Forwarded-For hop, so both the visitor hash and the map were
    # whatever a caller typed. NOT client_ip() either — that returns a /64
    # NETWORK for IPv6, which the GeoIP reader rejects outright, so every IPv6
    # visitor was landing as "unknown" and every IPv6 subscriber shared one hash.
    addr = trusted_client_addr(request)
    # ONE lookup for all five columns. Fail-open by contract: any geo problem
    # yields the empty result and stores NULLs, never raises. How much comes
    # back depends on which database the container has — country-only from the
    # committed file, city detail from the one the image downloads.
    geo = geo_for_ip(addr)

    db.add(
        PageView(
            path=payload.path,
            referrer=payload.referrer or None,
            user_agent=ua[:500] if ua else None,
            session_id=payload.session_id,
            ip_hash=_hash_ip(addr),
            device_type=_parse_device(ua),
            browser=_parse_browser(ua),
            country=geo.country,
            region=geo.region,
            city=geo.city,
            latitude=geo.latitude,
            longitude=geo.longitude,
        )
    )
    db.commit()


# ── POST /api/outbound — the referral-click beacon ──────────────────────────
# Public, like /api/track, and for the same reason: the click it records
# happens on a public part page for an anonymous visitor. Same posture too —
# one bucket namespace of its own (a part page fires BOTH a page view and,
# on a click-through, a beacon; sharing one 30/min allowance would make the
# tracker and the beacon starve each other), and 204 on every path.
_OUTBOUND_KEY_PREFIX = "outbound:"

# Two uuids and nothing else. The cap only bounds what an unauthenticated
# caller can make us parse; a real beacon body is ~100 bytes.
_OUTBOUND_MAX_BODY_BYTES = 1024


def _uuid_or_none(raw: object) -> uuid_mod.UUID | None:
    if not isinstance(raw, str):
        return None
    try:
        return uuid_mod.UUID(raw)
    except ValueError:
        return None


@router.post("/outbound", status_code=204)
async def record_outbound_click(request: Request, db: Session = Depends(get_db)):
    """A visitor left a part page for a distributor's own site.

    **204 on every path, always** — a valid pair, a malformed body, a
    well-formed pair naming nothing, a throttled caller. A beacon that answered
    differently for a real (part, supplier) pair than for an invented one would
    be an unauthenticated oracle over the catalog's shape, and it is fired by
    ``navigator.sendBeacon``, which discards the response anyway: there is
    nobody to tell, so telling is pure downside.

    The body is read RAW rather than through a Pydantic model precisely because
    of that. FastAPI rejects a malformed JSON body with a 422 before any
    handler runs, so a declared model would make "always 204" impossible to
    keep — the guarantee has to be implemented where the bytes arrive.

    JUNK MUST NOT BE STORABLE. Both ids have to parse as uuids AND
    ``part_listings`` has to confirm that this supplier really does list this
    part; anything else is dropped. Without that EXISTS a stranger could write
    arbitrary supplier uuids into a customer's own console numbers, which is
    the panel this table feeds.
    """
    if _throttled(_OUTBOUND_KEY_PREFIX + client_ip(request), time.monotonic()):
        return

    payload = await request.body()
    if not payload or len(payload) > _OUTBOUND_MAX_BODY_BYTES:
        return
    try:
        body = json.loads(payload)
    except ValueError:
        return
    if not isinstance(body, dict):
        return

    part_id = _uuid_or_none(body.get("part_id"))
    supplier_id = _uuid_or_none(body.get("supplier_id"))
    if part_id is None or supplier_id is None:
        return

    listed = (
        db.query(PartListing.id)
        .filter(PartListing.part_id == part_id, PartListing.supplier_id == supplier_id)
        .first()
    )
    if listed is None:
        return

    db.add(OutboundClick(id=uuid_mod.uuid4(), part_id=part_id, supplier_id=supplier_id))
    db.commit()


_geo_since_cache: datetime | None = None


def _geo_tracked_since(db: Session) -> datetime | None:
    """The FIRST page view that ever carried a country — unwindowed, unsegmented.

    The map panel prints this as "country data since X". That is a claim about
    when geo tracking started (migration 040), so computing it under the
    request's `recent` window made it slide forward to the window start: pick
    "last 7 days" and the panel announced that country data began a week ago.

    Cached in-process and never re-queried once known, because it can only move
    BACKWARD — a new row is always later than the first one, and only an
    explicit backfill of older rows could change it (a restart re-reads).
    A NULL is deliberately NOT cached: on a database with no country rows yet
    the answer is "not yet", and the first real row has to be able to land.
    """
    global _geo_since_cache
    if _geo_since_cache is None:
        _geo_since_cache = (
            db.query(func.min(PageView.created_at)).filter(PageView.country.isnot(None)).scalar()
        )
    return _geo_since_cache


_region_since_cache: datetime | None = None


def _region_tracked_since(db: Session) -> datetime | None:
    """The FIRST page view that ever carried a region — the city-data stamp.

    Its own stamp rather than a reuse of `geo_tracked_since`, because the two
    answer different questions and are months apart: country capture started
    at migration 040, city detail at 048. Sharing one would have the panel
    claim city coverage back to the country start date, over a stretch of
    history where every row's region is NULL and always will be.

    Same sticky-cache reasoning as above — it can only move BACKWARD, and a
    NULL is deliberately NOT cached so the first real row can land.
    """
    global _region_since_cache
    if _region_since_cache is None:
        _region_since_cache = (
            db.query(func.min(PageView.created_at)).filter(PageView.region.isnot(None)).scalar()
        )
    return _region_since_cache


def reset_analytics_state() -> None:
    """Test seam for every piece of process memory this module keeps — the
    "country data since" and "city data since" stamps, and the /api/track
    throttle buckets.

    An autouse conftest fixture calls it, and all of it matters: the stamps are
    deliberately sticky, and the throttle is keyed per ADDRESS, so every test
    that posts to /api/track or /api/outbound shares that endpoint's bucket
    (TestClient is always the same host) and the 31st post in a suite would
    silently vanish."""
    global _geo_since_cache, _region_since_cache
    _geo_since_cache = None
    _region_since_cache = None
    _rate_buckets.clear()


@router.get("/dashboard/analytics")
def get_analytics(
    days: int = 30,
    segment: str = Query("humans", pattern="^(humans|bots|all)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
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
    bot_uas = window_bot_uas(db, cutoff)

    if segment == "humans" and bot_uas:
        seg = [human_ua_filter(PageView.user_agent, bot_uas)]
    elif segment == "bots":
        seg = [PageView.user_agent.in_(bot_uas)] if bot_uas else [PageView.id.is_(None)]
    else:
        seg = []

    unique_visitors = db.query(unique_sessions).filter(recent, *seg).scalar() or 0

    # Segment-independent totals for the toggle badges; the window's bot UAs
    # partition its rows exactly, so the active segment's headline count is
    # derived rather than re-counted.
    all_views = db.query(view_count).filter(recent).scalar() or 0
    bot_views = (
        db.query(view_count).filter(recent, PageView.user_agent.in_(bot_uas)).scalar() or 0
        if bot_uas
        else 0
    )
    human_views = all_views - bot_views
    total_views = {"humans": human_views, "bots": bot_views, "all": all_views}[segment]

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
    geo_since = _geo_tracked_since(db)

    # US detail — the same window and segment as the country roll-up above.
    # Scoped to the US because that is the map these back (a state choropleth
    # and a city bubble layer); `region` elsewhere is a province or a
    # prefecture and does not belong on either.
    state_rows = (
        db.query(
            PageView.region,
            view_count.label("views"),
            unique_sessions.label("visitors"),
        )
        .filter(recent, *seg, PageView.country == "US", PageView.region.isnot(None))
        .group_by(PageView.region)
        .order_by(view_count.desc())
        .all()
    )

    # A bubble needs a name AND a point, so all three are required — a city
    # whose centroid the database does not carry is counted in the state layer
    # and simply has no bubble. The coordinates are in the GROUP BY because
    # they identify the place: two cities can share a name across states.
    city_rows = (
        db.query(
            PageView.city,
            PageView.region,
            PageView.latitude,
            PageView.longitude,
            view_count.label("views"),
        )
        .filter(
            recent,
            *seg,
            PageView.country == "US",
            PageView.city.isnot(None),
            PageView.latitude.isnot(None),
            PageView.longitude.isnot(None),
        )
        .group_by(PageView.city, PageView.region, PageView.latitude, PageView.longitude)
        .order_by(view_count.desc())
        .limit(60)
        .all()
    )
    region_since = _region_tracked_since(db)

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
        "us_states": [
            {"name": row.region, "views": row.views, "visitors": row.visitors} for row in state_rows
        ],
        "us_cities": [
            {
                "city": row.city,
                "region": row.region,
                "lat": row.latitude,
                "lng": row.longitude,
                "views": row.views,
            }
            for row in city_rows
        ],
        "region_tracked_since": str(region_since) if region_since is not None else None,
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
