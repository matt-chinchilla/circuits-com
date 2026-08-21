"""Public derived manufacturers — names + counts, nothing else.

The list is DERIVED from parts.manufacturer_name (search_service §1.4,
600s in-process cache). This module must import nothing from the CRM model
classes — the privacy sweep in the test suite enumerates this router and
greps it, and test_manufacturers_public.py pins the import surface.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.search_service import get_public_manufacturers

router = APIRouter(prefix="/api/manufacturers", tags=["manufacturers"])


@router.get("/")
def list_manufacturers(
    limit: int = Query(60, ge=1, le=200),
    db: Session = Depends(get_db),
):
    # `total` is the FULL derived-list length (free from the cache — the
    # browse drawer's rail pill needs it); only the list is capped.
    data = get_public_manufacturers(db)
    return {"manufacturers": data[:limit], "total": len(data)}
