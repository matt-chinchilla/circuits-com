from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas import CategoryDetailResponse, CategoryResponse
from app.services.category_service import get_all_categories, get_category_by_slug

router = APIRouter(prefix="/api/categories", tags=["categories"])


@router.get("/", response_model=list[CategoryResponse])
def list_categories(response: Response, db: Session = Depends(get_db)):
    response.headers["Cache-Control"] = "public, max-age=60"
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
        db,
        slug,
        popular_page=popular_page,
        popular_per_page=popular_per_page,
        parts_page=parts_page,
        parts_per_page=parts_per_page,
    )
    if not result:
        raise HTTPException(404, "Category not found")
    response.headers["Cache-Control"] = "public, max-age=60"
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
        top_sponsors=result["top_sponsors"],
        parts=result["parts"],
        popular_parts=result["popular_parts"],
    )
