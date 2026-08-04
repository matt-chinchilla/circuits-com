"""Tests for GET /api/sitemap.xml.

Regression guard for the 2026-06-03 nested-category-URL change: child
categories live at the NESTED path `/category/{parent_slug}/{child_slug}` (the
real, reachable, canonical URL). The sitemap must emit that nested form for
children and the flat form for top-level parents — never the bare flat child
slug, or Google indexes a URL that only 301s/redirects to the real one
(duplicate-content + crawl-budget waste).
"""


def _locs(xml: str) -> list[str]:
    """Extract every <loc>...</loc> value from the sitemap XML."""
    import re

    return re.findall(r"<loc>(.*?)</loc>", xml)


def test_sitemap_ok(client, seeded_db):
    resp = client.get("/api/sitemap.xml")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/xml")


def test_sitemap_parent_category_is_flat(client, seeded_db):
    """A top-level (parent) category keeps the single-segment URL."""
    xml = client.get("/api/sitemap.xml").text
    assert "<loc>https://circuitcenter.ai/category/integrated-circuits</loc>" in xml


def test_sitemap_child_category_is_nested(client, seeded_db):
    """A child category is emitted under its parent: /category/parent/child.

    Fails before the fix — sitemap.py emits the flat `/category/{slug}` for
    every category regardless of depth.
    """
    xml = client.get("/api/sitemap.xml").text
    assert (
        "<loc>https://circuitcenter.ai/category/integrated-circuits/clock-and-timing</loc>"
        in xml
    ), "child category must be emitted at its nested parent/child path"


def test_sitemap_does_not_emit_flat_child_url(client, seeded_db):
    """The bare flat child URL must NOT appear — it is not the canonical URL.

    `/category/clock-and-timing` only exists as a client-side redirector to the
    nested canonical; emitting it in the sitemap would advertise a redirecting
    URL to crawlers.
    """
    locs = _locs(client.get("/api/sitemap.xml").text)
    assert "https://circuitcenter.ai/category/clock-and-timing" not in locs, (
        "flat child URL must not be in the sitemap; only the nested form is canonical"
    )


def test_sitemap_child_has_parent_priority(client, seeded_db):
    """Children stay at priority 0.7, parents at 0.8 (unchanged by the nesting)."""
    xml = client.get("/api/sitemap.xml").text
    # The nested child <url> block carries priority 0.7
    nested = (
        "<loc>https://circuitcenter.ai/category/integrated-circuits/clock-and-timing</loc>"
    )
    assert nested in xml
    block_start = xml.index(nested)
    block = xml[block_start : block_start + 200]
    assert "<priority>0.7</priority>" in block


# ── Part URLs carry the MPN, not a UUID (2026-08-03) ──────────────────────
# The sitemap advertised /part/<uuid> for ~3,600 parts, discarding the one
# thing in the URL a person might search: the manufacturer part number, which
# IS the slug. These guard the switch to slugs and the two data realities that
# make it non-trivial — nullable slugs and slugs shared by more than one part.


def test_part_urls_use_the_slug_not_the_uuid(client, seeded_db):
    """The MPN must be in the URL; a UUID carries no search signal."""
    from app.models import Part

    db = seeded_db["db"] if isinstance(seeded_db, dict) and "db" in seeded_db else None
    xml = client.get("/api/sitemap.xml").text
    locs = _locs(xml)
    part_locs = [loc for loc in locs if "/part/" in loc]
    assert part_locs, "sitemap emitted no part URLs at all"

    uuid_shaped = [
        loc
        for loc in part_locs
        if __import__("re").search(
            r"/part/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            loc,
        )
    ]
    # A UUID is only acceptable as the fallback for a part with no slug.
    if db is not None:
        slugless = db.query(Part).filter((Part.slug.is_(None)) | (Part.slug == "")).count()
        assert len(uuid_shaped) <= slugless, (
            f"{len(uuid_shaped)} UUID part URLs but only {slugless} parts lack a slug — "
            "the slug is being ignored for parts that have one"
        )


def test_part_urls_are_unique(client, seeded_db):
    """Duplicate <loc> is a malformed sitemap.

    Two manufacturers shipping the same SKU slugify identically (CLAUDE.md), so
    collisions are expected data, not corruption — they must collapse to one
    entry rather than being emitted twice.
    """
    part_locs = [loc for loc in _locs(client.get("/api/sitemap.xml").text) if "/part/" in loc]
    dupes = {loc for loc in part_locs if part_locs.count(loc) > 1}
    assert not dupes, f"duplicate part <loc> entries: {sorted(dupes)[:5]}"


def test_slugless_part_still_appears(client, seeded_db, db):
    """An ugly URL still indexes; a missing one cannot."""
    from app.models import Part

    orphan = db.query(Part).first()
    assert orphan is not None
    orphan.slug = None
    db.commit()

    locs = _locs(client.get("/api/sitemap.xml").text)
    assert f"https://circuitcenter.ai/part/{orphan.id}" in locs, (
        "a part with no slug was dropped from the sitemap entirely"
    )
