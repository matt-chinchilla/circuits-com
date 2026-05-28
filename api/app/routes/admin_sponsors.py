"""Admin CRUD for the sponsors table.

Backs the React admin /admin/sponsors page. Previously the admin console
only wrote sponsors to browser localStorage, so admin-created/edited
sponsors never reached the database — and the public site (which reads the
category sponsor straight from the `sponsors` table in
category_service.py) never saw them. This router is the missing WRITE
path: it persists sponsors so admin edits show up live on the public site.

Auth-gated like the rest of /admin/* via Depends(get_current_user).

The Sponsor model enforces a category_id-XOR-keyword CheckConstraint at the
Postgres level, but tests run on SQLite (which ignores CHECK constraints),
so the XOR is ALSO validated here in Python — exactly one of category_id /
keyword must be set, else 422.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Sponsor, Supplier, User
from app.schemas.sponsor import (
    AdminSponsorCreate,
    AdminSponsorResponse,
    AdminSponsorUpdate,
)
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/admin/sponsors", tags=["admin-sponsors"])


def _serialize(sponsor: Sponsor) -> AdminSponsorResponse:
    """Build the joined admin response, pulling names/icon off relationships."""
    return AdminSponsorResponse(
        id=sponsor.id,
        supplier_id=sponsor.supplier_id,
        supplier_name=sponsor.supplier.name if sponsor.supplier else "",
        category_id=sponsor.category_id,
        category_name=sponsor.category.name if sponsor.category else None,
        category_icon=sponsor.category.icon if sponsor.category else None,
        keyword=sponsor.keyword,
        tier=sponsor.tier,
        image_url=sponsor.image_url,
        description=sponsor.description,
        start_date=sponsor.start_date,
        end_date=sponsor.end_date,
        amount=sponsor.amount,
        status=sponsor.status,
    )


def _validate_xor(category_id: uuid.UUID | None, keyword: str | None) -> None:
    """Exactly one of category_id / keyword must be set, else 422.

    Enforced in Python because SQLite (used in tests) ignores the model's
    CheckConstraint. Mirrors the Postgres constraint at runtime.
    """
    has_category = category_id is not None
    has_keyword = bool(keyword)
    if has_category == has_keyword:
        raise HTTPException(
            status_code=422,
            detail="Exactly one of category_id or keyword must be set.",
        )


def _parse_sponsor_id(sponsor_id: str) -> uuid.UUID:
    """Path-param id → UUID. Bad id is treated as not-found (404).

    Sponsor.id is a UUID column; under SQLite the ORM needs a real UUID to
    build the WHERE clause (a bare str throws 'str has no attribute hex').
    """
    try:
        return uuid.UUID(sponsor_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="Sponsor not found") from None


@router.get("/", response_model=list[AdminSponsorResponse])
def list_sponsors(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sponsors = db.query(Sponsor).order_by(Sponsor.created_at.desc()).all()
    return [_serialize(s) for s in sponsors]


@router.post("/", response_model=AdminSponsorResponse)
def create_sponsor(
    body: AdminSponsorCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _validate_xor(body.category_id, body.keyword)

    supplier = db.query(Supplier).filter(Supplier.id == body.supplier_id).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=body.supplier_id,
        category_id=body.category_id,
        keyword=body.keyword,
        tier=body.tier,
        image_url=body.image_url,
        description=body.description,
        start_date=body.start_date,
        end_date=body.end_date,
        amount=body.amount,
        status=body.status,
    )
    db.add(sponsor)
    db.commit()
    db.refresh(sponsor)
    return _serialize(sponsor)


@router.patch("/{sponsor_id}", response_model=AdminSponsorResponse)
def update_sponsor(
    sponsor_id: str,
    body: AdminSponsorUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sponsor = db.query(Sponsor).filter(Sponsor.id == _parse_sponsor_id(sponsor_id)).first()
    if not sponsor:
        raise HTTPException(status_code=404, detail="Sponsor not found")

    update_data = body.model_dump(exclude_unset=True)

    # Re-validate XOR against the post-update state so a PATCH can't leave the
    # row in an illegal both-set / neither-set configuration.
    if "category_id" in update_data or "keyword" in update_data:
        new_category = update_data.get("category_id", sponsor.category_id)
        new_keyword = update_data.get("keyword", sponsor.keyword)
        _validate_xor(new_category, new_keyword)

    for key, value in update_data.items():
        setattr(sponsor, key, value)

    db.commit()
    db.refresh(sponsor)
    return _serialize(sponsor)


@router.delete("/{sponsor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sponsor(
    sponsor_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sponsor = db.query(Sponsor).filter(Sponsor.id == _parse_sponsor_id(sponsor_id)).first()
    if not sponsor:
        raise HTTPException(status_code=404, detail="Sponsor not found")
    db.delete(sponsor)
    db.commit()
