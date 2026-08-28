"""Admin Leads CRM — /api/admin/leads. ADMIN-INTERNAL sales data.

Own router by design (never the mixed suppliers router): every route here is
double-gated. The roster is internal sales tooling — real people's contact
details — so it is STAFF-only on READS as well as writes: the router carries
`require_staff` and every route additionally names `require_leads_access`, so
the one leads endpoint that lives on another router (`/api/dashboard/leads/
recent`) carries the same gate. Guard: test_leads_never_public.py.

THE COMPANY'S CRM IS THE COMPANY'S ROWS (migration 045). `leads` now also holds
CUSTOMERS' own prospect lists, marked by a non-NULL `user_id`, so every read
here filters `user_id IS NULL`. A customer's call list is the businesses THEY
want to sell to — it is not our roster, and it must not appear in it.
"""

from __future__ import annotations

import uuid as uuid_mod

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Lead, LeadContact
from app.models.user import User
from app.services.auth_service import require_staff
from app.services.leads import VALID_OUTCOMES, record_outcome

router = APIRouter(
    prefix="/api/admin/leads",
    tags=["admin-leads"],
    # The customer/staff wall (D16) sits on the router: everything served
    # here is company-wide STAFF data, so an activated customer is refused
    # with 403 staff_only rather than admitted as a console user. It COMPOSES
    # with the per-route get_current_user gates — it does not replace them.
    dependencies=[Depends(require_staff)],
)



def require_leads_access(user: User = Depends(require_staff)) -> User:
    """STAFF — for READS as well as writes.

    Depends on ``require_staff``, which composes ``get_current_user``, so the
    forced password-change gate (`must_change_password` → 403
    ``password_change_required``) still runs first and a customer account gets
    403 ``staff_only``. Named separately from the router dependency because
    ``/api/dashboard/leads/recent`` lives on another router and must carry the
    same gate — test_leads_never_public.py is what notices if it stops.
    """
    return user


def _lead_row(lead: Lead) -> dict:
    return {
        "id": str(lead.id),
        "company_name": lead.company_name,
        "branch_label": lead.branch_label,
        "company_slug": lead.company_slug,
        "manufacturer_id": str(lead.manufacturer_id) if lead.manufacturer_id else None,
        "tier": lead.tier,
        "ring": lead.ring,
        "city": lead.city,
        "state": lead.state,
        # Numeric → float here: Postgres NUMERIC serializes as a JSON STRING
        # (the AdminSponsor.amount trap), and the client sorts/formats this.
        "distance_miles": float(lead.distance_miles) if lead.distance_miles is not None else None,
        "contact_name": lead.contact_name,
        "contact_title": lead.contact_title,
        "needs_enrichment": lead.needs_enrichment,
        "last_outcome": lead.last_outcome,
        "last_contacted_at": lead.last_contacted_at.isoformat() if lead.last_contacted_at else None,
        "contact_attempts": lead.contact_attempts,
    }


def _lead_detail(lead: Lead) -> dict:
    d = _lead_row(lead)
    d.update({
        "street": lead.street, "postal_code": lead.postal_code,
        "main_phone": lead.main_phone, "website": lead.website,
        "sales_email": lead.sales_email, "direct_phone": lead.direct_phone,
        "contact_email": lead.contact_email, "linkedin_url": lead.linkedin_url,
        "hours_tz": lead.hours_tz, "notes": lead.notes,
        "contacts": [
            {
                "id": str(c.id), "outcome": c.outcome, "sale_tier": c.sale_tier,
                "note": c.note, "recorded_by": c.recorded_by,
                "created_at": c.created_at.isoformat(),
            }
            for c in lead.contacts
        ],
    })
    return d


_SORTS = {
    "company": Lead.company_name, "contact": Lead.contact_name, "tier": Lead.tier,
    "ring": Lead.ring, "outcome": Lead.last_outcome, "contacted": Lead.last_contacted_at,
    "distance": Lead.distance_miles,
}


@router.get("/")
def list_leads(
    page: int = 1,
    per_page: int = 50,
    q: str | None = None,
    outcome: str | None = None,
    tier: str | None = None,
    ring: str | None = None,
    needs_enrichment: bool | None = None,
    min_miles: float | None = Query(None, ge=0),
    max_miles: float | None = Query(None, ge=0),
    sort: str = "company",
    desc: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(require_leads_access),
) -> dict:
    per_page = max(1, min(per_page, 100))
    page = max(1, page)
    # The company/customer split, before any other filter: see the module
    # docstring. A customer's own prospects are never roster material.
    query = db.query(Lead).filter(Lead.user_id.is_(None))
    if q:
        like = f"%{q}%"
        query = query.filter(or_(
            Lead.company_name.ilike(like), Lead.contact_name.ilike(like),
            Lead.city.ilike(like), Lead.notes.ilike(like),
        ))
    if outcome == "none":
        query = query.filter(Lead.last_outcome.is_(None))
    elif outcome:
        query = query.filter(Lead.last_outcome == outcome)
    if tier:
        query = query.filter(Lead.tier == tier)
    if ring:
        query = query.filter(Lead.ring == ring)
    if needs_enrichment is not None:
        query = query.filter(Lead.needs_enrichment == needs_enrichment)
    # Distance filters EXCLUDE unknown-distance rows on purpose: "within 50
    # miles" is a claim, and a lead whose ZIP we couldn't place can't make it.
    # (NULL fails both comparisons in SQL, so no explicit isnot(None) needed.)
    if min_miles is not None:
        query = query.filter(Lead.distance_miles >= min_miles)
    if max_miles is not None:
        query = query.filter(Lead.distance_miles < max_miles)
    total = query.count()
    col = _SORTS.get(sort, Lead.company_name)
    # NULLS LAST in BOTH directions: most sortable columns here are nullable
    # ("no data"), and Postgres floats NULLs FIRST on DESC by default — which
    # turned "Newest first" into 189 never-contacted rows on top. SQLite
    # defaults the other way, so only an explicit nullslast() behaves the same
    # in tests and prod.
    order = col.desc().nullslast() if desc else col.asc().nullslast()
    rows = query.order_by(order, Lead.company_name.asc()).offset((page - 1) * per_page).limit(per_page).all()
    return {"leads": [_lead_row(x) for x in rows], "total": total, "page": page, "per_page": per_page}


@router.get("/reps/{username}")
def rep_activity(
    username: str,
    limit: int = 200,
    db: Session = Depends(get_db),
    user: User = Depends(require_leads_access),
) -> dict:
    limit = max(1, min(limit, 500))
    # Company rows only, like every other read here: the moment anything
    # records a LeadContact against a customer-owned lead, an unfiltered feed
    # would surface that customer's private prospects in the rep's activity.
    contacts = (
        db.query(LeadContact)
        .join(Lead, Lead.id == LeadContact.lead_id)
        .filter(LeadContact.recorded_by == username, Lead.user_id.is_(None))
        .order_by(LeadContact.created_at.desc())
        .limit(limit)
        .all()
    )
    lead_ids = {c.lead_id for c in contacts}
    leads = {l.id: l for l in db.query(Lead).filter(Lead.id.in_(lead_ids)).all()} if lead_ids else {}
    mix_rows = (
        db.query(LeadContact.outcome, func.count(LeadContact.id))
        .join(Lead, Lead.id == LeadContact.lead_id)
        .filter(LeadContact.recorded_by == username, Lead.user_id.is_(None))
        .group_by(LeadContact.outcome)
        .all()
    )
    return {
        "username": username,
        "outcome_mix": {row[0]: row[1] for row in mix_rows},
        "contacts": [
            {
                "id": str(c.id), "lead_id": str(c.lead_id),
                "company_name": leads[c.lead_id].company_name if c.lead_id in leads else None,
                "contact_name": leads[c.lead_id].contact_name if c.lead_id in leads else None,
                "outcome": c.outcome, "sale_tier": c.sale_tier, "note": c.note,
                "recorded_by": c.recorded_by,
                "created_at": c.created_at.isoformat(),
            }
            for c in contacts
        ],
    }


def _get_lead(db: Session, lead_id: str) -> Lead:
    """A company row, by id. A customer's own lead is 404 here, not 403 —
    as far as this roster is concerned that id is not in it."""
    try:
        key = uuid_mod.UUID(lead_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Lead not found")
    lead = db.query(Lead).filter(Lead.id == key, Lead.user_id.is_(None)).first()
    if lead is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Lead not found")
    return lead


@router.get("/{lead_id}")
def get_lead(lead_id: str, db: Session = Depends(get_db), user: User = Depends(require_leads_access)) -> dict:
    return _lead_detail(_get_lead(db, lead_id))


class LeadUpdate(BaseModel):
    contact_name: str | None = Field(default=None, max_length=120)
    contact_title: str | None = Field(default=None, max_length=120)
    direct_phone: str | None = Field(default=None, max_length=24)
    contact_email: str | None = Field(default=None, max_length=200)
    linkedin_url: str | None = Field(default=None, max_length=300)
    hours_tz: str | None = Field(default=None, max_length=40)
    notes: str | None = None


@router.patch("/{lead_id}")
def update_lead(
    lead_id: str,
    body: LeadUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_leads_access),
) -> dict:
    lead = _get_lead(db, lead_id)
    data = body.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(lead, key, value)
    if data.get("contact_name"):
        lead.needs_enrichment = False
    db.commit()
    return _lead_detail(lead)


class ContactCreate(BaseModel):
    outcome: str
    sale_tier: str | None = Field(default=None, max_length=10)
    note: str | None = Field(default=None, max_length=500)


@router.post("/{lead_id}/contacts")
def create_contact(
    lead_id: str,
    body: ContactCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_leads_access),
) -> dict:
    lead = _get_lead(db, lead_id)
    if body.outcome not in VALID_OUTCOMES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="invalid_outcome")
    record_outcome(
        db, lead=lead, outcome=body.outcome, sale_tier=body.sale_tier,
        note=body.note, recorded_by=user.username,
    )
    return _lead_detail(lead)
