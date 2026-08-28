"""The customer console's own numbers — the tiles and the placement list.

Everything here is the SAME question the admin console answers company-wide,
asked with a WHERE clause bolted on. That is exactly the shape that goes wrong
quietly, so two rules hold throughout:

**The filter comes from app.services.account_scope, never from the user row.**
A route that reads ``user.supplier_id`` and builds its own condition is a route
that will forget the second link (Avnet distributes AND manufactures), or the
free account (neither link — the natural hand-written version appends no
condition and hands back the company-wide totals), or that ``== None`` is
``IS NULL`` and hands over the shared staff inbox. The scope helpers return one
boolean expression that is ``false()`` when nothing is permitted, so the unsafe
version is the one you have to work for.

**Money is a number by the time it leaves here.** ``sponsors.amount`` is a
Postgres NUMERIC, which arrives as ``Decimal`` and serializes as a STRING — at
which point the console sorts "9999.00" before "2500.00" and nobody notices
until a customer does.
"""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import distinct, func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import (
    ActivityEvent,
    Category,
    Expense,
    Lead,
    Manufacturer,
    Message,
    OutboundClick,
    Part,
    PartListing,
    Revenue,
    Sponsor,
    Supplier,
    SupplierFeed,
    User,
)

# The staff board's own time helpers and event vocabulary, imported rather than
# re-typed. Every date on this site buckets in America/New_York and every feed
# row reads with one sentence — a second copy of either here is a second answer
# to a question the console and the admin board must agree on.
from app.routes.dashboard import (
    _ACTIVITY_EVENT_KINDS,
    _MAX_AVAILABLE_MONTHS,
    _MONTH_PARAM_PATTERN,
    _day_start_utc,
    _est_day,
    _event_description,
    _month_end,
    _month_start,
    _parse_month,
    _today_est,
)
from app.services.account_kpis import (
    Kpi,
    available_kpis,
    build_points,
    resolve_kpi,
    selectable_kpi,
)
from app.services.account_scope import (
    AccountScope,
    account_scope,
    activity_visible_to,
    clicks_visible_to,
    expenses_owned_by,
    feeds_visible_to,
    leads_owned_by,
    messages_visible_to,
    parts_visible_to,
    revenue_visible_to,
    sponsorships_visible_to,
)
from app.services.account_tier import account_tier, normalize_tier
from app.services.auth_service import require_account_user
from app.services.category_service import active_sponsor_filter

router = APIRouter(prefix="/api/account", tags=["account"])


class KpiSelection(BaseModel):
    """The KPI picker's request body. A bare string, validated against the
    CALLER'S available set in the route — the registry alone is not enough,
    because capability is part of whether a key is valid for this account."""

    key: str


# The status a placement with no status column value is really in. Legacy seed
# rows omit it, `status != 'Expired'` is UNKNOWN for NULL and silently drops
# them, and a customer must never be shown a blank where their live placement
# should be. The predicate itself lives in category_service.active_sponsor_filter
# — one home, shared with the admin write-path block and migration 016's index.
DEFAULT_STATUS = "Active"

UNREAD_STATUS = "new"


def _money(value: Decimal | float | None) -> float:
    """Decimal -> float, at the scale the column stores.

    ``round`` rather than a bare ``float`` because a NUMERIC(10,2) summed by
    Postgres is exact and the float cast is not: 0.1 + 0.2 must not reach a
    billing figure on screen.
    """
    if value is None:
        return 0.0
    return round(float(value), 2)


@router.get("/dashboard")
def dashboard(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
    user: User = Depends(require_account_user),
):
    """The console's five tiles, every one of them scoped to the caller.

    ``user`` is the same object ``account_scope`` resolved (FastAPI caches a
    dependency per request), asked for here only because tier is derived from
    the row rather than from the scope.

    An unlinked account gets zeroes and a 200. Not an error — a free browsing
    account is a legitimate, common state, and it has simply not bought
    anything yet.
    """
    total_parts = (
        db.query(func.count(func.distinct(Part.id))).filter(parts_visible_to(scope)).scalar() or 0
    )

    # One pass for the two sponsorship tiles: same rows, same predicate, so
    # they cannot drift into disagreeing about what "active" means.
    active_count, spend = (
        db.query(
            func.count(Sponsor.id),
            func.coalesce(func.sum(Sponsor.amount), 0),
        )
        .filter(
            sponsorships_visible_to(scope),
            active_sponsor_filter(),
        )
        .one()
    )

    unread = (
        db.query(func.count(Message.id))
        .filter(messages_visible_to(scope), Message.status == UNREAD_STATUS)
        .scalar()
        or 0
    )

    return {
        "total_parts": int(total_parts),
        "active_sponsorships": int(active_count or 0),
        "monthly_spend": _money(spend),
        "unread_messages": int(unread),
        "tier": account_tier(db, user),
    }


@router.get("/sponsors")
def my_sponsorships(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """Every placement this caller's company holds — live and lapsed.

    Deliberately NOT filtered to active: a customer looking at their own
    sponsorships needs to see the one that expired, which is the whole reason
    they came to this page. ``status`` and ``is_active`` say which is which.

    A manufacturer-only or unlinked account gets ``[]``. ``sponsors.supplier_id``
    is NOT NULL, so a maker cannot hold a placement today — that is an empty
    list, not an error, and certainly not everybody's placements.
    """
    rows = (
        db.query(Sponsor, Category.name)
        .outerjoin(Category, Category.id == Sponsor.category_id)
        .filter(sponsorships_visible_to(scope))
        .order_by(Sponsor.created_at.desc().nullslast(), Sponsor.id)
        .all()
    )

    out = []
    for sponsor, category_name in rows:
        if sponsor.category_id is not None:
            placement_type, placement = "category", category_name
        elif sponsor.keyword:
            placement_type, placement = "keyword", sponsor.keyword
        else:
            # The XOR is a Postgres CHECK that SQLite skips; never guess.
            placement_type, placement = None, None
        status = (sponsor.status or "").strip() or DEFAULT_STATUS
        out.append(
            {
                "id": str(sponsor.id),
                # Free string, no enum: the admin writes TitleCase and the
                # legacy seed wrote lowercase. Normalize at every read site or
                # the console's tier badge silently misses half the rows.
                "tier": normalize_tier(sponsor.tier),
                "placement": placement,
                "placement_type": placement_type,
                "status": status,
                "is_active": status == DEFAULT_STATUS,
                "amount": _money(sponsor.amount) if sponsor.amount is not None else None,
                "start_date": sponsor.start_date,
                "end_date": sponsor.end_date,
                "description": sponsor.description,
            }
        )
    return out


# ---------------------------------------------------------------------------
# The console's chart panels
# ---------------------------------------------------------------------------
#
# A SECOND router on the SAME prefix, and the split is bookkeeping rather than
# design: `router` above carries the console's two original surfaces and a
# wiring test pins its route count, so the panels get their own registration.
# Both mount at /api/account and both take the same scope dependency — the
# gate is the dependency, not which router an endpoint happens to live on.
charts_router = APIRouter(prefix="/api/account", tags=["account-charts"])

# Window sizes, fixed rather than query parameters. These panels are a fixed
# layout, and an unbounded `?months=` is a JSON series a caller sizes for us.
REFERRAL_DAYS = 30
REFERRAL_MONTHS = 12
REVENUE_MONTHS = 12

# Recent-activity depth, per the pinned contract.
ACTIVITY_LIMIT = 20

# How many prospects the leads panel previews.
LEADS_PREVIEW = 5

# Who a sponsorship subscription is paid TO. It is us — this line is the
# customer's cost of being on this site, and naming the vendor honestly is what
# separates it from their own expense rows.
SUBSCRIPTION_VENDOR = "Circuit Center"

# The bucket a sponsorship line lands in when its tier is blank or unknown.
SUBSCRIPTION_CATEGORY = "sponsorship"

# The name a placement gets when its row satisfies neither half of the XOR.
# Postgres has a CHECK for that; SQLite skips it, and a Sankey node cannot be
# named None.
UNPLACED = "Unplaced"


def _month_key(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def _month_window(count: int) -> list[date]:
    """``count`` consecutive month-starts ending with the current EST month.

    Oldest first, which is the contract's order and the order a time series is
    read in. Proper month arithmetic via ``_month_start`` — subtracting 30 days
    at a time skips a month whenever February is in the span.
    """
    today = _today_est()
    return [_month_start(today, ago) for ago in range(count - 1, -1, -1)]


@charts_router.get("/kpi")
def get_kpi(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
    user: User = Depends(require_account_user),
):
    """The KPI tile: what is selected, what may be selected, and the series.

    The stored preference is RESOLVED rather than trusted —
    ``users.dashboard_kpi`` has no FK and an account can lose the link that
    made its choice answerable, so a stale key renders the default instead of
    an error page. See ``app/services/account_kpis.py``.
    """
    return _kpi_payload(db, scope, resolve_kpi(scope, user.dashboard_kpi))


@charts_router.put("/kpi")
def set_kpi(
    body: KpiSelection,
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
    user: User = Depends(require_account_user),
):
    """Persist the caller's KPI choice and hand back the recomputed tile.

    Validated against the CALLER'S available set, not the registry: a maker
    naming ``stock_by_category`` is refused exactly like a misspelling, because
    storing a key the account cannot answer would leave the picker claiming one
    thing while the chart rendered the default.
    """
    chosen = selectable_kpi(scope, body.key)
    if chosen is None:
        raise HTTPException(status_code=422, detail="unknown_kpi")
    user.dashboard_kpi = chosen.key
    db.commit()
    return _kpi_payload(db, scope, chosen)


def _kpi_payload(db: Session, scope: AccountScope, kpi: Kpi) -> dict:
    return {
        "selected": kpi.key,
        "available": [{"key": k.key, "label": k.label} for k in available_kpis(scope)],
        "points": build_points(db, scope, kpi),
    }


@charts_router.get("/referral-clicks")
def referral_clicks(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """Visitors who left one of our part pages for this distributor's own site.

    REFERRAL CLICKS, and the field names say so. We cannot see the basket on
    the other side, so this is a count of people we sent — never a dollar
    figure, and nothing here may be relabelled as revenue.

    Every slot in both series is filled, zeros included: a chart that skips
    empty days draws a straight line between two peaks and invents the days
    between them. Days are bucketed in America/New_York, like every other date
    on this site, so a 9pm-ET click belongs to that business day.

    A maker-only or free account gets the full zero-filled shape and a 200 —
    clicks are recorded against the distributor the visitor went to, and
    handing a manufacturer their distributors' demand numbers would be a
    different company's data.
    """
    today = _today_est()
    days = [today - timedelta(days=ago) for ago in range(REFERRAL_DAYS - 1, -1, -1)]
    months = _month_window(REFERRAL_MONTHS)

    per_day: dict[date, int] = defaultdict(int)
    per_month: dict[str, int] = defaultdict(int)
    rows = (
        db.query(OutboundClick.clicked_at)
        .filter(
            clicks_visible_to(scope),
            OutboundClick.clicked_at >= _day_start_utc(min(days[0], months[0])),
        )
        .all()
    )
    for (clicked_at,) in rows:
        day = _est_day(clicked_at)
        # A future-dated row is not a click that has happened; it would also
        # land outside every slot and silently inflate total_30d if summed
        # from the dict rather than from the series.
        if day is None or day > today:
            continue
        per_day[day] += 1
        per_month[_month_key(day)] += 1

    daily = [{"date": day.isoformat(), "clicks": per_day.get(day, 0)} for day in days]
    return {
        "monthly": [
            {"month": _month_key(first), "clicks": per_month.get(_month_key(first), 0)}
            for first in months
        ],
        "daily": daily,
        "total_30d": sum(point["clicks"] for point in daily),
    }


@charts_router.get("/revenue")
def revenue(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """What we have booked from this customer, month by month.

    The staff board's revenue chart with the caller's supplier bolted on.
    Bucketed by ``period_start`` — the month the money is recognized for, not
    the month the row was typed — and zero-filled across the whole window so
    the series has one point per month whether or not they paid us that month.

    ``total`` is the window's total, i.e. the sum of the months shown. A figure
    that disagreed with the chart beside it would be the more confusing of the
    two possible meanings.
    """
    months = _month_window(REVENUE_MONTHS)
    rows = (
        db.query(Revenue.period_start, Revenue.amount)
        .filter(
            revenue_visible_to(scope),
            Revenue.period_start >= months[0],
            Revenue.period_start <= _month_end(months[-1]),
        )
        .all()
    )
    totals: dict[str, Decimal] = defaultdict(Decimal)
    for period_start, amount in rows:
        totals[_month_key(period_start)] += Decimal(str(amount or 0))

    return {
        "months": [
            {
                "month": _month_key(first),
                "amount": _money(totals.get(_month_key(first), Decimal(0))),
            }
            for first in months
        ],
        "total": _money(sum(totals.values(), Decimal(0))),
    }


def _placement_name(sponsor: Sponsor, category_name: str | None) -> str:
    if sponsor.category_id is not None:
        return category_name or UNPLACED
    return (sponsor.keyword or "").strip() or UNPLACED


@charts_router.get("/sponsor-mix")
def sponsor_mix(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """Where this customer's sponsorship money goes: company -> tier -> placement.

    ECharts Sankey shape, name-keyed — which is the one thing worth being
    careful about here, because a node reached from two LEVELS of the flow
    closes a cycle and ECharts then refuses to draw the chart at all. Two
    placements cannot collide with each other inside one graph: this is always
    a single supplier, and ``UNIQUE(supplier_id, category_id)`` /
    ``UNIQUE(supplier_id, keyword)`` already make its placements distinct. What
    CAN collide is a placement against the company name or a tier — a category
    or a customer-typed keyword is free text — so the tiers are collected in a
    first pass and a placement matching one of those structural names is
    renamed. Two passes rather than one because a placement seen before the
    tier it clashes with would otherwise merge into that tier's node instead,
    which depends on row order and is the harder bug to see.

    ACTIVE placements only — this panel replaces the Active Sponsors tile, and
    a lapsed placement is not where money currently flows. NULL status counts
    as Active (``active_sponsor_filter``): legacy rows omit the column and
    ``status != 'Expired'`` is UNKNOWN for NULL, which drops them silently.

    A zero amount keeps its link. It renders as a hairline, which is the honest
    picture of a placement we have not billed for, and dropping it would make
    the placement vanish from the customer's own map of their account.
    """
    company = (
        db.query(Supplier.name).filter(Supplier.id == scope.supplier_id).scalar()
        if scope.is_supplier
        else None
    )
    rows = (
        db.query(Sponsor, Category.name)
        .outerjoin(Category, Category.id == Sponsor.category_id)
        .filter(sponsorships_visible_to(scope), active_sponsor_filter())
        .order_by(Sponsor.created_at.asc().nullsfirst(), Sponsor.id)
        .all()
    )
    if company is None or not rows:
        return {"nodes": [], "links": []}

    # Pass one: the structural names. Collected up front so the rename below
    # does not depend on the order the rows arrive in — a placement seen
    # before the tier it clashes with would otherwise be silently merged into
    # that tier's node instead of renamed.
    tiers = [(normalize_tier(row.tier) or SUBSCRIPTION_CATEGORY).title() for row, _ in rows]
    structural = {company, *tiers}

    names: list[str] = [company]
    for tier in tiers:
        if tier not in names:
            names.append(tier)

    tier_totals: dict[str, float] = defaultdict(float)
    placement_totals: dict[tuple[str, str], float] = defaultdict(float)

    for (sponsor, category_name), tier in zip(rows, tiers, strict=True):
        placement = _placement_name(sponsor, category_name)
        if placement in structural:
            placement = f"{placement} (placement)"
        if placement not in names:
            names.append(placement)
        amount = _money(sponsor.amount)
        tier_totals[tier] += amount
        placement_totals[(tier, placement)] += amount

    links = [
        {"source": company, "target": tier, "value": round(value, 2)}
        for tier, value in tier_totals.items()
    ]
    links += [
        {"source": tier, "target": placement, "value": round(value, 2)}
        for (tier, placement), value in placement_totals.items()
    ]
    return {"nodes": [{"name": name} for name in names], "links": links}


@charts_router.get("/book-of-business")
def book_of_business(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """The counterparties this account actually trades with, derived from the catalog.

    Two directions of one join, and an account holding both links gets BOTH:
    the makers whose products it distributes AND the distributors stocking the
    parts it makes. The same joins ``/api/account/manufacturers`` and
    ``/api/account/suppliers`` walk, mirrored here rather than imported — a
    route function carries a response shape and its own dependencies.

    A both-links company is dropped from its own list of counterparties: Avnet
    stocking a part Avnet makes is not a trading relationship, and rendering it
    would put the centre node on the rim as well.

    ``value`` is how many of the CALLER'S parts the relationship covers, which
    is the only weight either side of the join can honestly claim.
    """
    center = None
    if scope.is_supplier:
        center = db.query(Supplier.name).filter(Supplier.id == scope.supplier_id).scalar()
    if center is None and scope.is_manufacturer:
        center = (
            db.query(Manufacturer.name).filter(Manufacturer.id == scope.manufacturer_id).scalar()
        )

    nodes: list[dict] = []
    if scope.is_supplier:
        rows = (
            db.query(Manufacturer.id, Manufacturer.name, func.count(distinct(Part.id)))
            .join(Part, Part.manufacturer_id == Manufacturer.id)
            .join(PartListing, PartListing.part_id == Part.id)
            .filter(PartListing.supplier_id == scope.supplier_id)
            .group_by(Manufacturer.id, Manufacturer.name)
            .all()
        )
        nodes += [
            {"id": str(mid), "name": name, "kind": "manufacturer", "parts_count": int(count)}
            for mid, name, count in rows
            if mid != scope.manufacturer_id
        ]
    if scope.is_manufacturer:
        rows = (
            db.query(Supplier.id, Supplier.name, func.count(distinct(Part.id)))
            .join(PartListing, PartListing.supplier_id == Supplier.id)
            .join(Part, Part.id == PartListing.part_id)
            .filter(Part.manufacturer_id == scope.manufacturer_id)
            .group_by(Supplier.id, Supplier.name)
            .all()
        )
        nodes += [
            {"id": str(sid), "name": name, "kind": "supplier", "parts_count": int(count)}
            for sid, name, count in rows
            if sid != scope.supplier_id
        ]

    nodes.sort(key=lambda node: (-node["parts_count"], node["name"] or ""))
    return {
        "center": {"name": center},
        "nodes": nodes,
        "links": [
            {"source": "center", "target": node["id"], "value": node["parts_count"]}
            for node in nodes
        ],
    }


@charts_router.get("/activity")
def activity(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """This company's feed events, newest first.

    ``label`` comes from the staff feed's own ``_event_description`` rather
    than a second set of sentences: a customer reading "Imported X into Y"
    should be reading the line the operator read, and two templates for one
    row is how they end up describing different things.

    The kind filter is READ-side and matches the staff board's, for the reason
    written there: the table keeps ``sync_started``/``sync_error`` as the
    operator's audit trail, but a started run that never finished would sit in
    a customer's feed forever claiming progress.
    """
    rows = (
        db.query(ActivityEvent)
        .filter(activity_visible_to(scope), ActivityEvent.kind.in_(_ACTIVITY_EVENT_KINDS))
        .order_by(ActivityEvent.created_at.desc(), ActivityEvent.id)
        .limit(ACTIVITY_LIMIT)
        .all()
    )
    return {
        "events": [
            {
                "id": str(event.id),
                "kind": event.kind,
                "label": _event_description(event),
                "created_at": event.created_at.isoformat() if event.created_at else None,
            }
            for event in rows
        ]
    }


@charts_router.get("/import-queue")
def import_queue(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """Whether the nightly feed import runs for this company, and when it last did.

    EXACTLY two fields, and that is a security boundary rather than a shape
    preference: ``supplier_feeds`` also holds ``api_key`` and ``feed_url``,
    which never leave the server on any surface, and ``import_cursor``, which
    is the sweep's private bookkeeping. Serializing the row would ship all
    three. ``last_synced_at`` means "calls were spent on this supplier that
    night", not "the run succeeded".

    ``null`` for an account with no feed row — including every maker-only and
    free account, which is honest: nothing is queued for them.
    """
    feed = db.query(SupplierFeed).filter(feeds_visible_to(scope)).first()
    if feed is None:
        return {"feed": None}
    return {
        "feed": {
            "auto_import_enabled": bool(feed.auto_import_enabled),
            "last_synced_at": feed.last_synced_at.isoformat() if feed.last_synced_at else None,
        }
    }


@charts_router.get("/operating-costs")
def operating_costs(
    month: str | None = Query(default=None, pattern=_MONTH_PARAM_PATTERN),
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """What being here costs this customer: their sponsorships plus their own costs.

    Two kinds of line, tagged as such. A SUBSCRIPTION line is one active
    sponsorship — the tier is the category, so the chart's legend reads
    Platinum/Gold/Silver, and the vendor is us, because that is who the money
    goes to. An EXPENSE line is a row the customer entered in their own book
    (``expenses.user_id`` = them; the company's own operating costs are the
    NULL rows and are not reachable from here).

    Subscriptions appear for every month asked THAT THE PLACEMENT OVERLAPS,
    including months holding no expense rows at all: a monthly recurring charge
    that vanished from an empty month would read as a month it was not billed —
    but a month BEFORE ``start_date`` was never billed either, and listing it
    there would invoice history that did not happen. A NULL ``start_date``
    (legacy/seed rows) keeps the placement on every month rather than hiding a
    real recurring charge. Expenses are bucketed by ``period_start``, the same
    convention the staff breakdown uses.

    ``available_months`` is what the pager may step onto — the months that
    actually hold one of the caller's expense rows, plus the current month when
    they hold a live sponsorship. It is independent of the month being served,
    so any response can render the pager.
    """
    month_start = _parse_month(month)
    lines: list[dict] = []

    subscriptions = (
        db.query(Sponsor)
        .filter(sponsorships_visible_to(scope), active_sponsor_filter())
        .order_by(Sponsor.created_at.asc().nullsfirst(), Sponsor.id)
        .all()
    )
    month_end = _month_end(month_start)
    for sponsor in subscriptions:
        if sponsor.start_date is not None and sponsor.start_date > month_end:
            continue
        if sponsor.end_date is not None and sponsor.end_date < month_start:
            continue
        lines.append(
            {
                "category": normalize_tier(sponsor.tier) or SUBSCRIPTION_CATEGORY,
                "vendor": SUBSCRIPTION_VENDOR,
                "amount": _money(sponsor.amount),
                "kind": "subscription",
            }
        )

    expenses = (
        db.query(Expense)
        .filter(
            expenses_owned_by(scope),
            Expense.period_start >= month_start,
            Expense.period_start <= _month_end(month_start),
        )
        .all()
    )
    for expense in expenses:
        lines.append(
            {
                "category": (expense.category or "other").strip().lower(),
                # null, never omitted: an absent key reads as `undefined` in TS
                # and slips straight past a `?:`-typed field.
                "vendor": (expense.vendor or "").strip() or None,
                "amount": _money(expense.amount),
                "kind": "expense",
            }
        )

    lines.sort(key=lambda line: (-line["amount"], line["category"], line["vendor"] or ""))

    months = {
        _month_key(period_start)
        for (period_start,) in db.query(Expense.period_start)
        .filter(expenses_owned_by(scope))
        .distinct()
        .all()
        if period_start is not None
    }
    if subscriptions:
        months.add(_month_key(_today_est()))

    return {
        "month": _month_key(month_start),
        "available_months": sorted(months, reverse=True)[:_MAX_AVAILABLE_MONTHS],
        "lines": lines,
        "total": _money(sum(Decimal(str(line["amount"])) for line in lines)),
    }


@charts_router.get("/leads-summary")
def leads_summary(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """The customer's OWN prospect list — the businesses they want to sell to.

    ``leads.user_id`` = them. The NULL rows are Circuit Center's own outreach
    roster (real names, real phone numbers, real call outcomes), and the
    equality test in ``leads_owned_by`` is the only thing between the two.
    Empty at first for everybody, which is the correct starting state rather
    than an error.
    """
    total = db.query(func.count(Lead.id)).filter(leads_owned_by(scope)).scalar() or 0
    recent = (
        db.query(Lead)
        .filter(leads_owned_by(scope))
        .order_by(Lead.created_at.desc(), Lead.id)
        .limit(LEADS_PREVIEW)
        .all()
    )
    return {
        "total": int(total),
        "recent": [
            {
                # A placeholder row carries no contact yet; the company is the
                # only name it has, and inventing one would be worse.
                "name": (lead.contact_name or "").strip() or lead.company_name,
                "status": lead.last_outcome,
            }
            for lead in recent
        ],
    }
