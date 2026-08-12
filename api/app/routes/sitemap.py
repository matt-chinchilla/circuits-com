from datetime import date

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Category, Part

router = APIRouter(tags=["sitemap"])

STATIC_PAGES = [
    ("/", "daily", "1.0"),
    ("/about", "monthly", "0.4"),
    ("/join", "monthly", "0.5"),
    ("/contact", "monthly", "0.4"),
    ("/search", "weekly", "0.6"),
    ("/pricing", "monthly", "0.6"),
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
    for _cat_id, slug, parent_id in categories:
        if parent_id is None:
            loc = f"{base}/category/{slug}"
            priority = "0.8"
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
