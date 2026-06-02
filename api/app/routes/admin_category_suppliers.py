"""Admin endpoints for featured-supplier toggling on categories.

The `/feature` endpoint upserts a CategorySupplier row with
`is_featured=True` so a supplier appears on the public category's
Preferred Partners banner. The `/unfeature` companion (added 2026-06-02
for the v15 banner add/remove flow) sets `is_featured=False` on an
existing row — non-destructive, the row itself stays so any
non-featured association the admin keeps (e.g. "ships these parts")
isn't lost.

The original feature-only design served the guided-tour wizard, whose
cleanup path is to delete the demo supplier and let cascade remove the
join row. The v15 banner is the admin's everyday preferred-partners
surface and needs symmetric add/remove without nuking the supplier.

Auth-gated like the rest of /admin/*.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Category, CategorySupplier, Supplier
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/admin/category-suppliers", tags=["admin-category-suppliers"])


class FeatureRequest(BaseModel):
    supplier_id: str
    category_slug: str
    rank: int = 1


@router.post("/feature")
def feature_supplier(
    body: FeatureRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
) -> dict:
    """Upsert (category, supplier) join row with is_featured=True.

    404 if the supplier or category can't be resolved. Returns the join-row
    state on success so the caller can render confirmation without re-fetching.
    """
    try:
        sup_uuid = uuid.UUID(body.supplier_id)
    except (ValueError, TypeError):
        raise HTTPException(404, "Supplier not found")

    supplier = db.query(Supplier).filter(Supplier.id == sup_uuid).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")

    category = db.query(Category).filter(Category.slug == body.category_slug).first()
    if not category:
        raise HTTPException(404, "Category not found")

    existing = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == category.id,
            CategorySupplier.supplier_id == supplier.id,
        )
        .first()
    )
    if existing:
        # SQLAlchemy ORM descriptor assignment — Pyright sees Column[bool]
        # at type level, but runtime intercepts these to emit UPDATE.
        existing.is_featured = True  # type: ignore[assignment]
        existing.rank = body.rank  # type: ignore[assignment]
    else:
        join_row = CategorySupplier(
            category_id=category.id,
            supplier_id=supplier.id,
            is_featured=True,
            rank=body.rank,
        )
        db.add(join_row)

    db.commit()
    return {
        "ok": True,
        "supplier_id": str(supplier.id),
        "category_slug": category.slug,
        "is_featured": True,
        "rank": body.rank,
    }


class UnfeatureRequest(BaseModel):
    supplier_id: str
    category_slug: str


@router.post("/unfeature")
def unfeature_supplier(
    body: UnfeatureRequest,
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
) -> dict:
    """Set `is_featured=False` on the (category, supplier) join row.

    Idempotent — a missing row or an already-unfeatured row returns
    `ok=True` with `is_featured=False`. We do NOT delete the row so a
    non-featured association (the supplier still sells parts in this
    category) is preserved. 404 only if the supplier/category itself
    can't be resolved (mirrors `/feature`).
    """
    try:
        sup_uuid = uuid.UUID(body.supplier_id)
    except (ValueError, TypeError):
        raise HTTPException(404, "Supplier not found")

    supplier = db.query(Supplier).filter(Supplier.id == sup_uuid).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")

    category = db.query(Category).filter(Category.slug == body.category_slug).first()
    if not category:
        raise HTTPException(404, "Category not found")

    existing = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == category.id,
            CategorySupplier.supplier_id == supplier.id,
        )
        .first()
    )
    if existing:
        existing.is_featured = False  # type: ignore[assignment]
        db.commit()

    return {
        "ok": True,
        "supplier_id": str(supplier.id),
        "category_slug": category.slug,
        "is_featured": False,
    }
