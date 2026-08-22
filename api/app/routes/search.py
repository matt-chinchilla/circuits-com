from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.search_service import MAX_QUERY_LENGTH, search

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("/")
def search_endpoint(
    # max_length is a DoS bound, not tidiness: the zero-result fuzzy recovery
    # runs a python Levenshtein against every vocabulary term, so its cost
    # scales with len(q) — an unbounded `q` on this unauthenticated GET burned
    # ~21s of CPU per request at 1600 chars. Over the bound is a 422, which
    # costs nothing. MAX_QUERY_LENGTH lives in search_service, the one home
    # shared with the service-level truncation.
    q: str = Query("", min_length=1, max_length=MAX_QUERY_LENGTH),
    # 1 (default) computes the zero-result fuzzy recovery; the SearchBar
    # dropdown's debounced calls pass 0 so keystrokes never pay for it.
    suggest: int = Query(1, ge=0, le=1),
    # 1 = the dropdown trim (parts 5 / categories 3 / suppliers 3 / no
    # manufacturers) — same response shape, smaller payload per keystroke.
    compact: int = Query(0, ge=0, le=1),
    db: Session = Depends(get_db),
):
    return search(db, q, suggest=bool(suggest), compact=bool(compact))
