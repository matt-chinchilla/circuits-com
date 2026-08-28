import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas import CategoryDetailResponse, CategoryPartnersResponse, CategoryResponse
from app.services.category_service import (
    DEFAULT_PARTS_PER_PAGE,
    MAX_PARTS_PER_PAGE,
    UnknownSort,
    UnknownSortDirection,
    get_all_categories,
    get_category_by_slug,
    get_category_partners,
)

router = APIRouter(prefix="/api/categories", tags=["categories"])

# Sponsor/banner data (sponsor, featured_supplier_name) is embedded in these
# category responses (the Preferred Partners list moved to the sibling
# /{slug}/partners endpoint, 2026-06-04), so they must reflect an admin sponsor
# add/delete immediately. "no-cache" lets the browser STORE the body but forces
# revalidation on every use, so a stale browser-cached copy can never mask a
# mutation. The service worker (Cache Storage) stays the perf layer and is purged
# on mutation (frontend admin/services/swCache.ts); /partners carries an ETag so
# its forced revalidation is a cheap 304 instead of a full re-fetch.
_CATEGORY_CACHE_CONTROL = "no-cache"


def _conditional_json(request: Request, model, cache_control: str) -> Response:
    """Serialize `model`, attach a strong content-hash ETag + Cache-Control, and
    return 304 (empty body) when the client's If-None-Match matches. The ETag is
    over the EXACT bytes sent (by_alias to match FastAPI's default output) so it
    changes iff the content changes — never serving a stale banner. `no-cache`
    keeps the body revalidatable; the ETag makes that revalidation a cheap 304.
    """
    # sort_keys: keeps the hash stable against schema field-reordering refactors.
    body = json.dumps(jsonable_encoder(model, by_alias=True), sort_keys=True).encode("utf-8")
    etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
    headers = {"Cache-Control": cache_control, "ETag": etag}
    inm = request.headers.get("if-none-match", "")
    if etag in [tag.strip().removeprefix("W/") for tag in inm.split(",")]:
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


@router.get("/", response_model=list[CategoryResponse])
def list_categories(response: Response, db: Session = Depends(get_db)):
    response.headers["Cache-Control"] = _CATEGORY_CACHE_CONTROL
    return get_all_categories(db)


@router.get("/{slug}/partners")
def get_partners(slug: str, request: Request, db: Session = Depends(get_db)):
    # The Preferred Partners banner: a TOP-LEVEL-category artifact (the service
    # resolves a child slug to its parent), split out of the heavy detail
    # response so it's small + cacheable. no-cache + ETag → cheap 304 revalidate.
    result = get_category_partners(db, slug)
    if result is None:
        raise HTTPException(404, "Category not found")
    model = CategoryPartnersResponse(
        slug=result["slug"], name=result["name"], platinum=result["platinum"]
    )
    return _conditional_json(request, model, _CATEGORY_CACHE_CONTROL)


@router.get("/{slug}")
def get_category(
    slug: str,
    request: Request,
    popular_page: int = Query(1, ge=1, alias="popular_page"),
    popular_per_page: int = Query(20, ge=1, le=500, alias="popular_per_page"),
    parts_page: int = Query(1, ge=1, alias="parts_page"),
    # Ceiling 100, enforced HERE as well as in the service. The old 500 was the
    # fetch-everything model's page size, and it is gone with it: the block is
    # filtered, sorted and paged in the database now.
    parts_per_page: int = Query(
        DEFAULT_PARTS_PER_PAGE, ge=1, le=MAX_PARTS_PER_PAGE, alias="parts_per_page"
    ),
    # Free text over sku OR description — the page's one search box matches
    # both. Bounded so an unbounded ILIKE pattern can't be posted at it.
    q: str | None = Query(None, max_length=120),
    # Repeated params. ABSENT is UNFILTERED, never "match nothing".
    mfg: list[str] = Query([]),
    sub: list[str] = Query([]),
    sort: str | None = Query(None),
    # `dir` is a builtin, so the parameter carries it as an alias instead.
    # Absent means "whatever this sort's natural direction is" — asc for the
    # columns, DESC for popular — not a blanket asc.
    direction: str | None = Query(None, alias="dir"),
    db: Session = Depends(get_db),
):
    try:
        result = get_category_by_slug(
            db,
            slug,
            popular_page=popular_page,
            popular_per_page=popular_per_page,
            parts_page=parts_page,
            parts_per_page=parts_per_page,
            q=q,
            manufacturers=mfg,
            subs=sub,
            sort=sort,
            direction=direction,
        )
    except UnknownSort:
        # A named 422 rather than a silent fallback: the page's sort control
        # must never show a state the server did not actually serve. Raised for
        # a typo, and for 'popular'/'sub' asked of a leaf, which has no rollup.
        raise HTTPException(422, "unknown_sort") from None
    except UnknownSortDirection:
        raise HTTPException(422, "unknown_dir") from None
    if not result:
        raise HTTPException(404, "Category not found")
    # Build response that matches CategoryDetailResponse
    cat = result["category"]
    model = CategoryDetailResponse(
        id=cat.id,
        name=cat.name,
        slug=cat.slug,
        icon=cat.icon,
        description=cat.description,
        children=cat.children,
        parent=cat.parent,
        sponsor=result["sponsor"],
        silver=result["silver"],
        parts=result["parts"],
        popular_parts=result["popular_parts"],
        facets=result["facets"],
    )
    # The ETag is a hash of the EXACT bytes sent, so the new query params need
    # no cache bookkeeping of their own: a different filter/sort/page is
    # different content and hashes differently. Cache-Control stays `no-cache`
    # (test_cache_headers.py pins it) — the sponsor data embedded here must
    # still revalidate on every use.
    return _conditional_json(request, model, _CATEGORY_CACHE_CONTROL)
