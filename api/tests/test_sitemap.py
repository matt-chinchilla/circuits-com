"""Tests for the API half of the sitemap — /api/sitemap.xml + /api/sitemap-core.xml.

Three decisions are pinned here.

**The split (2026-09-01).** One <urlset> carrying every part reached 312,634
URLs on prod, 6.25x the 50,000-URL sitemaps.org cap, so Google rejected the
document whole. /sitemap.xml is a <sitemapindex>; children are advertised at
ROOT-relative public URLs because a sitemap may only list URLs at or below its
own path — a child served from /api/ could claim nothing but /api/* — which is
what the nginx mapping exists for.

**Part sitemaps belong to the build (2026-09-22).** /api/sitemap-parts-{n}.xml
re-ran the ranked query on every crawler fetch while the prerendered documents
came from a manifest committed weeks earlier; as the nightly feed moved stock
the two sets drifted, and 35% of sampled advertised part URLs served the
generic shell. The frontend build now writes sitemap.xml + sitemap-parts-{n}.xml
from the very routes it prerenders (frontend/scripts/seoPrerender.test.ts pins
that side), nginx serves them first, and the API keeps only the core child and
a core-only FALLBACK index. The parts route is gone — a 404 — so no fallback
path can ever advertise a live-ranked part again.

The category assertions below predate both (2026-06-03 nested-URL change): a
child lives at the NESTED path `/category/{parent_slug}/{child_slug}`, never the
bare flat child slug, or Google indexes a URL that only redirects.
"""

import re
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

# stdlib ElementTree, not defusedxml: the only documents parsed here are the
# ones these very routes just generated — no DTD, no external entities, and
# nothing user-supplied. Adding a parser dependency to assert that our own
# output is well-formed would buy nothing.
from xml.etree import ElementTree

import pytest

from app.models import Part, PartListing, Supplier
from app.routes import sitemap as sitemap_module
from app.routes.sitemap import PRERENDER_PART_LIMIT

NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"

_BASE = datetime(2026, 1, 1, tzinfo=UTC)


def _locs(xml: str) -> list[str]:
    """Extract every <loc>...</loc> value from a sitemap document."""
    return re.findall(r"<loc>(.*?)</loc>", xml)


def _root(resp) -> ElementTree.Element:
    """Parse a response body as XML and hand back its root element."""
    return ElementTree.fromstring(resp.text)


_DERIVE_SLUG = object()


def _part(db, sku, *, stock=None, image=True, price="1.0000", age_days=0, slug=_DERIVE_SLUG):
    """A part shaped like the ranked slice expects: slug, photo, price, stock.

    `slug=None` really means NULL — hence the sentinel default rather than None.
    """
    part = Part(
        id=uuid.uuid4(),
        sku=sku,
        slug=sku.lower() if slug is _DERIVE_SLUG else slug,
        manufacturer_name="Acme Semiconductor",
        description=f"{sku} description",
        image_url=f"https://cdn.example.test/{sku}.jpg" if image else None,
        best_price=Decimal(price) if price is not None else None,
        created_at=_BASE - timedelta(days=age_days),
        lifecycle_status="active",
    )
    db.add(part)
    db.flush()
    if stock is not None:
        supplier = db.query(Supplier).first()
        if supplier is None:
            supplier = Supplier(id=uuid.uuid4(), name="Acme Distribution")
            db.add(supplier)
            db.flush()
        db.add(
            PartListing(
                id=uuid.uuid4(),
                part_id=part.id,
                supplier_id=supplier.id,
                stock_quantity=stock,
                unit_price=Decimal("1.0000"),
            )
        )
        db.flush()
    return part


# ── The index (the fallback nginx reaches only when the build shipped none) ──


def test_the_index_is_a_sitemapindex_not_a_urlset(client, seeded_db):
    """The whole point of the 2026-09-01 split: /sitemap.xml stopped being one urlset."""
    resp = client.get("/api/sitemap.xml")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/xml")
    assert _root(resp).tag == f"{NS}sitemapindex"


def test_the_fallback_index_names_only_the_core_child(client, db, seeded_db):
    """A build with no sitemap of its own prerendered no parts either.

    So the API's index must not name a parts page even with parts in the DB:
    advertising them is the build's job, because only the build knows which
    documents exist.
    """
    _part(db, "LM7805CT", stock=10)
    db.commit()

    assert _locs(client.get("/api/sitemap.xml").text) == [
        "https://circuitcenter.ai/sitemap-core.xml"
    ]


def test_the_index_carries_no_part_urls_of_its_own(client, seeded_db):
    """A <sitemapindex> may not contain <url> entries at all."""
    root = _root(client.get("/api/sitemap.xml"))
    assert root.findall(f"{NS}url") == []
    assert [child.tag for child in root] == [f"{NS}sitemap"] * len(list(root))


def test_the_live_ranked_parts_sitemap_is_gone(client, db):
    """The drift source: it must stay a 404, not an empty or live-ranked page.

    nginx falls back here when the frontend has no /sitemap-parts-{n}.xml; a
    200 from a live query would re-advertise parts no document exists for.
    """
    _part(db, "LM7805CT", stock=10)
    db.commit()

    for page in (0, 1, 2):
        assert client.get(f"/api/sitemap-parts-{page}.xml").status_code == 404
    assert "SITEMAP_PARTS_PAGE_SIZE" not in vars(sitemap_module)
    assert not [r for r in client.app.routes if "sitemap-parts" in getattr(r, "path", "")]


# ── The core child: static pages + categories ───────────────────────────────


def test_sitemap_core_ok(client, seeded_db):
    resp = client.get("/api/sitemap-core.xml")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/xml")
    assert _root(resp).tag == f"{NS}urlset"


def test_sitemap_core_keeps_the_static_pages(client, seeded_db):
    locs = _locs(client.get("/api/sitemap-core.xml").text)
    assert "https://circuitcenter.ai/" in locs
    assert "https://circuitcenter.ai/join" in locs
    assert "https://circuitcenter.ai/bom" in locs
    assert "https://circuitcenter.ai/viewer" in locs


def test_sitemap_parent_category_is_flat(client, seeded_db):
    """A top-level (parent) category keeps the single-segment URL."""
    xml = client.get("/api/sitemap-core.xml").text
    assert "<loc>https://circuitcenter.ai/category/integrated-circuits</loc>" in xml


def test_sitemap_child_category_is_nested(client, seeded_db):
    """A child category is emitted under its parent: /category/parent/child."""
    xml = client.get("/api/sitemap-core.xml").text
    assert (
        "<loc>https://circuitcenter.ai/category/integrated-circuits/clock-and-timing</loc>" in xml
    ), "child category must be emitted at its nested parent/child path"


def test_sitemap_does_not_emit_flat_child_url(client, seeded_db):
    """The bare flat child URL must NOT appear — it is not the canonical URL.

    `/category/clock-and-timing` only exists as a client-side redirector to the
    nested canonical; emitting it in the sitemap would advertise a redirecting
    URL to crawlers.
    """
    locs = _locs(client.get("/api/sitemap-core.xml").text)
    assert "https://circuitcenter.ai/category/clock-and-timing" not in locs, (
        "flat child URL must not be in the sitemap; only the nested form is canonical"
    )


def test_sitemap_child_has_parent_priority(client, seeded_db):
    """Children stay at priority 0.7, parents at 0.8 (unchanged by the nesting)."""
    xml = client.get("/api/sitemap-core.xml").text
    nested = "<loc>https://circuitcenter.ai/category/integrated-circuits/clock-and-timing</loc>"
    assert nested in xml
    block_start = xml.index(nested)
    block = xml[block_start : block_start + 200]
    assert "<priority>0.7</priority>" in block


def test_an_empty_category_stays_out_of_the_sitemap(client, db, seeded_db):
    """The thin-page guard: don't advertise empty shelves."""
    from app.models import Category

    barren = Category(id=uuid.uuid4(), name="Barren", slug="barren", sort_order=9)
    db.add(barren)
    db.commit()

    locs = _locs(client.get("/api/sitemap-core.xml").text)
    assert "https://circuitcenter.ai/category/barren" not in locs


def test_sitemap_core_carries_no_part_urls(client, db, seeded_db):
    """Parts moved to their own children; leaving them here re-breaches the cap."""
    _part(db, "LM7805CT")
    db.commit()

    assert not [loc for loc in _locs(client.get("/api/sitemap-core.xml").text) if "/part/" in loc]


# ── The prerender slice the build advertises ────────────────────────────────


def test_the_cap_is_the_one_the_module_ships(client):
    """The one knob. Raising it is a measured decision (see the 2026-09-22 report)."""
    assert PRERENDER_PART_LIMIT == 15_000


def test_the_prerender_slice_carries_slugs_not_uuids(client, db):
    """The MPN must be in the URL the build advertises; a UUID carries no signal."""
    _part(db, "LM7805CT", stock=10)
    _part(db, "SLUGLESS", slug=None)
    db.commit()

    slugs = [p["slug"] for p in client.get("/api/seo/prerender-parts").json()["parts"]]
    assert slugs == ["lm7805ct"]


# ── Every document is well-formed and cacheable ─────────────────────────────


@pytest.mark.parametrize(
    ("path", "root_tag"),
    [
        ("/api/sitemap.xml", f"{NS}sitemapindex"),
        ("/api/sitemap-core.xml", f"{NS}urlset"),
    ],
)
def test_every_document_parses_with_the_right_root(client, seeded_db, path, root_tag):
    resp = client.get(path)
    assert resp.status_code == 200
    assert _root(resp).tag == root_tag


@pytest.mark.parametrize(
    "path",
    ["/api/sitemap.xml", "/api/sitemap-core.xml"],
)
def test_every_document_is_cacheable_for_an_hour(client, seeded_db, path):
    """A crawler re-fetches these often and they move on a reseed, not per hour."""
    resp = client.get(path)
    assert resp.headers["cache-control"] == "public, max-age=3600"
