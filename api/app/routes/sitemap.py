from datetime import date

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import and_, func
from sqlalchemy.orm import Session, aliased

from app.db.session import get_db
from app.models import Category, Part, PartListing

router = APIRouter(tags=["sitemap"])

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


@router.get("/api/sitemap.xml", response_class=Response)
def sitemap_xml(db: Session = Depends(get_db)):
    today = date.today().isoformat()
    base = "https://circuitcenter.ai"

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

    # Slug over id: the slug IS the manufacturer part number
    # (slugify_sku(sku.lower())), which is what people actually search, whereas
    # a UUID carries no signal at all. The frontend resolves both shapes —
    # api.getPartDetail branches on the UUID grammar — and part pages
    # canonicalize to the slug form, so the slug is the URL to advertise.
    #
    # Duplicate slugs are expected, not a data error: the same SKU from two
    # manufacturers slugifies identically (CLAUDE.md). Emitting one <loc> twice
    # is a malformed sitemap, so they collapse to a single entry. That entry
    # resolves to whichever row by-slug returns first, which is the same page
    # the canonical already points at — a pre-existing ambiguity this does not
    # widen. Parts with no slug fall back to the id: an ugly URL still indexes,
    # a missing one cannot.
    seen_locs: set[str] = set()
    for part_id, slug in db.query(Part.id, Part.slug).all():
        loc = f"{base}/part/{slug or part_id}"
        if loc in seen_locs:
            continue
        seen_locs.add(loc)
        urls.append(
            f"<url><loc>{loc}</loc>"
            f"<lastmod>{today}</lastmod>"
            f"<changefreq>weekly</changefreq>"
            f"<priority>0.6</priority></url>"
        )

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + "\n</urlset>"
    )

    return Response(content=xml, media_type="application/xml")


# ── The build-time prerender's part slice ───────────────────────────────────
# frontend/scripts/gen-seo-manifest.mjs calls this to decide WHICH parts get a
# prerendered HTML document. The sitemap above stays FULL — every part slug is
# advertised to crawlers either way; this only bounds how many of them ship as
# static files in dist/.
#
# The cap exists because the prerender writes one file per route and the
# catalog passed 270k parts: uncapped, `npm run build` would emit a multi-GB
# dist/ that no deploy can carry. Parts left out fall back to the SPA shell +
# client-side helmet via nginx try_files, which is already what every part
# added since the last manifest regen does.
#
# Ranked so the cap keeps the pages worth having: a part with a product photo
# AND a price renders a real Product page, so those sort first; within that,
# stock descending is the best available proxy for "a buyer can actually get
# this"; newest-first breaks the remaining ties so a fresh import is not
# permanently locked out behind older rows.
#
# Cost is one aggregate over part_listings plus two tiny category joins —
# measured 716ms at 271,821 parts / 358k listings on the local stack. That is
# strictly cheaper than the sitemap route above it, which scans every part row
# and builds a ~20MB XML body, so leaving this unauthenticated adds no exposure
# the module did not already have. It stays read-only and hard-capped.
PRERENDER_PART_LIMIT = 15_000


@router.get("/api/seo/prerender-parts")
def prerender_parts(
    limit: int = Query(PRERENDER_PART_LIMIT, ge=1, le=PRERENDER_PART_LIMIT),
    db: Session = Depends(get_db),
):
    # Pre-aggregated in a subquery rather than GROUP BY on the outer select:
    # Postgres' functional-dependency rule would cover the `parts` columns via
    # p.id but NOT c.name / c.slug / pc.slug, which would each have to join the
    # GROUP BY. This shape leaves the outer query a plain projection and runs
    # unchanged on the SQLite test engine.
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
    rows = (
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
        )
        .limit(limit)
        .all()
    )

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
