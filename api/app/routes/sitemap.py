from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import and_, func
from sqlalchemy.orm import Session, aliased

from app.db.session import get_db
from app.models import Category, Part, PartListing

router = APIRouter(tags=["sitemap"])

BASE_URL = "https://circuitcenter.ai"

# Both documents are date-stamped to the day and built from slow-moving
# catalog state, so an hour of staleness costs nothing. Deliberately NOT an
# in-process cache: that buys the same hour at the price of an invalidation
# seam on every catalog mutation.
SITEMAP_CACHE_CONTROL = "public, max-age=3600"

# The PART sitemaps are not rendered here any more (2026-09-22). The frontend
# build writes sitemap.xml + sitemap-parts-{n}.xml beside the prerendered part
# documents (frontend/scripts/seoPrerender.ts), from the same route list, and
# nginx serves those files ahead of this router. This module used to page the
# ranked query below on every crawler fetch (~9s on prod at 757k parts) while
# the documents came from the manifest committed weeks earlier; the feed moves
# stock nightly, so the two sets drifted and on 2026-09-21 21 of 60 sampled
# advertised part URLs (35%) served the generic shell. Only the build knows
# which documents exist, so only the build may advertise them.

STATIC_PAGES = [
    ("/", "daily", "1.0"),
    ("/about", "monthly", "0.4"),
    # 0.6 (was 0.5): /join absorbed /pricing's audience in the 2026-08-14
    # merge, so it inherits the higher of the two priorities.
    ("/join", "monthly", "0.6"),
    ("/contact", "monthly", "0.4"),
    ("/search", "weekly", "0.6"),
    # /pricing merged into /join (2026-08-14) and redirects there — a sitemap
    # entry for a redirecting URL is a crawl-budget leak, not a listing. This
    # explains the ABSENCE above it, not the entry below.
    #
    # /bom is a real indexable tool page; the share views (/bom/s/*) are
    # deliberately absent — they are per-user documents and render noindex.
    ("/bom", "weekly", "0.6"),
    # /viewer opens a KiCad project in the browser and prices its BOM — a real
    # indexable tool page, the same weight as /bom.
    ("/viewer", "weekly", "0.6"),
    ("/keyword", "weekly", "0.5"),
    ("/privacy", "yearly", "0.2"),
]


def _xml_response(body: str) -> Response:
    return Response(
        content=body,
        media_type="application/xml",
        headers={"Cache-Control": SITEMAP_CACHE_CONTROL},
    )


# ── The index (fallback only) ───────────────────────────────────────────────
# nginx serves the frontend-built index first; this one answers only when the
# frontend has none (a build that skipped the prerender). Such a build wrote no
# part documents either, so the only honest child to name is the core one —
# naming a parts page here would re-open exactly the drift this split closed.
#
# The child is advertised at its ROOT-relative public URL, not at the /api/
# path that serves it. A sitemap may only list URLs at or below its own path,
# so a document living under /api/ could legally claim nothing but /api/* —
# nginx maps /sitemap-core.xml onto this router for exactly that reason.
@router.get("/api/sitemap.xml", response_class=Response)
def sitemap_index():
    today = date.today().isoformat()
    return _xml_response(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"<sitemap><loc>{BASE_URL}/sitemap-core.xml</loc><lastmod>{today}</lastmod></sitemap>"
        "\n</sitemapindex>"
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


# ── The ranked slice the prerender reads ────────────────────────────────────
# frontend/scripts/gen-seo-manifest.mjs reads /api/seo/prerender-parts to decide
# WHICH parts get a prerendered HTML document; the build then advertises
# exactly the documents it wrote (see the note at the top of this module). One
# knob: raise PRERENDER_PART_LIMIT, regenerate the manifest, rebuild — and the
# documents and the sitemap move together.
#
# The slice is capped at all because a sitemap carrying every part was 312,634
# URLs on prod (2026-09-01) — 6.25x the 50,000-URL protocol cap, so Google
# rejected the document whole — and ~95% of those URLs served the empty SPA
# shell, since only this capped slice ships static HTML. Advertising a URL
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
# 716ms at 271,821 parts locally, ~11s at 757k on prod (2026-09-22). That is
# paid once per manifest regen now, not once per crawler fetch. Read-only and
# hard-capped, so it stays unauthenticated: gating it would put a bearer token
# in the manifest-regen CLI, and it advertises only URLs that are public.
PRERENDER_PART_LIMIT = 15_000


def _ranked_parts(db: Session, limit: int):
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
            # Total order, so the cap keeps the same rows from one regen to the
            # next when the three ranking terms tie (a bulk import stamps
            # thousands of rows with the same created_at).
            Part.id.desc(),
        )
        .limit(limit)
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
