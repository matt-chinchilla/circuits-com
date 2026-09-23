"""Rep discount codes — /api/admin/sales-codes (spec §9, owner D1/D2).

A rep creates a code worth 1–15 points off the Founder's Deal (the price rule
in ``sales_pricing`` turns points into dollars; nothing here computes one),
optionally locked to a tier, a placement, a company (R7, which then REQUIRES an
email lock) or an email, with a use limit and an expiry, and hands the
customer the READY link this route builds from the code's own locks
(``/join?code=…&tier=…&slot=…``, LU-F18).

Codes are never deleted: a rep switches one off, extends it or edits its note.
Every create and edit writes a staff-only ``billing_audit`` row.

Walls: ``require_staff`` on the router (customer 403 ``staff_only``, viewer
403 ``read_only`` on writes); the list also carries ``require_billing_reader``
(a viewer 403 ``no_billing_access`` on the READ — a live code is a bearer
discount, R6). Unlike the billing console these routes touch no Stripe, so
they answer whether or not Stripe is configured.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Category, Sponsor, Supplier, User
from app.models.sales import CODE_DEFAULT_DAYS, SalesCode, SponsorBilling
from app.models.sponsor import exclusive_occupant_clause
from app.services import billing_mirror, sales_codes, sales_pricing
from app.services.auth_service import require_billing_reader, require_staff

router = APIRouter(
    prefix="/api/admin/sales-codes",
    tags=["admin-sales-codes"],
    dependencies=[Depends(require_staff)],
)

# The 409 machine code R7 names (a CODE_MESSAGES entry on the client).
ALREADY_SPONSOR = "already_sponsor"
BOUND_NEEDS_EMAIL = "A code tied to a company needs the customer's email."

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MAX_USES = 500
_MAX_DAYS = 365
# A fresh code colliding with a stored one is a 1-in-10^12 event per try;
# five tries turning up five collisions means something else is wrong.
_GENERATE_TRIES = 5


class SalesCodeCreate(BaseModel):
    code_points: int = Field(ge=1, le=sales_pricing.MAX_CODE_POINTS)
    tier: str | None = Field(default=None, max_length=10)
    category_id: uuid.UUID | None = None
    supplier_id: uuid.UUID | None = None
    email_lock: str | None = Field(default=None, max_length=200)
    max_uses: int = Field(default=1, ge=1, le=_MAX_USES)
    expires_in_days: int = Field(default=CODE_DEFAULT_DAYS, ge=1, le=_MAX_DAYS)
    rep: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)


class SalesCodeUpdate(BaseModel):
    active: bool | None = None
    expires_in_days: int | None = Field(default=None, ge=1, le=_MAX_DAYS)
    note: str | None = Field(default=None, max_length=500)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()


def code_status(
    row: SalesCode, now: datetime | None = None
) -> Literal["live", "expired", "used_up", "off"]:
    """``off`` (switched off) outranks ``used_up`` outranks ``expired``."""
    if not row.active:
        return "off"
    if row.uses >= row.max_uses:
        return "used_up"
    expires = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=UTC)
    if expires <= (now or datetime.now(UTC)):
        return "expired"
    return "live"


def code_link(row: SalesCode) -> str:
    """The absolute /join link a rep sends — the code plus its OWN locks, so
    the page opens on the right tier and slot (LU-F18)."""
    params = {"code": sales_codes.display_code(row.code)}
    if row.tier:
        params["tier"] = row.tier
    if row.category_id:
        params["slot"] = str(row.category_id)
    return f"{settings.APP_BASE_URL.rstrip('/')}/join?{urlencode(params, safe='-')}"


def _serialize(
    row: SalesCode,
    *,
    categories: dict[uuid.UUID, str],
    suppliers: dict[uuid.UUID, str],
    sales: list[dict],
) -> dict:
    return {
        "id": str(row.id),
        "code": row.code,
        "display": sales_codes.display_code(row.code),
        "code_points": row.code_points,
        "tier": row.tier,
        "category_id": str(row.category_id) if row.category_id else None,
        "category_name": categories.get(row.category_id) if row.category_id else None,
        "supplier_id": str(row.supplier_id) if row.supplier_id else None,
        "supplier_name": suppliers.get(row.supplier_id) if row.supplier_id else None,
        "email_lock": row.email_lock,
        "max_uses": row.max_uses,
        "uses": row.uses,
        "expires_at": _iso(row.expires_at),
        "rep": row.rep,
        "created_by": row.created_by,
        "note": row.note,
        "active": row.active,
        "status": code_status(row),
        "link": code_link(row),
        "sales": sales,
    }


def _names(db: Session, rows: list[SalesCode]) -> tuple[dict, dict]:
    """Category and supplier names for the codes' locks, one query each.
    Locks are plain UUIDs (the rows may be gone after a reseed) → no name."""
    cat_ids = {r.category_id for r in rows if r.category_id}
    sup_ids = {r.supplier_id for r in rows if r.supplier_id}
    cats = (
        {c.id: c.name for c in db.query(Category).filter(Category.id.in_(cat_ids))}
        if cat_ids
        else {}
    )
    sups = (
        {s.id: s.name for s in db.query(Supplier).filter(Supplier.id.in_(sup_ids))}
        if sup_ids
        else {}
    )
    return cats, sups


def _sales(db: Session, code_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict]]:
    """The sponsorships each code produced (its ``sponsor_billing`` rows)."""
    if not code_ids:
        return {}
    rows = (
        db.query(SponsorBilling, Sponsor, Supplier)
        .join(Sponsor, Sponsor.id == SponsorBilling.sponsor_id)
        .join(Supplier, Supplier.id == Sponsor.supplier_id)
        .filter(SponsorBilling.sales_code_id.in_(code_ids))
        .order_by(Sponsor.created_at)
        .all()
    )
    out: dict[uuid.UUID, list[dict]] = {}
    for billing, sponsor, supplier in rows:
        out.setdefault(billing.sales_code_id, []).append(
            {
                "sponsor_id": str(sponsor.id),
                "company": supplier.name,
                "tier": (sponsor.tier or "").strip().lower() or None,
                "price_usd": billing.price_usd,
                "sold_at": _iso(sponsor.created_at),
            }
        )
    return out


def _one(db: Session, row: SalesCode) -> dict:
    cats, sups = _names(db, [row])
    return _serialize(
        row, categories=cats, suppliers=sups, sales=_sales(db, [row.id]).get(row.id, [])
    )


def _load(db: Session, code_id: str) -> SalesCode:
    try:
        key = uuid.UUID(code_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="Code not found") from None
    row = db.get(SalesCode, key)
    if row is None:
        raise HTTPException(status_code=404, detail="Code not found")
    return row


def _placement_tier(db: Session, category_id: uuid.UUID, tier: str | None) -> str:
    """The tier a placement lock allows: Platinum for a top-level category,
    Gold for a child (the tier matrix's exclusive half). A given tier must
    agree; an absent one is derived."""
    category = db.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=422, detail="That category does not exist.")
    implied = "gold" if category.parent_id else "platinum"
    if tier is not None and tier != implied:
        where = "a subcategory" if category.parent_id else "a top-level category"
        raise HTTPException(
            status_code=422,
            detail=f"{category.name} is {where}; only a {implied.capitalize()} code can hold it.",
        )
    return implied


def _already_sponsor(db: Session, supplier_id: uuid.UUID, category_id: uuid.UUID) -> bool:
    """R7: the bound company holds a non-Expired row on this category."""
    return (
        db.query(Sponsor.id)
        .filter(
            Sponsor.supplier_id == supplier_id,
            Sponsor.category_id == category_id,
            exclusive_occupant_clause(),
        )
        .first()
        is not None
    )


@router.get("/")
def list_codes(
    db: Session = Depends(get_db),
    _: User = Depends(require_billing_reader),
) -> dict:
    rows = db.query(SalesCode).order_by(SalesCode.created_at.desc()).all()
    cats, sups = _names(db, rows)
    sales = _sales(db, [r.id for r in rows])
    return {
        "codes": [
            _serialize(r, categories=cats, suppliers=sups, sales=sales.get(r.id, [])) for r in rows
        ]
    }


@router.post("/", status_code=status.HTTP_201_CREATED)
def create_code(
    body: SalesCodeCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
) -> dict:
    tier = body.tier.strip().lower() if body.tier and body.tier.strip() else None
    if tier is not None and tier not in sales_pricing.EXCLUSIVE_TIERS:
        # R8: Silver keeps its own checkout and takes no code.
        raise HTTPException(status_code=422, detail="Codes apply to Gold and Platinum only.")
    if body.category_id is not None:
        tier = _placement_tier(db, body.category_id, tier)

    email_lock = body.email_lock.strip().lower() if body.email_lock else None
    if email_lock == "":
        email_lock = None
    if email_lock is not None and not _EMAIL.fullmatch(email_lock):
        raise HTTPException(status_code=422, detail="That email address doesn't look right.")

    if body.supplier_id is not None:
        if email_lock is None:
            raise HTTPException(status_code=422, detail=BOUND_NEEDS_EMAIL)
        if db.get(Supplier, body.supplier_id) is None:
            raise HTTPException(status_code=422, detail="That company does not exist.")
        if body.category_id is not None and _already_sponsor(
            db, body.supplier_id, body.category_id
        ):
            raise HTTPException(status_code=409, detail=ALREADY_SPONSOR)

    rep = (body.rep or "").strip() or user.username
    note = (body.note or "").strip() or None
    for _attempt in range(_GENERATE_TRIES):
        code = sales_codes.generate_code()
        if db.query(func.count(SalesCode.id)).filter(SalesCode.code == code).scalar():
            continue
        row = SalesCode(
            code=code,
            code_points=body.code_points,
            tier=tier,
            category_id=body.category_id,
            supplier_id=body.supplier_id,
            email_lock=email_lock,
            max_uses=body.max_uses,
            uses=0,
            expires_at=datetime.now(UTC) + timedelta(days=body.expires_in_days),
            rep=rep[:120],
            created_by=user.username[:120],
            note=note,
            active=True,
        )
        db.add(row)
        try:
            db.flush()
        except IntegrityError:  # a concurrent create took the same code
            db.rollback()
            continue
        billing_mirror.audit(
            db,
            user.username,
            "code_created",
            sales_code_id=row.id,
            detail=(
                f"{sales_codes.display_code(code)}: {body.code_points} pts"
                f"{f', {tier}' if tier else ''} for {rep}"
            ),
        )
        db.commit()
        db.refresh(row)
        return _one(db, row)
    raise HTTPException(status_code=503, detail="Could not mint a unique code — try again.")


@router.patch("/{code_id}")
def update_code(
    code_id: str,
    body: SalesCodeUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
) -> dict:
    row = _load(db, code_id)
    changes = body.model_dump(exclude_unset=True)
    said: list[str] = []
    if changes.get("active") is not None:
        row.active = bool(changes["active"])
        said.append("on" if row.active else "off")
    if changes.get("expires_in_days") is not None:
        row.expires_at = datetime.now(UTC) + timedelta(days=changes["expires_in_days"])
        said.append(f"expires in {changes['expires_in_days']}d")
    if "note" in changes:
        row.note = (changes["note"] or "").strip() or None
        said.append("note")
    if said:
        billing_mirror.audit(
            db,
            user.username,
            "code_updated",
            sales_code_id=row.id,
            detail=f"{sales_codes.display_code(row.code)}: {', '.join(said)}",
        )
    db.commit()
    db.refresh(row)
    return _one(db, row)
