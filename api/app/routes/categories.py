import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Category
from app.schemas import CategoryDetailResponse, CategoryPartnersResponse, CategoryResponse
from app.services import category_cache
from app.services.category_service import (
    DEFAULT_PARTS_PER_PAGE,
    UnknownSort,
    UnknownSortDirection,
    get_all_categories,
    get_category_by_slug,
    get_category_partners,
)
from app.services.part_pricing import reconcile_total_stock

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


def _serialize(model) -> tuple[bytes, str]:
    """The exact bytes sent and their strong ETag (by_alias to match FastAPI's
    default output; sort_keys keeps the hash stable across field reorders)."""
    body = json.dumps(jsonable_encoder(model, by_alias=True), sort_keys=True).encode("utf-8")
    etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
    return body, etag


def _conditional_json(request: Request, model, cache_control: str) -> Response:
    """Serialize `model`, attach a strong content-hash ETag + Cache-Control, and
    return 304 (empty body) when the client's If-None-Match matches. The ETag is
    over the EXACT bytes sent so it changes iff the content changes — never
    serving a stale banner. `no-cache` keeps the body revalidatable; the ETag
    makes that revalidation a cheap 304.
    """
    body, etag = _serialize(model)
    return _respond(request, body, etag, cache_control)


def _respond(request: Request, body: bytes, etag: str, cache_control: str) -> Response:
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
    # filtered, sorted and paged in the database now. The route still ACCEPTS
    # up to the old 500 and lets the service CLAMP to MAX_PARTS_PER_PAGE
    # rather than 422ing: a tab left open across the deploy runs the previous
    # bundle, which requests parts_per_page=500 on every category navigation —
    # a 422 would hard-error every category page in that tab until a manual
    # refresh (vite:preloadError recovery never fires; nothing 404s).
    parts_per_page: int = Query(DEFAULT_PARTS_PER_PAGE, ge=1, le=500, alias="parts_per_page"),
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
    params = {
        "popular_page": popular_page,
        "popular_per_page": popular_per_page,
        "parts_page": parts_page,
        "parts_per_page": parts_per_page,
        "q": q,
        "manufacturers": mfg,
        "subs": sub,
        "sort": sort,
        "direction": direction,
    }
    # The rendered page is the same for everyone who asks this (slug, query),
    # so the process keeps the bytes it last sent (services/category_cache):
    # fresh → served, stale → served AND rebuilt once in the background,
    # gone → rendered here. Every catalog and sponsor write clears it.
    key = category_cache.key_for(slug, params.items())
    hit = category_cache.get(key)
    if hit is not None and category_cache.is_usable(hit):
        if not category_cache.is_fresh(hit):
            category_cache.refresh(key, hit)
        return _respond(request, hit.body, hit.etag, _CATEGORY_CACHE_CONTROL)

    try:
        rendered = _render_category(db, slug, params)
    except UnknownSort:
        # A named 422 rather than a silent fallback: the page's sort control
        # must never show a state the server did not actually serve. Raised for
        # a typo, and for 'popular'/'sub' asked of a leaf, which has no rollup.
        raise HTTPException(422, "unknown_sort") from None
    except UnknownSortDirection:
        raise HTTPException(422, "unknown_dir") from None
    if rendered is None:
        raise HTTPException(404, "Category not found")
    body, etag = rendered
    category_cache.put(key, body, etag, rebuild=lambda: _rebuild_category(slug, params))
    return _respond(request, body, etag, _CATEGORY_CACHE_CONTROL)


def _render_category(db: Session, slug: str, params: dict) -> tuple[bytes, str] | None:
    """The detail page as bytes + ETag, or None for an unknown slug. Raises the
    service's sort errors — the route names them, the cache never sees them."""
    result = get_category_by_slug(db, slug, **params)
    if not result:
        return None
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
    return _serialize(model)


def _rebuild_category(slug: str, params: dict) -> tuple[bytes, str] | None:
    """A cache refresh, on its own session: the request that noticed the entry
    was stale has already been answered from it."""
    session = category_cache.session_factory()
    try:
        return _render_category(session, slug, params)
    except (UnknownSort, UnknownSortDirection):
        return None
    finally:
        session.close()


# The canonical first page — the query index.html's preload fetches, so it is
# the entry every visitor lands on (categoryQuery.ts CANONICAL_CATEGORY_QUERY).
CANONICAL_PARAMS: dict = {
    "popular_page": 1,
    "popular_per_page": 1,
    "parts_page": 1,
    "parts_per_page": DEFAULT_PARTS_PER_PAGE,
    "q": None,
    "manufacturers": [],
    "subs": [],
    "sort": None,
    "direction": None,
}


def warm_category_cache() -> int:
    """Render every category's canonical first page into the cache — parents
    first, since they are the expensive ones — after reconciling the stock
    column the popular ordering sorts on. Returns the number of pages warmed.
    Run by the warmer thread (main.py) at startup and on an interval."""
    session = category_cache.session_factory()
    try:
        reconcile_total_stock(session)
        session.commit()
        slugs = [
            row[0]
            for row in session.query(Category.slug)
            .order_by(Category.parent_id.isnot(None), Category.sort_order, Category.slug)
            .all()
        ]
        warmed = 0
        for slug in slugs:
            rendered = _render_category(session, slug, CANONICAL_PARAMS)
            if rendered is None:
                continue
            key = category_cache.key_for(slug, CANONICAL_PARAMS.items())
            params = dict(CANONICAL_PARAMS)
            category_cache.put(
                key,
                rendered[0],
                rendered[1],
                rebuild=lambda p=params, sl=slug: _rebuild_category(sl, p),
            )
            warmed += 1
        return warmed
    finally:
        session.close()
