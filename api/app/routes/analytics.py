import hashlib
import json
import re
import time
import uuid as uuid_mod
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import OutboundClick, PartListing, User
from app.models.page_view import PageView
from app.services.auth_service import require_staff
from app.services.geoip import EMPTY_GEO, geo_for_ip
from app.services.org_classify import classify_network
from app.services.org_match import OrgMatcher
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
    # ONE lookup for all the geo columns. Fail-open by contract: any geo
    # problem yields the empty result and stores NULLs. geoip promises never
    # to raise, but the promise is ALSO enforced here at the one call site
    # that matters — a public tracking endpoint must never lose a page view
    # to a lookup bug.
    try:
        geo = geo_for_ip(addr)
    except Exception:
        geo = EMPTY_GEO

    db.add(
        PageView(
            path=payload.path,
            referrer=payload.referrer or None,
            user_agent=ua[:500] if ua else None,
            session_id=payload.session_id,
            ip_hash=_hash_ip(addr),
            # The literal address too (migration 050, owner decision) — the
            # town card's ADDRESSES section reads it, behind require_staff.
            ip=addr or None,
            device_type=_parse_device(ua),
            browser=_parse_browser(ua),
            country=geo.country,
            region=geo.region,
            city=geo.city,
            latitude=geo.latitude,
            longitude=geo.longitude,
            network=geo.network,
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
    "country data since", "city data since" and "network data since" stamps,
    and the /api/track throttle buckets.

    An autouse conftest fixture calls it, and all of it matters: the stamps are
    deliberately sticky, and the throttle is keyed per ADDRESS, so every test
    that posts to /api/track or /api/outbound shares that endpoint's bucket
    (TestClient is always the same host) and the 31st post in a suite would
    silently vanish."""
    global _geo_since_cache, _region_since_cache, _network_since_cache
    _geo_since_cache = None
    _region_since_cache = None
    _network_since_cache = None
    _rate_buckets.clear()


def _window_segment(db: Session, cutoff: datetime, segment: str) -> tuple[list[str], list]:
    """The window's bot user agents, and the row filter `segment` implies.

    Bot/human segmentation is READ-time: classify the window's DISTINCT user
    agents in Python (exact regex semantics, retroactive over all history),
    then filter rows with plain IN/NOT IN so every aggregation stays in SQL.
    Defaults to "humans" — crawler floods must not read as visitors
    (2026-08-20: one Meta crawler = "712 visitors").

    ONE home for it because two dashboard routes now need the identical
    window: /dashboard/analytics and /dashboard/organizations paint the same
    traffic, and a segment rule that drifted between them would have the
    organization panel disagree with the map above it about who visited.
    """
    bot_uas = window_bot_uas(db, cutoff)
    if segment == "humans" and bot_uas:
        return bot_uas, [human_ua_filter(PageView.user_agent, bot_uas)]
    if segment == "bots":
        # No bot UAs in the window means the bot segment is EMPTY, which is
        # not the same as unfiltered — hence the impossible predicate.
        return bot_uas, [PageView.user_agent.in_(bot_uas) if bot_uas else PageView.id.is_(None)]
    return bot_uas, []


# How many networks a single city dot names. Three fits the panel and is
# where the tail stops being interesting; the rest is summarised by the dot's
# own view count.
_CITY_NETWORK_LIMIT = 3
# Distinct literal addresses shown on a town's intel card. Three, like the
# networks above it: the card answers "who is this", not "list my logfile".
_CITY_ADDRESS_LIMIT = 3

# How many city bubbles ONE country may return. The rank rail beside the map
# lists them all, so this is a readability limit, not a runaway guard.
_CITY_LIMIT = 60

# The global town list's runaway guard. Town grouping keeps the real number
# far below this (prod sits at 288 towns worldwide), so the cap only exists so
# a future finer-grained geo source cannot post a megabyte to a dashboard.
_TOWN_LIMIT = 1000


# ── The two per-country detail layers, as ONE piece of machinery ────────────
# The map's drill-down is a state choropleth (`_region_rows`) over a city
# bubble layer (`_city_rows`). Both were written inline inside
# /dashboard/analytics for the United States and are now called with a country
# code instead: `us_states`/`us_cities` are literally the `country == "US"`
# case of these functions, and /dashboard/geo/{code} is every other case.
#
# They stay two functions rather than one because the caller needs them
# separately — /dashboard/analytics ships the US pair inline while the
# per-country route ships whichever country was asked for — but the caps,
# the tiebreakers and the metro-grouping rule below are shared BY
# CONSTRUCTION, so the two views can never drift into disagreeing about what
# a "region" or a "town" is.


def _region_rows(db: Session, recent, seg: list, country: str) -> list[dict]:
    """Views by first-level subdivision inside ONE country, busiest first.

    `region` is a state in the US, a province in Canada, a prefecture in
    Japan — whatever DB-IP resolved at track time. Scoping to one country is
    what makes the name meaningful: "Western" is a province of Sri Lanka and
    an Australian state, and a global roll-up would add them together.
    """
    view_count = func.count(PageView.id)
    unique_sessions = func.count(func.distinct(PageView.session_id))
    rows = (
        db.query(
            PageView.region,
            view_count.label("views"),
            unique_sessions.label("visitors"),
        )
        .filter(recent, *seg, PageView.country == country, PageView.region.isnot(None))
        .group_by(PageView.region)
        # Name tiebreaker: equal-count regions must not swap between requests.
        .order_by(view_count.desc(), PageView.region.asc())
        .all()
    )
    return [{"name": r.region, "views": r.views, "visitors": r.visitors} for r in rows]


def _city_rows(
    db: Session, recent, seg: list, country: str | None, limit: int = _CITY_LIMIT
) -> list[dict]:
    """The city bubble layer, busiest first, capped.

    `country` scopes it to one country's drill-down; **None means every town
    on earth**, which is what the density map's identified layer reads.

    A bubble needs a name AND a point, so all three are required — a city
    whose centroid the database does not carry is counted in the region layer
    and simply has no bubble. The identity of a bubble is (country, city,
    region): region is what keeps Springfield MA and Springfield IL apart, and
    COUNTRY is what keeps a global list from merging two same-named
    subdivisions in different countries into one town. Grouping on country
    unconditionally costs a scoped call nothing — the column is constant
    inside the filter — so both scopes run one query shape.

    The coordinates are AVERAGED rather than grouped on: DB-IP resolves many
    addresses to sub-city districts whose labels are stripped at write time
    but whose centroids differ, and grouping on the point would fragment one
    metro into several bubbles that each claim a slice of its traffic.
    The city tiebreaker keeps the cut stable between requests.
    """
    view_count = func.count(PageView.id)
    unique_sessions = func.count(func.distinct(PageView.session_id))
    city_filters = (
        recent,
        *seg,
        *([PageView.country == country] if country is not None else []),
        PageView.city.isnot(None),
        PageView.latitude.isnot(None),
        PageView.longitude.isnot(None),
    )
    city_rows = (
        db.query(
            PageView.country,
            PageView.city,
            PageView.region,
            func.avg(PageView.latitude).label("lat"),
            func.avg(PageView.longitude).label("lng"),
            view_count.label("views"),
            unique_sessions.label("visitors"),
            func.max(PageView.created_at).label("last_seen"),
        )
        .filter(*city_filters)
        .group_by(PageView.country, PageView.city, PageView.region)
        .order_by(view_count.desc(), PageView.city.asc())
        .limit(limit)
        .all()
    )

    # Per-city breakdowns: TWO grouped queries, not sixty. Each is the city
    # query's own key plus one breakdown column, and Python does the bucketing
    # — a query per dot would turn one dashboard load into 121 round trips.
    #
    # Both carry the SAME filters as the city query above (window, segment,
    # country, city and point present) so their key space matches it exactly;
    # anything that is not one of the surviving keys is dropped in the loop
    # below rather than being asked for separately.
    city_key_columns = (PageView.country, PageView.city, PageView.region)

    def _breakdown(column):
        """(city key, `column`) → views, ordered so the first rows seen for a
        key are that key's busiest. A global ORDER BY is enough for that: if
        the whole result descends by views, then so does any subset of it.
        The column tiebreaker makes a top-3 cut among equals deterministic."""
        return (
            db.query(*city_key_columns, column, view_count.label("views"))
            .filter(*city_filters, column.isnot(None))
            .group_by(*city_key_columns, column)
            .order_by(view_count.desc(), column.asc())
            .all()
        )

    surviving_keys = {(r.country, r.city, r.region) for r in city_rows}

    def _bucket(rows, value_of, label, limit=None):
        buckets: dict[tuple, list[dict]] = defaultdict(list)
        for row in rows:
            key = (row.country, row.city, row.region)
            if key not in surviving_keys:
                continue
            entries = buckets[key]
            if limit is None or len(entries) < limit:
                entries.append({label: value_of(row), "views": row.views})
        return buckets

    networks_by_city = _bucket(
        _breakdown(PageView.network), lambda r: r.network, "name", _CITY_NETWORK_LIMIT
    )
    devices_by_city = _bucket(_breakdown(PageView.device_type), lambda r: r.device_type, "type")
    addresses_by_city = _bucket(_breakdown(PageView.ip), lambda r: r.ip, "ip", _CITY_ADDRESS_LIMIT)

    cities = []
    for row in city_rows:
        key = (row.country, row.city, row.region)
        cities.append(
            {
                "city": row.city,
                "region": row.region,
                # The country the town is in — constant for a drill-down, and
                # the thing that makes a GLOBAL town list addressable.
                "country": row.country,
                # Re-rounded because an average of 2dp inputs need not be 2dp.
                "lat": round(row.lat, 2),
                "lng": round(row.lng, 2),
                "views": row.views,
                "visitors": row.visitors,
                "last_seen": str(row.last_seen) if row.last_seen is not None else None,
                # A city whose every view predates the ASN database gets an
                # empty list, never a fabricated "Unknown" network.
                "networks": networks_by_city.get(key, []),
                "devices": devices_by_city.get(key, []),
                # Busiest literal addresses (migration 050) — forward-only,
                # so a town whose views all predate capture gets [].
                "addresses": addresses_by_city.get(key, []),
            }
        )
    return cities


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

    bot_uas, seg = _window_segment(db, cutoff, segment)

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
    # It ships INLINE here (rather than only from /dashboard/geo/US) because
    # the United States is the map's landing drill-down and its own
    # pre-projected AlbersUSA asset: the panel opens it without a second
    # round trip. Every other country goes through the route below, off the
    # SAME two helpers, so the two paths cannot disagree about a region.
    us_states = _region_rows(db, recent, seg, "US")
    us_cities = _city_rows(db, recent, seg, "US")

    # Which countries the map may offer a drill-down into. Without this the
    # panel would have to CLICK to find out, and a country whose every view
    # is country-lite would open onto an empty choropleth — a dead door the
    # reader cannot tell from a slow one. One grouped query answers it for
    # the whole map, in the same window and segment as everything else.
    region_countries = [
        row.country
        for row in (
            db.query(PageView.country)
            .filter(recent, *seg, PageView.country.isnot(None), PageView.region.isnot(None))
            .group_by(PageView.country)
            .order_by(PageView.country.asc())
            .all()
        )
    ]

    # How many TOWNS the density map would have to draw. A count, not the
    # rows: the density view is behind a pill most sessions never press, and
    # its Leaflet chunk is already fetched on demand — so its data is too, from
    # /dashboard/towns. This number exists only so the panel knows whether to
    # offer the entrance at all, the same job `region_countries` does for the
    # drill-down. It replaced a `heat_points` array of bare [lat, lng, views]
    # triples on 2026-08-30, when the density layer gained identity (see that
    # route) — and the payload got SMALLER, not larger.
    located_towns = (
        db.query(func.count())
        .select_from(
            db.query(PageView.country, PageView.city, PageView.region)
            .filter(
                recent,
                *seg,
                PageView.city.isnot(None),
                PageView.latitude.isnot(None),
                PageView.longitude.isnot(None),
            )
            .group_by(PageView.country, PageView.city, PageView.region)
            .subquery()
        )
        .scalar()
        or 0
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
        "us_states": us_states,
        "us_cities": us_cities,
        "region_countries": region_countries,
        "region_tracked_since": str(region_since) if region_since is not None else None,
        "located_towns": located_towns,
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


# ── GET /api/dashboard/geo/{country_code} — the drill-down, anywhere ────────
# The map panel used to drill into the United States alone, because
# /dashboard/analytics only ever aggregated `region`/`city` for `country ==
# "US"`. The COLUMNS were never US-only — DB-IP stamps a region, a city and a
# centroid on every located view — so this route is the same two aggregations
# with the country as a parameter, and the US case above is one of its
# callers rather than a separate implementation.
#
# It is its own route rather than more fields on /dashboard/analytics for the
# same reason /dashboard/organizations is: a drill-down most sessions never
# open must not be paid for by every load of the Site Analytics tab. One
# country's detail is fetched when someone actually clicks that country.


@router.get("/dashboard/geo/{country_code}")
def get_country_geo(
    country_code: str = Path(..., pattern="^[A-Za-z]{2}$"),
    days: int = 30,
    segment: str = Query("humans", pattern="^(humans|bots|all)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    """One country's regions and towns, same window and segment as the map.

    `country_code` is ISO alpha-2 and case-insensitive; anything else is a
    422 from the pattern above rather than a query for a country that cannot
    exist. A WELL-FORMED code with no rows is not an error — it is a country
    nobody has visited yet, and it answers with empty lists so the panel can
    render its collecting state instead of an error box.
    """
    days = min(days, 365)
    cutoff = datetime.now(UTC) - timedelta(days=days)
    recent = PageView.created_at >= cutoff
    # Stored uppercase by `geo_for_ip`, so the comparison is uppercase too —
    # a lowercase path segment must not silently return an empty country.
    code = country_code.upper()

    _bot_uas, seg = _window_segment(db, cutoff, segment)

    return {
        "country": code,
        "period_days": days,
        "segment": segment,
        "regions": _region_rows(db, recent, seg, code),
        "cities": _city_rows(db, recent, seg, code),
        # The panel's collecting copy is about when REGION capture started,
        # which is a property of the database and not of this country.
        "region_tracked_since": (
            str(since) if (since := _region_tracked_since(db)) is not None else None
        ),
    }


# ── GET /api/dashboard/towns — the density map, with identity ───────────────
# The density map used to be beautiful and inert. It painted `heat_points`,
# bare [lat, lng, views] triples grouped on the ROUNDED COORDINATE, and a
# click could not say which town it had hit — so every piece of reporting
# depth (the visitor-intel card, the towns list) lived only in the choropleth
# views. Two maps, two disjoint capability sets, and the prettier one told you
# less. Owner call, 2026-08-30: fix it.
#
# The fix is upstream of the click. This route returns the SAME town rows the
# drill-down's bubble layer is built from — `_city_rows` with no country — so
# the density layer paints from identified rows rather than anonymous points,
# and a click already knows the town, its numbers, its networks and its
# devices without a second request.
#
# THE GROUPING CHANGE IS FREE, MEASURED: rounding to a coordinate produced 311
# points; grouping into towns produces 288 — and there are ZERO located page
# views with no city, so nothing is dropped, only merged. The merges are
# exactly the sub-city districts the bubble layer already merges on purpose
# ("a metro stays ONE bubble"), which makes the two maps agree about what a
# place is instead of disagreeing by construction.
#
# Its own route rather than more fields on /dashboard/analytics, for the same
# reason /dashboard/organizations is: the density view is behind a pill, and
# its Leaflet chunk is already fetched on demand. Every session paid ~7 kB for
# heat_points; now only the sessions that open the view pay anything.


@router.get("/dashboard/towns")
def get_towns(
    days: int = 30,
    segment: str = Query("humans", pattern="^(humans|bots|all)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    """Every located town on earth, busiest first, with its visitor intel."""
    days = min(days, 365)
    cutoff = datetime.now(UTC) - timedelta(days=days)
    recent = PageView.created_at >= cutoff

    _bot_uas, seg = _window_segment(db, cutoff, segment)

    return {
        "period_days": days,
        "segment": segment,
        "towns": _city_rows(db, recent, seg, None, limit=_TOWN_LIMIT),
        "region_tracked_since": (
            str(since) if (since := _region_tracked_since(db)) is not None else None
        ),
    }


# ── GET /api/dashboard/organizations — who, not just where ──────────────────
# The map panel above this one answers "where are the visitors"; this one
# answers the owner's actual question, "which COMPANIES are visiting". Same
# rows, same window, same segment — a different axis (`page_views.network`,
# the AS organization DB-IP resolved at track time).

_network_since_cache: datetime | None = None


def _network_tracked_since(db: Session) -> datetime | None:
    """The FIRST page view that ever carried a network name.

    Its own stamp for the same reason `_region_tracked_since` is not
    `_geo_tracked_since`: ASN capture started at migration 049, months after
    country (040) and later than city (048). The panel prints it so an empty
    list reads as "capture started on X and nothing has resolved since"
    rather than "nobody visited".

    Same sticky-cache contract as its two siblings — it can only move
    BACKWARD, and a NULL is deliberately NOT cached so the first real row can
    land on a database that has none yet.
    """
    global _network_since_cache
    if _network_since_cache is None:
        _network_since_cache = (
            db.query(func.min(PageView.created_at)).filter(PageView.network.isnot(None)).scalar()
        )
    return _network_since_cache


# The organization list's runaway guard. Production has resolved 177 distinct
# networks in its whole history, so the cap is nowhere near binding; it exists
# so a future traffic shape cannot post a megabyte of AS names to a dashboard.
# The three summary counts describe the rows actually RETURNED, which is what
# the panel's filter chips count.
_ORG_LIMIT = 200

# Per-organization detail depth. Three locations and three referrers fit the
# expanded row; five pages is where "what did they research" stops being a
# sentence and starts being a log.
_ORG_LOCATION_LIMIT = 3
# 200 is "all of them" for any real company while keeping a hosting crawler
# that touched half the catalog from shipping ten thousand rows per org —
# `pages_total` beside it is what keeps the cut honest (owner, 2026-09-01:
# the expansion should show every page, scrollable).
_ORG_PAGE_LIMIT = 200
_ORG_REFERRER_LIMIT = 3


@router.get("/dashboard/organizations")
def get_organizations(
    days: int = 30,
    segment: str = Query("humans", pattern="^(humans|bots|all)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    """Visiting organizations, busiest first by DISTINCT visitors.

    SIX grouped queries plus the segment's user-agent probe and a one-time
    capture stamp — never one query per organization. Four of the six are the
    same shape as the map's per-city breakdowns: the organization key plus one
    breakdown column, bucketed in Python. A query per row would turn one
    dashboard load into 800 round trips.

    Classification is READ-time (`services/org_classify`) and deliberately
    unstored: no column, no migration, and a keyword list that can be
    corrected for ALL of history — including rows already written — in one
    deploy.
    """
    days = min(days, 365)
    cutoff = datetime.now(UTC) - timedelta(days=days)
    recent = PageView.created_at >= cutoff
    view_count = func.count(PageView.id)
    unique_sessions = func.count(func.distinct(PageView.session_id))

    _bot_uas, seg = _window_segment(db, cutoff, segment)

    # Every query below carries these filters, so their key spaces match the
    # organization query's exactly and a breakdown can never smuggle in a row
    # the roll-up did not count.
    named = (recent, *seg, PageView.network.isnot(None))

    org_rows = (
        db.query(
            PageView.network,
            view_count.label("views"),
            unique_sessions.label("visitors"),
            func.min(PageView.created_at).label("first_seen"),
            func.max(PageView.created_at).label("last_seen"),
        )
        .filter(*named)
        .group_by(PageView.network)
        # Visitors first — the owner's question is how many PEOPLE from a
        # company, not how many pages one of them opened. Name tiebreaker so
        # equal-count organizations cannot swap between requests.
        .order_by(unique_sessions.desc(), view_count.desc(), PageView.network.asc())
        .limit(_ORG_LIMIT)
        .all()
    )

    def _blank_last(column):
        """A NULL-safe ascending tiebreaker. `city` and `region` are nullable
        in the location key, and SQLite and Postgres disagree about where
        NULLs sort — coalescing to the empty string makes the cut identical on
        both engines."""
        return func.coalesce(column, "").asc()

    location_rows = (
        db.query(
            PageView.network,
            PageView.city,
            PageView.region,
            PageView.country,
            view_count.label("views"),
        )
        # A country with no city is still an answer ("somewhere in Germany"),
        # so only a row with neither is dropped.
        .filter(*named, or_(PageView.city.isnot(None), PageView.country.isnot(None)))
        .group_by(PageView.network, PageView.city, PageView.region, PageView.country)
        .order_by(
            view_count.desc(),
            _blank_last(PageView.city),
            _blank_last(PageView.region),
            _blank_last(PageView.country),
        )
        .all()
    )

    def _breakdown(column):
        """(network, `column`) → views, globally ordered so the first rows
        seen for a network are that network's busiest — if the whole result
        descends by views then so does any subset of it. The column
        tiebreaker makes a top-N cut among equals deterministic."""
        return (
            db.query(PageView.network, column, view_count.label("views"))
            .filter(*named, column.isnot(None))
            .group_by(PageView.network, column)
            .order_by(view_count.desc(), column.asc())
            .all()
        )

    page_rows = _breakdown(PageView.path)
    referrer_rows = _breakdown(PageView.referrer)
    device_rows = _breakdown(PageView.device_type)

    surviving = {row.network for row in org_rows}

    def _bucket(rows, build, limit=None):
        buckets: dict[str, list[dict]] = defaultdict(list)
        for row in rows:
            if row.network not in surviving:
                continue
            entries = buckets[row.network]
            if limit is None or len(entries) < limit:
                entries.append(build(row))
        return buckets

    locations = _bucket(
        location_rows,
        lambda r: {"city": r.city, "region": r.region, "country": r.country, "views": r.views},
        _ORG_LOCATION_LIMIT,
    )
    pages = _bucket(page_rows, lambda r: {"path": r.path, "views": r.views}, _ORG_PAGE_LIMIT)
    # Distinct pages per network BEFORE the cap, so the panel can say
    # "+N more" instead of silently pretending the cut is the whole story.
    pages_total: dict[str, int] = defaultdict(int)
    for row in page_rows:
        if row.network in surviving:
            pages_total[row.network] += 1
    referrers = _bucket(
        referrer_rows,
        lambda r: {"referrer": r.referrer, "views": r.views},
        _ORG_REFERRER_LIMIT,
    )
    devices = _bucket(device_rows, lambda r: {"type": r.device_type, "views": r.views})

    counts = {"corporate": 0, "isp": 0, "hosting": 0, "matched": 0}
    # ONE bulk read of the leads + manufacturer canon maps, outside the loop.
    matcher = OrgMatcher.build(db)
    organizations = []
    for row in org_rows:
        kind = classify_network(row.network)
        if kind == "unknown":
            # A network column holding only whitespace is not an organization.
            # Dropping it here keeps the three counts a partition of the list,
            # which is what the panel's filter chips assume.
            continue
        counts[kind] += 1
        match = matcher.match(row.network)
        if match is not None:
            counts["matched"] += 1
        organizations.append(
            {
                "name": row.network,
                "kind": kind,
                # Already on the call list, or already a manufacturer we
                # track: the row the owner most wants to see. None when the
                # visitor is nobody we know yet.
                "match": (
                    {"kind": match.kind, "name": match.name, "id": match.id}
                    if match is not None
                    else None
                ),
                "views": row.views,
                "visitors": row.visitors,
                "first_seen": str(row.first_seen) if row.first_seen is not None else None,
                "last_seen": str(row.last_seen) if row.last_seen is not None else None,
                # Empty lists rather than fabricated placeholders: an
                # organization whose views all predate city capture genuinely
                # has no locations to show.
                "locations": locations.get(row.network, []),
                "top_pages": pages.get(row.network, []),
                "pages_total": pages_total.get(row.network, 0),
                "referrers": referrers.get(row.network, []),
                "devices": devices.get(row.network, []),
            }
        )

    network_since = _network_tracked_since(db)
    return {
        "period_days": days,
        "segment": segment,
        "corporate_count": counts["corporate"],
        "isp_count": counts["isp"],
        "hosting_count": counts["hosting"],
        "matched_count": counts["matched"],
        "network_tracked_since": str(network_since) if network_since is not None else None,
        "organizations": organizations,
    }
