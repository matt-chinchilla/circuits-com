from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import func, extract
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Part, Supplier, Revenue, Sponsor, PartListing, Category, User
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/stats")
def get_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    parts_count = db.query(func.count(Part.id)).scalar() or 0
    suppliers_count = db.query(func.count(Supplier.id)).scalar() or 0
    revenue_total = db.query(func.sum(Revenue.amount)).scalar() or Decimal("0.00")
    sponsors_count = db.query(func.count(Sponsor.id)).scalar() or 0
    return {
        "parts_count": parts_count,
        "suppliers_count": suppliers_count,
        "revenue_total": float(revenue_total),
        "sponsors_count": sponsors_count,
    }


@router.get("/activity")
def get_activity(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    items = []

    # Recent parts
    recent_parts = (
        db.query(Part)
        .order_by(Part.created_at.desc())
        .limit(10)
        .all()
    )
    for p in recent_parts:
        items.append({
            "type": "part_added",
            "description": f"Part {p.mpn} ({p.manufacturer_name}) added",
            "created_at": p.created_at.isoformat() if p.created_at else None,
        })

    # Recent revenue entries
    recent_revenue = (
        db.query(Revenue)
        .order_by(Revenue.created_at.desc())
        .limit(10)
        .all()
    )
    for r in recent_revenue:
        items.append({
            "type": "revenue",
            "description": f"Revenue ${r.amount} ({r.type}) recorded",
            "created_at": r.created_at.isoformat() if r.created_at else None,
        })

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
            monthly[key] = {"month": key, "total": 0.0, "sponsorship": 0.0, "listing_fee": 0.0, "featured": 0.0}
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
        "top_categories": [
            {"name": name, "parts_count": count} for name, count in top_categories
        ],
        "top_suppliers": [
            {"name": name, "listings_count": count} for name, count in top_suppliers
        ],
    }
