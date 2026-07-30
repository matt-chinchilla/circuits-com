"""Admin dashboard aggregates (/api/dashboard/*) plus a couple of /api/admin/* lookups.

Two conventions run through every handler here and MUST be preserved:

1. **Every dollar figure is ``float()``-cast.** ``amount`` columns are Postgres
   ``NUMERIC``, which serializes to a JSON *string* (e.g. "1500.00") — a chart
   that string-compares/concatenates those silently renders garbage. The admin
   CRUD responses (AdminSponsorResponse / ExpenseResponse) intentionally keep
   ``Decimal`` (→ string) for round-trip fidelity; the aggregates below do not.

2. **Days/months are bucketed in America/New_York**, not UTC. "Today" on the
   dashboard means the business day in EST/EDT, so a 9pm-ET page view belongs to
   that day and not to tomorrow. Timestamps come back from SQLite naive (they
   are written as UTC wall-clock) and from Postgres tz-aware, so ``_est_day``
   normalizes both before bucketing.
"""

import calendar
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy import extract, func, or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import (
    Category,
    Expense,
    PageView,
    Part,
    PartListing,
    Revenue,
    Sponsor,
    Supplier,
    User,
)
from app.models.expense import expense_category_label
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

# A second router for the /api/admin/* lookups the dashboard + sponsor form
# need. Registered separately in main.py (`dashboard.admin_router`).
admin_router = APIRouter(prefix="/api/admin", tags=["admin"])

EASTERN = ZoneInfo("America/New_York")

# Windows are clamped so a hand-crafted ?days=100000 can't make us materialize
# an unbounded series (each point is a dict in the JSON response).
_MAX_TREND_DAYS = 365
_MAX_COMPARE_MONTHS = 24

# PLACEHOLDER billing figures — used only when a Sponsor row has no explicit
# `amount`, so the sales-rep rollup still shows a plausible book value instead
# of $0. Replace with the real rate card once pricing is settled (the keyword
# tier prices in frontend/.../keyword-landing/constants.ts are placeholders for
# the same reason).
_TIER_DEFAULT_AMOUNT: dict[str, Decimal] = {
    "platinum": Decimal("2500"),
    "gold": Decimal("900"),
    "silver": Decimal("300"),
}


# ---------------------------------------------------------------------------
# Time helpers (America/New_York)
# ---------------------------------------------------------------------------


def _today_est() -> date:
    """The current business day in America/New_York."""
    return datetime.now(EASTERN).date()


def _est_day(value: datetime | None) -> date | None:
    """Calendar day (EST/EDT) of a stored timestamp.

    Naive values are treated as UTC: SQLite drops tzinfo on write, so a column
    written from ``datetime.now(UTC)`` reads back naive-but-UTC. Postgres
    returns tz-aware values, which ``astimezone`` handles directly.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(EASTERN).date()


def _day_start_utc(day: date) -> datetime:
    """Midnight of an EST day as a UTC instant — the SQL cutoff for that day.

    Comparing a stored timestamp against this is exact in both engines:
    Postgres compares timestamptz properly, and SQLite's DATETIME bind
    processor drops tzinfo, leaving a UTC wall-clock string on both sides.
    """
    return datetime.combine(day, time.min, tzinfo=EASTERN).astimezone(UTC)


def _day_window(days: int) -> list[date]:
    """Exactly ``days`` consecutive EST dates ending today (inclusive)."""
    days = max(1, min(days, _MAX_TREND_DAYS))
    today = _today_est()
    return [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]


def _month_start(anchor: date, months_ago: int) -> date:
    """First day of the calendar month ``months_ago`` months before ``anchor``.

    Proper year/month arithmetic — NOT ``anchor - timedelta(days=30*n)``, which
    skips a month whenever a 28/29-day February is in the span.
    """
    month_index = anchor.year * 12 + (anchor.month - 1) - months_ago
    return date(month_index // 12, month_index % 12 + 1, 1)


def _month_end(first_of_month: date) -> date:
    last_day = calendar.monthrange(first_of_month.year, first_of_month.month)[1]
    return first_of_month.replace(day=last_day)


# ---------------------------------------------------------------------------
# Series builders
# ---------------------------------------------------------------------------


def _cumulative_series(db: Session, model, day_list: list[date]) -> list[dict]:
    """Running total of rows whose ``created_at`` is on/before each day.

    Forward-filled by construction: the running counter carries across days
    with no new rows, so the series never dips or gaps. Rows created before the
    window (and rows with a NULL ``created_at`` — legacy seed data predating
    migration 002's timestamp columns) form the starting baseline, so day 1 is a
    true cumulative total rather than a window-local count. Only the in-window
    timestamps are pulled into Python; the rest collapse to one COUNT.
    """
    cutoff = _day_start_utc(day_list[0])
    baseline = (
        db.query(func.count(model.id))
        .filter(or_(model.created_at < cutoff, model.created_at.is_(None)))
        .scalar()
        or 0
    )

    per_day: dict[date, int] = defaultdict(int)
    for (created,) in db.query(model.created_at).filter(model.created_at >= cutoff).all():
        day = _est_day(created)
        # Future-dated rows are excluded until their day is reached.
        if day is not None and day <= day_list[-1]:
            per_day[day] += 1

    running = baseline
    series = []
    for day in day_list:
        running += per_day.get(day, 0)
        series.append({"day": day.isoformat(), "value": running})
    return series


def _daily_count_series(db: Session, model, day_list: list[date]) -> list[dict]:
    """Per-day row count, zero-filled across the whole window."""
    cutoff = _day_start_utc(day_list[0])
    per_day: dict[date, int] = defaultdict(int)
    for (created,) in db.query(model.created_at).filter(model.created_at >= cutoff).all():
        day = _est_day(created)
        if day is not None and day <= day_list[-1]:
            per_day[day] += 1
    return [{"day": day.isoformat(), "value": per_day.get(day, 0)} for day in day_list]


def _daily_amount_series(db: Session, model, day_list: list[date]) -> list[dict]:
    """Per-day money total, zero-filled across the whole window.

    Rows are attributed to ``period_start`` — the date the money is recognized —
    for both Revenue and Expense. NOTE: seeded rows are MONTHLY recurring
    entries, so their whole amount lands on the 1st; a smooth daily curve would
    need either daily rows or an amortization pass (deliberately not faked here).
    """
    per_day: dict[date, Decimal] = defaultdict(Decimal)
    rows = (
        db.query(model.period_start, model.amount)
        .filter(model.period_start >= day_list[0], model.period_start <= day_list[-1])
        .all()
    )
    for period_start, amount in rows:
        per_day[period_start] += Decimal(str(amount or 0))
    return [
        {"day": day.isoformat(), "value": float(per_day.get(day, Decimal(0)))} for day in day_list
    ]


def _monthly_daily_series(db: Session, model, months: int) -> list[dict]:
    """Newest-first months, each with a full day-of-month money series.

    Every month carries exactly ``days_in_month`` points; days with no rows (and
    every future day of the current month) are 0.
    """
    months = max(1, min(months, _MAX_COMPARE_MONTHS))
    today = _today_est()

    out: list[dict] = []
    for months_ago in range(months):  # 0 == current month → newest first
        first = _month_start(today, months_ago)
        last = _month_end(first)

        totals: dict[int, Decimal] = defaultdict(Decimal)
        rows = (
            db.query(model.period_start, model.amount)
            .filter(model.period_start >= first, model.period_start <= last)
            .all()
        )
        for period_start, amount in rows:
            totals[period_start.day] += Decimal(str(amount or 0))

        out.append(
            {
                "key": f"{first.year:04d}-{first.month:02d}",
                "label": calendar.month_name[first.month],
                "daily": [
                    {"day": day, "value": float(totals.get(day, Decimal(0)))}
                    for day in range(1, last.day + 1)
                ],
            }
        )
    return out


def _current_month_bounds() -> tuple[date, date]:
    first = _today_est().replace(day=1)
    return first, _month_end(first)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/demo-status")
def get_demo_status(db: Session = Depends(get_db)):
    """Returns whether demo data exists (parts > 0 means demo mode is available)."""
    parts_count = db.query(Part).count()
    return {"demo_available": parts_count > 0, "parts_count": parts_count}


@router.get("/stats")
def get_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    parts_count = db.query(func.count(Part.id)).scalar() or 0
    suppliers_count = db.query(func.count(Supplier.id)).scalar() or 0
    revenue_total = db.query(func.sum(Revenue.amount)).scalar() or Decimal("0.00")
    sponsors_count = db.query(func.count(Sponsor.id)).scalar() or 0

    # Current calendar month (EST). "Covers" = the row's period OVERLAPS the
    # month, so a multi-month contract counts toward the month it spans, not
    # only the month it started in.
    month_start, month_end = _current_month_bounds()
    monthly_revenue = db.query(func.sum(Revenue.amount)).filter(
        Revenue.period_start <= month_end, Revenue.period_end >= month_start
    ).scalar() or Decimal("0.00")

    return {
        "parts_count": parts_count,
        "suppliers_count": suppliers_count,
        "revenue_total": float(revenue_total),
        "sponsors_count": sponsors_count,
        "monthly_revenue": float(monthly_revenue),
    }


@router.get("/trends")
def get_trends(
    days: int = 30,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Five day-indexed series for the dashboard sparklines.

    parts / suppliers / sponsors are CUMULATIVE totals (forward-filled);
    revenue and traffic are per-day sums/counts (zero-filled). Every series has
    exactly ``days`` points, aligned to the same EST dates and ending today —
    the frontend can zip them by index without re-checking labels.
    """
    day_list = _day_window(days)
    return {
        "days": len(day_list),
        "series": {
            "parts": _cumulative_series(db, Part, day_list),
            "suppliers": _cumulative_series(db, Supplier, day_list),
            "sponsors": _cumulative_series(db, Sponsor, day_list),
            "revenue": _daily_amount_series(db, Revenue, day_list),
            "traffic": _daily_count_series(db, PageView, day_list),
        },
    }


@router.get("/revenue-compare")
def get_revenue_compare(
    months: int = 3,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Month-over-month revenue, newest month first, one point per day-of-month."""
    return {"months": _monthly_daily_series(db, Revenue, months)}


@router.get("/expenses")
def get_expenses_compare(
    months: int = 3,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Same shape as /revenue-compare, over Expense rows (monthly recurring costs).

    The AWS line is a list-price ESTIMATE (see services/aws_cost.py), not an
    invoiced actual — label it as such wherever it sits next to real revenue.
    """
    return {"months": _monthly_daily_series(db, Expense, months)}


@router.get("/expenses/breakdown")
def get_expenses_breakdown(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Current-month spend grouped by category.

    One entry PER CATEGORY (never duplicated), so the frontend can key a
    pie/legend on ``category`` safely; when several vendors share a category
    their names are comma-joined into ``vendor``. Sorted by amount desc.
    """
    month_start, month_end = _current_month_bounds()
    rows = (
        db.query(Expense)
        .filter(Expense.period_start >= month_start, Expense.period_start <= month_end)
        .all()
    )

    grouped: dict[str, dict] = {}
    for row in rows:
        key = (row.category or "other").strip().lower()
        bucket = grouped.setdefault(key, {"amount": Decimal(0), "vendors": []})
        bucket["amount"] += Decimal(str(row.amount or 0))
        vendor = (row.vendor or "").strip()
        if vendor and vendor not in bucket["vendors"]:
            bucket["vendors"].append(vendor)

    categories = [
        {
            "category": key,
            "label": expense_category_label(key),
            "amount": float(bucket["amount"]),
            "vendor": ", ".join(bucket["vendors"]),
        }
        for key, bucket in sorted(grouped.items(), key=lambda kv: (-kv[1]["amount"], kv[0]))
    ]
    total = sum((Decimal(str(row.amount or 0)) for row in rows), Decimal(0))

    return {
        "month": f"{month_start.year:04d}-{month_start.month:02d}",
        "total": float(total),
        "categories": categories,
    }


@router.get("/sales-reps")
def get_sales_reps(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Book of business per sales rep, from ACTIVE sponsorships that carry sold_by.

    NULL ``status`` counts as Active — legacy seed rows omit the column, and a
    naive ``status != 'Expired'`` filter would silently drop them (SQL
    three-valued logic; the CLAUDE.md Sponsor.status gotcha).

    ``amount`` falls back to a PLACEHOLDER tier rate (_TIER_DEFAULT_AMOUNT) when
    the sponsorship has no explicit amount, so a rep's total is never understated
    by unfilled billing data. Tier casing is normalized on read (admin writes
    TitleCase, legacy seed rows are lowercase).
    """
    rows = (
        db.query(Sponsor, Supplier.name)
        .join(Supplier, Supplier.id == Sponsor.supplier_id)
        .filter(
            Sponsor.sold_by.isnot(None),
            Sponsor.sold_by != "",
            or_(Sponsor.status == "Active", Sponsor.status.is_(None)),
        )
        .all()
    )

    reps: dict[str, dict] = {}
    for sponsor, supplier_name in rows:
        rep_name = (sponsor.sold_by or "").strip()
        if not rep_name:
            continue
        tier_key = (sponsor.tier or "").strip().lower()
        if sponsor.amount is not None:
            amount = Decimal(str(sponsor.amount))
        else:
            amount = _TIER_DEFAULT_AMOUNT.get(tier_key, Decimal(0))

        rep = reps.setdefault(rep_name, {"name": rep_name, "total": Decimal(0), "customers": []})
        rep["total"] += amount
        rep["customers"].append(
            {
                "company": supplier_name or "",
                "tier": tier_key.capitalize(),
                "amount": float(amount),
            }
        )

    ordered = sorted(reps.values(), key=lambda r: (-r["total"], r["name"]))
    return {
        "reps": [
            {
                "name": rep["name"],
                "total": float(rep["total"]),
                "customers": sorted(rep["customers"], key=lambda c: (-c["amount"], c["company"])),
            }
            for rep in ordered
        ]
    }


@admin_router.get("/sales-reps")
def list_sales_reps(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Usernames of admin-role users — the `sold_by` options on the sponsor form.

    Every admin account is a candidate rep (there is no separate rep table), so
    this includes service logins like `demo`. Sorted case-insensitively for a
    stable dropdown order.
    """
    usernames = [
        row[0] for row in db.query(User.username).filter(User.role == "admin").all() if row[0]
    ]
    return {"reps": sorted(usernames, key=str.lower)}


@router.get("/activity")
def get_activity(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    items = []

    # Recent parts
    recent_parts = db.query(Part).order_by(Part.created_at.desc()).limit(10).all()
    for p in recent_parts:
        items.append(
            {
                "type": "part_added",
                "description": f"Part {p.sku} ({p.manufacturer_name}) added",
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
        )

    # Recent revenue entries
    recent_revenue = db.query(Revenue).order_by(Revenue.created_at.desc()).limit(10).all()
    for r in recent_revenue:
        items.append(
            {
                "type": "revenue",
                "description": f"Revenue ${r.amount} ({r.type}) recorded",
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
        )

    # Sort combined by created_at desc, take top 10
    items.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return items[:10]


@router.get("/revenue")
def get_revenue(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    today = date.today()
    twelve_months_ago = date(today.year - 1, today.month, 1)

    rows = (
        db.query(
            extract("year", Revenue.period_start).label("year"),
            extract("month", Revenue.period_start).label("month"),
            Revenue.type,
            func.sum(Revenue.amount).label("total"),
        )
        .filter(Revenue.period_start >= twelve_months_ago)
        .group_by(
            extract("year", Revenue.period_start),
            extract("month", Revenue.period_start),
            Revenue.type,
        )
        .all()
    )

    # Build monthly buckets
    monthly = {}
    for row in rows:
        year = int(row.year)
        month = int(row.month)
        key = f"{year:04d}-{month:02d}"
        if key not in monthly:
            monthly[key] = {
                "month": key,
                "total": 0.0,
                "sponsorship": 0.0,
                "listing_fee": 0.0,
                "featured": 0.0,
            }
        amount = float(row.total)
        monthly[key]["total"] += amount
        if row.type in monthly[key]:
            monthly[key][row.type] += amount

    # Sort by month
    result = sorted(monthly.values(), key=lambda x: x["month"])
    return result


@router.get("/popular")
def get_popular(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Top categories by parts count
    top_categories = (
        db.query(Category.name, func.count(Part.id).label("parts_count"))
        .join(Part, Part.category_id == Category.id)
        .group_by(Category.name)
        .order_by(func.count(Part.id).desc())
        .limit(10)
        .all()
    )

    # Top suppliers by listings count
    top_suppliers = (
        db.query(Supplier.name, func.count(PartListing.id).label("listings_count"))
        .join(PartListing, PartListing.supplier_id == Supplier.id)
        .group_by(Supplier.name)
        .order_by(func.count(PartListing.id).desc())
        .limit(10)
        .all()
    )

    return {
        "top_categories": [{"name": name, "parts_count": count} for name, count in top_categories],
        "top_suppliers": [{"name": name, "listings_count": count} for name, count in top_suppliers],
    }
