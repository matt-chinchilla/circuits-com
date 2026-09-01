"""Tests for the sitemap — an INDEX at /api/sitemap.xml plus its children.

Two decisions are pinned here.

**The split (2026-09-01).** One <urlset> carrying every part reached 312,634
URLs on prod, 6.25x the 50,000-URL sitemaps.org cap, so Google rejected the
document whole. /api/sitemap.xml is now a <sitemapindex> naming
/sitemap-core.xml (static pages + categories) and /sitemap-parts-{n}.xml. The
children are advertised at ROOT-relative public URLs because a sitemap may only
list URLs at or below its own path — a child served from /api/ could claim
nothing but /api/* — which is what the nginx rewrite exists for.

**The parts sitemap advertises exactly the prerendered set.** ~95% of the old
part URLs served the empty SPA shell, since only the capped, ranked slice from
/api/seo/prerender-parts ships static HTML. Both now read one shared query, so
there is one knob (PRERENDER_PART_LIMIT) rather than two that can disagree.

The category assertions below predate the split (2026-06-03 nested-URL change)
and are ported verbatim onto the core child: children live at the NESTED path
`/category/{parent_slug}/{child_slug}`, never the bare flat child slug, or
Google indexes a URL that only redirects to the real one.
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
from app.routes.sitemap import PRERENDER_PART_LIMIT, SITEMAP_PARTS_PAGE_SIZE

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


# ── The index ───────────────────────────────────────────────────────────────


def test_the_index_is_a_sitemapindex_not_a_urlset(client, seeded_db):
    """The whole point of the change: /sitemap.xml stopped being one urlset."""
    resp = client.get("/api/sitemap.xml")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/xml")
    assert _root(resp).tag == f"{NS}sitemapindex"


def test_the_index_names_both_children_at_their_public_urls(client, seeded_db):
    """Root-relative locs — a child under /api/ could only claim /api/* URLs."""
    locs = _locs(client.get("/api/sitemap.xml").text)
    assert "https://circuitcenter.ai/sitemap-core.xml" in locs
    assert "https://circuitcenter.ai/sitemap-parts-1.xml" in locs
    assert not [loc for loc in locs if "/api/" in loc], (
        "the index must advertise the public URLs nginx maps, not the /api/ paths"
    )


def test_the_index_carries_no_part_urls_of_its_own(client, seeded_db):
    """A <sitemapindex> may not contain <url> entries at all."""
    root = _root(client.get("/api/sitemap.xml"))
    assert root.findall(f"{NS}url") == []
    assert [child.tag for child in root] == [f"{NS}sitemap"] * len(list(root))


def test_the_index_lists_one_parts_page_per_page_that_exists(client, db, monkeypatch):
    """Growth adds a child rather than overflowing one."""
    for i in range(5):
        _part(db, f"PART{i}")
    db.commit()
    monkeypatch.setattr(sitemap_module, "SITEMAP_PARTS_PAGE_SIZE", 2)

    locs = _locs(client.get("/api/sitemap.xml").text)
    parts_locs = [loc for loc in locs if "sitemap-parts" in loc]
    assert parts_locs == [
        "https://circuitcenter.ai/sitemap-parts-1.xml",
        "https://circuitcenter.ai/sitemap-parts-2.xml",
        "https://circuitcenter.ai/sitemap-parts-3.xml",
    ]


def test_an_empty_catalog_still_advertises_one_parts_page(client, db):
    """Page 1 always exists, so the index never names a child that 404s."""
    locs = _locs(client.get("/api/sitemap.xml").text)
    assert "https://circuitcenter.ai/sitemap-parts-1.xml" in locs
    assert client.get("/api/sitemap-parts-1.xml").status_code == 200


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


# ── The parts children ──────────────────────────────────────────────────────


def test_the_page_size_leaves_headroom_under_the_protocol_cap(client):
    """45,000 < 50,000: growth adds a page instead of invalidating the file."""
    assert SITEMAP_PARTS_PAGE_SIZE == 45_000
    assert SITEMAP_PARTS_PAGE_SIZE < 50_000


def test_part_urls_use_the_slug_not_the_uuid(client, db):
    """The MPN must be in the URL; a UUID carries no search signal."""
    _part(db, "LM7805CT")
    db.commit()

    locs = _locs(client.get("/api/sitemap-parts-1.xml").text)
    assert "https://circuitcenter.ai/part/lm7805ct" in locs
    uuid_shaped = [
        loc
        for loc in locs
        if re.search(r"/part/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", loc)
    ]
    assert not uuid_shaped, "the slug is being ignored for parts that have one"


def test_part_entries_keep_their_lastmod_changefreq_and_priority(client, db):
    _part(db, "LM7805CT")
    db.commit()

    xml = client.get("/api/sitemap-parts-1.xml").text
    block = xml[xml.index("<loc>https://circuitcenter.ai/part/lm7805ct</loc>") :][:220]
    assert "<changefreq>weekly</changefreq>" in block
    assert "<priority>0.6</priority>" in block
    assert re.search(r"<lastmod>\d{4}-\d{2}-\d{2}</lastmod>", block)


def test_part_urls_are_unique(client, db):
    """Duplicate <loc> is a malformed sitemap.

    Two manufacturers shipping the same SKU slugify identically (CLAUDE.md), so
    collisions are expected data, not corruption — they must collapse to one
    entry rather than being emitted twice.
    """
    _part(db, "LM7805CT")
    twin = _part(db, "LM7805CT-B")
    twin.slug = "lm7805ct"
    db.commit()

    part_locs = [
        loc for loc in _locs(client.get("/api/sitemap-parts-1.xml").text) if "/part/" in loc
    ]
    dupes = {loc for loc in part_locs if part_locs.count(loc) > 1}
    assert not dupes, f"duplicate part <loc> entries: {sorted(dupes)[:5]}"
    assert part_locs.count("https://circuitcenter.ai/part/lm7805ct") == 1


def test_a_slugless_part_is_not_advertised(client, db):
    """It has no prerendered document, so advertising it advertises the shell.

    This REPLACES the old id-fallback behaviour: the sitemap used to emit
    /part/{uuid} for a slugless part, which is exactly the class of URL the
    audit found serving an empty SPA shell.
    """
    _part(db, "SLUGLESS", slug=None)
    _part(db, "REAL")
    db.commit()

    locs = _locs(client.get("/api/sitemap-parts-1.xml").text)
    assert locs == ["https://circuitcenter.ai/part/real"]


def test_the_parts_page_emits_only_the_ranked_slice(client, db, monkeypatch):
    """Same ranking as the prerender: featured first, then stock, then recency."""
    # Stock is lopsided on purpose: drop the featured term from the shared
    # ranking and DEEP wins on stock alone, so this test moves with it.
    _part(db, "SPARSE", stock=1, image=True, price="2.5000")
    _part(db, "DEEP", stock=9_000_000, image=False, price=None)
    db.commit()
    monkeypatch.setattr(sitemap_module, "PRERENDER_PART_LIMIT", 1)

    locs = _locs(client.get("/api/sitemap-parts-1.xml").text)
    assert locs == ["https://circuitcenter.ai/part/sparse"], (
        "the sitemap must advertise the TOP of the same ranking the prerender uses"
    )


def test_the_sitemap_and_the_prerender_advertise_the_same_set(client, db):
    """One knob, one query — the two must never disagree about which parts."""
    for i in range(4):
        _part(db, f"PART{i}")
    db.commit()

    prerendered = [p["slug"] for p in client.get("/api/seo/prerender-parts").json()["parts"]]
    sitemapped = [
        loc.rsplit("/", 1)[-1] for loc in _locs(client.get("/api/sitemap-parts-1.xml").text)
    ]
    assert sitemapped == prerendered


def test_the_page_size_bounds_one_document(client, db, monkeypatch):
    """A page carries at most SITEMAP_PARTS_PAGE_SIZE entries."""
    for i in range(5):
        _part(db, f"PART{i}")
    db.commit()
    monkeypatch.setattr(sitemap_module, "SITEMAP_PARTS_PAGE_SIZE", 2)

    assert len(_locs(client.get("/api/sitemap-parts-1.xml").text)) == 2
    assert len(_locs(client.get("/api/sitemap-parts-2.xml").text)) == 2
    assert len(_locs(client.get("/api/sitemap-parts-3.xml").text)) == 1


def test_the_pages_partition_the_slice_without_gaps_or_repeats(client, db, monkeypatch):
    """Paging must be a partition — an unstable ORDER BY would drop rows."""
    for i in range(5):
        _part(db, f"PART{i}")
    db.commit()
    monkeypatch.setattr(sitemap_module, "SITEMAP_PARTS_PAGE_SIZE", 2)

    paged = [
        loc
        for page in (1, 2, 3)
        for loc in _locs(client.get(f"/api/sitemap-parts-{page}.xml").text)
    ]
    assert len(paged) == len(set(paged)) == 5


def test_a_page_past_the_last_one_is_a_404(client, db):
    _part(db, "ONLY")
    db.commit()

    assert client.get("/api/sitemap-parts-1.xml").status_code == 200
    assert client.get("/api/sitemap-parts-2.xml").status_code == 404
    assert client.get("/api/sitemap-parts-0.xml").status_code == 404


def test_the_cap_is_the_ceiling_on_what_is_advertised(client, db, monkeypatch):
    """The sitemap never advertises past the prerendered set."""
    for i in range(4):
        _part(db, f"PART{i}")
    db.commit()
    monkeypatch.setattr(sitemap_module, "PRERENDER_PART_LIMIT", 2)
    monkeypatch.setattr(sitemap_module, "SITEMAP_PARTS_PAGE_SIZE", 1)

    assert len(_locs(client.get("/api/sitemap-parts-1.xml").text)) == 1
    assert len(_locs(client.get("/api/sitemap-parts-2.xml").text)) == 1
    assert client.get("/api/sitemap-parts-3.xml").status_code == 404


def test_the_cap_the_sitemap_pages_against_is_the_prerender_cap(client):
    """Sanity: the two constants are the ones the module actually ships."""
    assert PRERENDER_PART_LIMIT == 15_000


# ── Every document is well-formed and cacheable ─────────────────────────────


@pytest.mark.parametrize(
    ("path", "root_tag"),
    [
        ("/api/sitemap.xml", f"{NS}sitemapindex"),
        ("/api/sitemap-core.xml", f"{NS}urlset"),
        ("/api/sitemap-parts-1.xml", f"{NS}urlset"),
    ],
)
def test_every_document_parses_with_the_right_root(client, seeded_db, path, root_tag):
    resp = client.get(path)
    assert resp.status_code == 200
    assert _root(resp).tag == root_tag


@pytest.mark.parametrize(
    "path",
    ["/api/sitemap.xml", "/api/sitemap-core.xml", "/api/sitemap-parts-1.xml"],
)
def test_every_document_is_cacheable_for_an_hour(client, seeded_db, path):
    """The ranked query measured 716ms at 271k parts; a crawler hits these often."""
    resp = client.get(path)
    assert resp.headers["cache-control"] == "public, max-age=3600"
