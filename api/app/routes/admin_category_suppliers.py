"""Admin endpoint for featured-supplier toggling on categories.

Used by the guided-tour wizard so a newly-created demo supplier appears in
the Featured Supplier slot on a public category page — proves to the
admin user that data they enter propagates to the live site immediately.

Upserts a CategorySupplier row. is_featured=True + rank wins among
candidates per category (category_service picks lowest rank by DESC order
+ dict-last-write). Auth-gated like the rest of /admin/*.

This endpoint is feature-ONLY by design — there's no "unfeature" variant
because the wizard's cleanup path (delete the demo supplier) cascades the
CategorySupplier row away naturally. A standalone unfeature endpoint
would create a new state-management surface we don't need yet.
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
