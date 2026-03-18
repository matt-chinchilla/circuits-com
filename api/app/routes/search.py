from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.schemas import CategoryResponse, SupplierResponse
from app.services.search_service import search

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("/")
def search_endpoint(q: str = Query("", min_length=1), db: Session = Depends(get_db)):
    results = search(db, q)
    return {
        "categories": [CategoryResponse.model_validate(c) for c in results["categories"]],
        "suppliers": [SupplierResponse.model_validate(s) for s in results["suppliers"]],
    }
