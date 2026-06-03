from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas import CategoryDetailResponse, CategoryResponse
from app.services.category_service import get_all_categories, get_category_by_slug

router = APIRouter(prefix="/api/categories", tags=["categories"])

# Sponsor/banner data (suppliers, sponsor, featured_supplier_name) is embedded in
# these category responses, so they must reflect an admin sponsor add/delete
# immediately. "no-cache" lets the browser STORE the body but forces revalidation
# on every use, so a stale browser-cached copy can never mask a mutation. The
# service worker (Cache Storage) stays the perf layer and is purged on mutation
# (frontend admin/services/sponsorStore.ts); an ETag (next increment) will make
# the forced revalidation a cheap 304 instead of a full re-fetch.
_CATEGORY_CACHE_CONTROL = "no-cache"


@router.get("/", response_model=list[CategoryResponse])
def list_categories(response: Response, db: Session = Depends(get_db)):
    response.headers["Cache-Control"] = _CATEGORY_CACHE_CONTROL
    return get_all_categories(db)


@router.get("/{slug}", response_model=CategoryDetailResponse)
def get_category(
    slug: str,
    response: Response,
    popular_page: int = Query(1, ge=1, alias="popular_page"),
    popular_per_page: int = Query(20, ge=1, le=500, alias="popular_per_page"),
    parts_page: int = Query(1, ge=1, alias="parts_page"),
    parts_per_page: int = Query(20, ge=1, le=500, alias="parts_per_page"),
    db: Session = Depends(get_db),
):
    result = get_category_by_slug(
        db, slug,
        popular_page=popular_page, popular_per_page=popular_per_page,
        parts_page=parts_page, parts_per_page=parts_per_page,
    )
    if not result:
        raise HTTPException(404, "Category not found")
    response.headers["Cache-Control"] = _CATEGORY_CACHE_CONTROL
    # Build response that matches CategoryDetailResponse
    cat = result["category"]
    return CategoryDetailResponse(
        id=cat.id,
        name=cat.name,
        slug=cat.slug,
        icon=cat.icon,
        description=cat.description,
        children=cat.children,
        parent=cat.parent,
        suppliers=result["suppliers"],
        sponsor=result["sponsor"],
        parts=result["parts"],
        popular_parts=result["popular_parts"],
    )
