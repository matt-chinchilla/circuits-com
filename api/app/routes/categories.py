from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.schemas import CategoryResponse, CategoryDetailResponse
from app.services.category_service import get_all_categories, get_category_by_slug

router = APIRouter(prefix="/api/categories", tags=["categories"])


@router.get("/", response_model=list[CategoryResponse])
def list_categories(db: Session = Depends(get_db)):
    return get_all_categories(db)


@router.get("/{slug}", response_model=CategoryDetailResponse)
def get_category(
    slug: str,
    popular_page: int = Query(1, ge=1, alias="popular_page"),
    popular_per_page: int = Query(20, ge=1, le=100, alias="popular_per_page"),
    db: Session = Depends(get_db),
):
    result = get_category_by_slug(db, slug, popular_page=popular_page, popular_per_page=popular_per_page)
    if not result:
        raise HTTPException(404, "Category not found")
    # Build response that matches CategoryDetailResponse
    cat = result["category"]
    return CategoryDetailResponse(
        id=cat.id,
        name=cat.name,
        slug=cat.slug,
        icon=cat.icon,
        children=cat.children,
        parent=cat.parent,
        suppliers=result["suppliers"],
        sponsor=result["sponsor"],
        parts=result["parts"],
        popular_parts=result["popular_parts"],
    )
