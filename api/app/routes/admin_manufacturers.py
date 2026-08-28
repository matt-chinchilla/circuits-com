"""Admin Manufacturers — /api/admin/manufacturers.

Own router (never the mixed suppliers router). Sponsorship stays supplier-
keyed: `promote` / `link` connect a manufacturer to a Supplier row and the
fortified single-slot machinery is never touched (owner decision L2).
"""

from __future__ import annotations

import re
import uuid as uuid_mod

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Manufacturer, ManufacturerAlias, ManufacturerMergeCandidate, Part, Sponsor, Supplier
from app.models.user import User
from app.services.auth_service import get_current_user, require_staff
from app.services.manufacturer_canon import canon

router = APIRouter(
    prefix="/api/admin/manufacturers",
    tags=["admin-manufacturers"],
    # The customer/staff wall (D16) sits on the router: everything served
    # here is company-wide STAFF data, so an activated customer is refused
    # with 403 staff_only rather than admitted as a console user. It COMPOSES
    # with the per-route get_current_user gates — it does not replace them.
    dependencies=[Depends(require_staff)],
)


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")
    return s or "manufacturer"


def _row(m: Manufacturer, linked: Supplier | None) -> dict:
    return {
        "id": str(m.id), "name": m.name, "slug": m.slug,
        "website": m.website, "source": m.source,
        "catalog_part_count": m.catalog_part_count,
        "external_part_count": m.external_part_count,
        "linked_supplier_id": str(linked.id) if linked else None,
        "linked_supplier_name": linked.name if linked else None,
    }


_SORTS = {"name": Manufacturer.name, "catalog": Manufacturer.catalog_part_count,
          "external": Manufacturer.external_part_count, "source": Manufacturer.source}


@router.get("/")
def list_manufacturers(
    page: int = 1, per_page: int = 50, q: str | None = None,
    source: str | None = None, linked: bool | None = None,
    sort: str = "name", desc: bool = False,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    per_page = max(1, min(per_page, 100))
    page = max(1, page)
    query = db.query(Manufacturer)
    if q:
        like = f"%{q}%"
        query = query.filter(or_(Manufacturer.name.ilike(like), Manufacturer.website.ilike(like)))
    if source:
        query = query.filter(Manufacturer.source == source)
    if linked is not None:
        # Only pay for the link set when the filter actually consults it —
        # and select the one column, not full ORM rows.
        linked_ids = {
            row[0]
            for row in db.query(Supplier.manufacturer_id)
            .filter(Supplier.manufacturer_id.isnot(None))
            .all()
        }
        if linked is True:
            query = query.filter(Manufacturer.id.in_(linked_ids or {uuid_mod.uuid4()}))
        elif linked_ids:
            query = query.filter(~Manufacturer.id.in_(linked_ids))
    total = query.count()
    col = _SORTS.get(sort, Manufacturer.name)
    rows = (
        # nullslast both ways — external_part_count is NULL for catalog-sourced
        # rows and Postgres would float them on DESC (see admin_leads note).
        query.order_by(
            col.desc().nullslast() if desc else col.asc().nullslast(),
            Manufacturer.name.asc(),
        )
        .offset((page - 1) * per_page).limit(per_page).all()
    )
    suppliers_by_mid = {
        s.manufacturer_id: s
        for s in db.query(Supplier).filter(Supplier.manufacturer_id.in_([m.id for m in rows])).all()
    } if rows else {}
    return {
        "manufacturers": [_row(m, suppliers_by_mid.get(m.id)) for m in rows],
        "total": total, "page": page, "per_page": per_page,
    }


def _get(db: Session, manufacturer_id: str) -> Manufacturer:
    try:
        key = uuid_mod.UUID(manufacturer_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Manufacturer not found")
    m = db.get(Manufacturer, key)
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Manufacturer not found")
    return m


def _linked_supplier(db: Session, m: Manufacturer) -> Supplier | None:
    return db.query(Supplier).filter(Supplier.manufacturer_id == m.id).first()


@router.get("/{manufacturer_id}")
def get_manufacturer(
    manufacturer_id: str,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    m = _get(db, manufacturer_id)
    linked = _linked_supplier(db, m)
    d = _row(m, linked)
    d.update({
        "description": m.description, "logo_url": m.logo_url,
        "canonical_key": m.canonical_key,
        "external_part_count_as_of": m.external_part_count_as_of.isoformat() if m.external_part_count_as_of else None,
        "aliases": [
            {"alias": a.alias, "source": a.source, "confidence": a.confidence}
            for a in m.aliases
        ],
        "merge_candidates": [
            {"id": str(c.id), "right_alias": c.right_alias, "rule": c.rule,
             "evidence": c.evidence, "status": c.status}
            for c in db.query(ManufacturerMergeCandidate)
            .filter_by(left_manufacturer_id=m.id, status="pending").all()
        ],
        "linked_supplier_sponsorships": [
            {"id": str(sp.id), "tier": sp.tier, "status": sp.status,
             "category_id": str(sp.category_id) if sp.category_id else None,
             "keyword": sp.keyword}
            for sp in (
                db.query(Sponsor).filter(Sponsor.supplier_id == linked.id).all() if linked else []
            )
        ],
    })
    return d


class ManufacturerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    website: str | None = Field(default=None, max_length=300)
    description: str | None = None


class ManufacturerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    website: str | None = Field(default=None, max_length=300)
    description: str | None = None


@router.post("/")
def create_manufacturer(
    body: ManufacturerCreate,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    key = canon(body.name)
    if db.query(Manufacturer).filter_by(canonical_key=key).first():
        raise HTTPException(status.HTTP_409_CONFLICT, detail="manufacturer_exists")
    base = _slugify(body.name)
    slug, n = base, 2
    while db.query(Manufacturer).filter_by(slug=slug).first():
        slug, n = f"{base}-{n}", n + 1
    m = Manufacturer(
        id=uuid_mod.uuid4(), name=body.name, slug=slug, canonical_key=key,
        website=body.website, description=body.description, source="manual",
    )
    db.add(m)
    db.add(ManufacturerAlias(
        manufacturer_id=m.id, alias_canon=key, alias=body.name,
        source="manual", confidence="approved",
    ))
    db.commit()
    return _row(m, None)


@router.patch("/{manufacturer_id}")
def update_manufacturer(
    manufacturer_id: str, body: ManufacturerUpdate,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    m = _get(db, manufacturer_id)
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(m, key, value)
    db.commit()
    return _row(m, _linked_supplier(db, m))


@router.delete("/{manufacturer_id}")
def delete_manufacturer(
    manufacturer_id: str,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    m = _get(db, manufacturer_id)
    if _linked_supplier(db, m) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="manufacturer_has_linked_supplier")
    db.query(Part).filter(Part.manufacturer_id == m.id).update(
        {Part.manufacturer_id: None}, synchronize_session=False
    )
    db.delete(m)
    db.commit()
    return {"ok": True}


class LinkBody(BaseModel):
    supplier_id: str


@router.post("/{manufacturer_id}/promote")
def promote_to_supplier(
    manufacturer_id: str,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """Create a Supplier for this manufacturer and connect the two objects.
    Sponsorship then runs through /admin/sponsors completely unchanged."""
    m = _get(db, manufacturer_id)
    if _linked_supplier(db, m) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_linked")
    if db.query(Supplier).filter(Supplier.name == m.name).first() is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail="supplier_name_exists_use_link",
        )
    sup = Supplier(id=uuid_mod.uuid4(), name=m.name, website=m.website, manufacturer_id=m.id)
    db.add(sup)
    db.commit()
    return {"supplier_id": str(sup.id), "supplier_name": sup.name}


@router.post("/{manufacturer_id}/link")
def link_supplier(
    manufacturer_id: str, body: LinkBody,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    m = _get(db, manufacturer_id)
    if _linked_supplier(db, m) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_linked")
    try:
        sid = uuid_mod.UUID(body.supplier_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Supplier not found")
    sup = db.get(Supplier, sid)
    if sup is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Supplier not found")
    if sup.manufacturer_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="supplier_already_linked")
    sup.manufacturer_id = m.id
    db.commit()
    return {"ok": True}


@router.delete("/{manufacturer_id}/link")
def unlink_supplier(
    manufacturer_id: str,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    m = _get(db, manufacturer_id)
    sup = _linked_supplier(db, m)
    if sup is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_linked")
    sup.manufacturer_id = None
    db.commit()
    return {"ok": True}


class CandidateAction(BaseModel):
    pass


@router.post("/candidates/{candidate_id}/approve")
def approve_candidate(
    candidate_id: str,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """Human-approved merge: the right-hand spelling becomes an alias of the
    left manufacturer; parts re-point; a source='catalog' loser row is removed."""
    try:
        cid = uuid_mod.UUID(candidate_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Candidate not found")
    c = db.get(ManufacturerMergeCandidate, cid)
    if c is None or c.status != "pending":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Candidate not found")
    winner = db.get(Manufacturer, c.left_manufacturer_id)
    right_key = canon(c.right_alias)
    loser = db.query(Manufacturer).filter_by(canonical_key=right_key).first()
    existing_alias = db.get(ManufacturerAlias, {"manufacturer_id": winner.id, "alias_canon": right_key})
    if existing_alias is None:
        stale = db.query(ManufacturerAlias).filter_by(alias_canon=right_key).first()
        if stale is not None:
            db.delete(stale)
            db.flush()
        db.add(ManufacturerAlias(
            manufacturer_id=winner.id, alias_canon=right_key, alias=c.right_alias,
            source="manual", confidence="approved",
        ))
    if loser is not None and loser.id != winner.id:
        db.query(Part).filter(Part.manufacturer_id == loser.id).update(
            {Part.manufacturer_id: winner.id}, synchronize_session=False
        )
        if loser.source == "catalog" and _linked_supplier(db, loser) is None:
            db.query(ManufacturerAlias).filter_by(manufacturer_id=loser.id).update(
                {ManufacturerAlias.manufacturer_id: winner.id}, synchronize_session=False
            )
            db.expire(loser)
            db.delete(loser)
    from sqlalchemy import func
    winner.catalog_part_count = (
        db.query(func.count(Part.id)).filter(Part.manufacturer_id == winner.id).scalar() or 0
    )
    c.status = "approved"
    db.commit()
    return {"ok": True}


@router.post("/candidates/{candidate_id}/reject")
def reject_candidate(
    candidate_id: str,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    try:
        cid = uuid_mod.UUID(candidate_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Candidate not found")
    c = db.get(ManufacturerMergeCandidate, cid)
    if c is None or c.status != "pending":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Candidate not found")
    c.status = "rejected"
    db.commit()
    return {"ok": True}
