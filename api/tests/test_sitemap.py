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
    assert "<loc>https://circuits.com/category/integrated-circuits</loc>" in xml


def test_sitemap_child_category_is_nested(client, seeded_db):
    """A child category is emitted under its parent: /category/parent/child.

    Fails before the fix — sitemap.py emits the flat `/category/{slug}` for
    every category regardless of depth.
    """
    xml = client.get("/api/sitemap.xml").text
    assert (
        "<loc>https://circuits.com/category/integrated-circuits/clock-and-timing</loc>"
        in xml
    ), "child category must be emitted at its nested parent/child path"


def test_sitemap_does_not_emit_flat_child_url(client, seeded_db):
    """The bare flat child URL must NOT appear — it is not the canonical URL.

    `/category/clock-and-timing` only exists as a client-side redirector to the
    nested canonical; emitting it in the sitemap would advertise a redirecting
    URL to crawlers.
    """
    locs = _locs(client.get("/api/sitemap.xml").text)
    assert "https://circuits.com/category/clock-and-timing" not in locs, (
        "flat child URL must not be in the sitemap; only the nested form is canonical"
    )


def test_sitemap_child_has_parent_priority(client, seeded_db):
    """Children stay at priority 0.7, parents at 0.8 (unchanged by the nesting)."""
    xml = client.get("/api/sitemap.xml").text
    # The nested child <url> block carries priority 0.7
    nested = (
        "<loc>https://circuits.com/category/integrated-circuits/clock-and-timing</loc>"
    )
    assert nested in xml
    block_start = xml.index(nested)
    block = xml[block_start : block_start + 200]
    assert "<priority>0.7</priority>" in block
