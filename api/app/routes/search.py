from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.search_service import search

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("/")
def search_endpoint(
    q: str = Query("", min_length=1),
    # 1 (default) computes the zero-result fuzzy recovery; the SearchBar
    # dropdown's debounced calls pass 0 so keystrokes never pay for it.
    suggest: int = Query(1, ge=0, le=1),
    # 1 = the dropdown trim (parts 5 / categories 3 / suppliers 3 / no
    # manufacturers) — same response shape, smaller payload per keystroke.
    compact: int = Query(0, ge=0, le=1),
    db: Session = Depends(get_db),
):
    return search(db, q, suggest=bool(suggest), compact=bool(compact))
