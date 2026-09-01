import math
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import and_, func
from sqlalchemy.orm import Session, aliased

from app.db.session import get_db
from app.models import Category, Part, PartListing

router = APIRouter(tags=["sitemap"])

BASE_URL = "https://circuitcenter.ai"

# Every sitemap document is date-stamped to the day and built from slow-moving
# catalog state, so an hour of staleness costs nothing and spares a crawler hit
# the ranked query below (716ms at 271,821 parts). Deliberately NOT an
# in-process cache: that buys the same hour at the price of an invalidation
# seam on every catalog mutation.
SITEMAP_CACHE_CONTROL = "public, max-age=3600"

# A <urlset> may carry at most 50,000 URLs (sitemaps.org). 45,000 leaves headroom
# so raising PRERENDER_PART_LIMIT adds a page rather than re-breaching the cap —
# the failure mode this whole split exists to fix.
SITEMAP_PARTS_PAGE_SIZE = 45_000

STATIC_PAGES = [
    ("/", "daily", "1.0"),
    ("/about", "monthly", "0.4"),
    # 0.6 (was 0.5): /join absorbed /pricing's audience in the 2026-08-14
    # merge, so it inherits the higher of the two priorities.
    ("/join", "monthly", "0.6"),
    ("/contact", "monthly", "0.4"),
    ("/search", "weekly", "0.6"),
    # /bom is a real indexable tool page; the share views (/bom/s/*) are
    # deliberately absent — they are per-user documents and render noindex.
    ("/bom", "weekly", "0.6"),
    # /pricing merged into /join (2026-08-14) and redirects there — a sitemap
    # entry for a redirecting URL is a crawl-budget leak, not a listing.
    ("/keyword", "weekly", "0.5"),
    ("/privacy", "yearly", "0.2"),
]


def _xml_response(body: str) -> Response:
    return Response(
        content=body,
        media_type="application/xml",
        headers={"Cache-Control": SITEMAP_CACHE_CONTROL},
    )


# ── The index ───────────────────────────────────────────────────────────────
# The children are advertised at their ROOT-relative public URLs, not at the
# /api/ paths that serve them. A sitemap may only list URLs at or below its own
# path, so a document living under /api/ could legally claim nothing but
# /api/* — nginx maps /sitemap-*.xml onto this router for exactly that reason.
@router.get("/api/sitemap.xml", response_class=Response)
def sitemap_index(db: Session = Depends(get_db)):
    today = date.today().isoformat()

    locs = [f"{BASE_URL}/sitemap-core.xml"]
    locs += [f"{BASE_URL}/sitemap-parts-{page}.xml" for page in range(1, _part_page_count(db) + 1)]

    entries = "\n".join(
        f"<sitemap><loc>{loc}</loc><lastmod>{today}</lastmod></sitemap>" for loc in locs
    )
    return _xml_response(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + entries
        + "\n</sitemapindex>"
    )


# ── Static pages + the category taxonomy ────────────────────────────────────
@router.get("/api/sitemap-core.xml", response_class=Response)
def sitemap_core_xml(db: Session = Depends(get_db)):
    today = date.today().isoformat()
    base = BASE_URL

    urls: list[str] = []
    for path, freq, priority in STATIC_PAGES:
        urls.append(
            f"<url><loc>{base}{path}</loc>"
            f"<lastmod>{today}</lastmod>"
            f"<changefreq>{freq}</changefreq>"
            f"<priority>{priority}</priority></url>"
        )

    # Subcategories live at the nested canonical URL /category/{parent}/{child};
    # top-level categories stay flat. Emitting the flat child slug would
    # advertise a URL that only client-side-redirects to the real one
    # (duplicate content + wasted crawl budget). See test_sitemap.py.
    categories = db.query(Category.id, Category.slug, Category.parent_id).all()
    slug_by_id = {cat_id: slug for cat_id, slug, _ in categories}
    # Thin-page guard (2026-08-16 expansion): a category with ZERO parts —
    # its own or any child's — stays OUT of the sitemap until inventory
    # lands. The pages exist and are reachable; we just don't advertise
    # empty shelves to crawlers. Self-heals as the part importer fills them.
    stocked = {
        row[0] for row in db.query(Part.category_id).filter(Part.category_id.isnot(None)).distinct()
    }
    stocked_tops = {
        parent_id
        for cat_id, _slug, parent_id in categories
        if parent_id is not None and cat_id in stocked
    }
    for cat_id, slug, parent_id in categories:
        if parent_id is None:
            if cat_id not in stocked and cat_id not in stocked_tops:
                continue
            loc = f"{base}/category/{slug}"
            priority = "0.8"
        elif cat_id not in stocked:
            continue
        else:
            parent_slug = slug_by_id.get(parent_id)
            # Orphaned child (parent row missing): fall back to the flat URL
            # rather than emit a broken `/category/None/{slug}`.
            loc = (
                f"{base}/category/{parent_slug}/{slug}"
                if parent_slug
                else f"{base}/category/{slug}"
            )
            priority = "0.7"
        urls.append(
            f"<url><loc>{loc}</loc>"
            f"<lastmod>{today}</lastmod>"
            f"<changefreq>weekly</changefreq>"
            f"<priority>{priority}</priority></url>"
        )

    return _xml_response(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + "\n</urlset>"
    )


# ── One page of the prerendered part slice ──────────────────────────────────
@router.get("/api/sitemap-parts-{page}.xml", response_class=Response)
def sitemap_parts_xml(page: int, db: Session = Depends(get_db)):
    if page < 1 or page > _part_page_count(db):
        # A page past the end is not an empty sitemap, it is a URL that does not
        # exist — a 200 there would keep a crawler walking forever.
        raise HTTPException(status_code=404, detail="sitemap page not found")

    today = date.today().isoformat()
    offset = (page - 1) * SITEMAP_PARTS_PAGE_SIZE
    rows = _ranked_parts(
        db,
        limit=min(SITEMAP_PARTS_PAGE_SIZE, PRERENDER_PART_LIMIT - offset),
        offset=offset,
    )

    # Slug over id: the slug IS the manufacturer part number
    # (slugify_sku(sku.lower())), which is what people actually search, whereas
    # a UUID carries no signal at all. The frontend resolves both shapes —
    # api.getPartDetail branches on the UUID grammar — and part pages
    # canonicalize to the slug form, so the slug is the URL to advertise. The
    # ranked query only yields parts that HAVE a slug, for the same reason the
    # prerender does: a slugless part has no prerendered document to point at.
    #
    # Duplicate slugs are expected, not a data error: the same SKU from two
    # manufacturers slugifies identically (CLAUDE.md). Emitting one <loc> twice
    # is a malformed sitemap, so they collapse to a single entry. That entry
    # resolves to whichever row by-slug returns first, which is the same page
    # the canonical already points at — a pre-existing ambiguity this does not
    # widen.
    seen_locs: set[str] = set()
    urls: list[str] = []
    for row in rows:
        loc = f"{BASE_URL}/part/{row.slug}"
        if loc in seen_locs:
            continue
        seen_locs.add(loc)
        urls.append(
            f"<url><loc>{loc}</loc>"
            f"<lastmod>{today}</lastmod>"
            f"<changefreq>weekly</changefreq>"
            f"<priority>0.6</priority></url>"
        )

    body = "\n".join(urls)
    return _xml_response(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + (body + "\n" if body else "")
        + "</urlset>"
    )


def _part_page_count(db: Session) -> int:
    """How many /sitemap-parts-{n}.xml documents exist right now.

    Counted from the same `slug IS NOT NULL` population the ranked query draws
    from, clamped to the prerender cap because the sitemap advertises exactly
    the prerendered set. Always at least one page, so the index never lists a
    child that 404s and an empty catalog still serves a valid (empty) urlset.
    """
    total = db.query(func.count(Part.id)).filter(Part.slug.isnot(None)).scalar() or 0
    return max(1, math.ceil(min(total, PRERENDER_PART_LIMIT) / SITEMAP_PARTS_PAGE_SIZE))


# ── The ranked slice, shared by the prerender and the parts sitemap ─────────
# frontend/scripts/gen-seo-manifest.mjs reads /api/seo/prerender-parts to decide
# WHICH parts get a prerendered HTML document, and /api/sitemap-parts-{n}.xml
# advertises exactly that set. One ranked query, one knob: raise
# PRERENDER_PART_LIMIT and both move together.
#
# That is a REVERSAL of the earlier "the sitemap stays FULL, every part slug is
# advertised" decision (2026-09-01). Two measurements killed it. One <urlset>
# carrying every part was 312,634 URLs on prod — 6.25x the 50,000-URL protocol
# cap, so Google rejected the document whole and the site had, effectively, no
# sitemap at all. And ~95% of those part URLs served the empty SPA shell,
# because only the capped slice below ships static HTML. Advertising a URL
# whose document does not exist spends crawl budget to prove the site is thin.
#
# The cap exists because the prerender writes one file per route and the
# catalog passed 270k parts: uncapped, `npm run build` would emit a multi-GB
# dist/ that no deploy can carry. Parts left out fall back to the SPA shell +
# client-side helmet via nginx try_files, and are simply not advertised.
#
# Ranked so the cap keeps the pages worth having: a part with a product photo
# AND a price renders a real Product page, so those sort first; within that,
# stock descending is the best available proxy for "a buyer can actually get
# this"; newest-first breaks the remaining ties so a fresh import is not
# permanently locked out behind older rows.
#
# Cost is one aggregate over part_listings plus two tiny category joins —
# measured 716ms at 271,821 parts / 358k listings on the local stack. The
# Cache-Control header asks crawlers to reuse the body for an hour, but nothing
# caches server-side — every origin fetch runs the query. Both callers are
# read-only and hard-capped, and each is strictly cheaper than the full-scan
# 312k-URL document this replaced, so leaving them unauthenticated adds no
# exposure the module did not already have.
PRERENDER_PART_LIMIT = 15_000


def _ranked_parts(db: Session, limit: int, offset: int = 0):
    """The ranked part slice, ordered as documented above.

    Pre-aggregated in a subquery rather than GROUP BY on the outer select:
    Postgres' functional-dependency rule would cover the `parts` columns via
    p.id but NOT c.name / c.slug / pc.slug, which would each have to join the
    GROUP BY. This shape leaves the outer query a plain projection and runs
    unchanged on the SQLite test engine.
    """
    stock = (
        db.query(
            PartListing.part_id.label("part_id"),
            func.sum(PartListing.stock_quantity).label("total_stock"),
        )
        .group_by(PartListing.part_id)
        .subquery()
    )
    parent = aliased(Category)

    # Only parts WITH a slug: the prerender keys its output path on the slug,
    # and /part/<uuid> canonicalizes to the slug form anyway.
    return (
        db.query(
            Part.slug,
            Part.sku,
            Part.manufacturer_name,
            Part.description,
            Part.best_price,
            Category.name.label("category_name"),
            Category.slug.label("category_slug"),
            parent.slug.label("parent_category_slug"),
        )
        .outerjoin(stock, stock.c.part_id == Part.id)
        .outerjoin(Category, Category.id == Part.category_id)
        .outerjoin(parent, parent.id == Category.parent_id)
        .filter(Part.slug.isnot(None))
        .order_by(
            and_(Part.image_url.isnot(None), Part.best_price.isnot(None)).desc(),
            func.coalesce(stock.c.total_stock, 0).desc(),
            Part.created_at.desc(),
            # Total order, so LIMIT/OFFSET paging cannot drop or repeat a row
            # when the three ranking terms tie (a bulk import stamps thousands
            # of rows with the same created_at).
            Part.id.desc(),
        )
        .limit(limit)
        .offset(offset)
        .all()
    )


@router.get("/api/seo/prerender-parts")
def prerender_parts(
    limit: int = Query(PRERENDER_PART_LIMIT, ge=1, le=PRERENDER_PART_LIMIT),
    db: Session = Depends(get_db),
):
    rows = _ranked_parts(db, limit=limit)

    return {
        "limit": limit,
        "parts": [
            {
                "slug": r.slug,
                "sku": r.sku,
                "manufacturer_name": r.manufacturer_name,
                "description": r.description,
                # Numeric(10, 4) -> Decimal, which json cannot encode.
                "best_price": float(r.best_price) if r.best_price is not None else None,
                "category_name": r.category_name,
                "category_slug": r.category_slug,
                "parent_category_slug": r.parent_category_slug,
            }
            for r in rows
        ],
    }
