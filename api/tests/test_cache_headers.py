"""Cache-Control contract for the category endpoints.

Sponsor/banner data (suppliers, sponsor, featured_supplier_name) is embedded in
the category responses, so they MUST reflect an admin sponsor add/delete
immediately. The endpoints therefore send ``no-cache`` (the browser may store
the body but must revalidate on every use) rather than a ``max-age`` window that
could mask a mutation behind a stale browser-cached copy — the 2026-06-03
stale-banner fix (single-source sponsorship, increment 1).

This locks in NON-cacheability so a future perf pass can't silently re-introduce
``max-age`` and re-open the staleness bug. The check is tolerant of a future
``must-revalidate`` directive or an ETag (increment 2 adds conditional
revalidation): it requires ``no-cache`` to be present and forbids any
positive-TTL ``max-age``.
"""


def _assert_no_cache(response):
    assert response.status_code == 200
    cc = response.headers["cache-control"].lower()
    assert "no-cache" in cc, f"expected revalidate-always, got: {cc!r}"
    assert "max-age" not in cc, f"category responses must not be TTL-cacheable: {cc!r}"


def test_list_categories_cache_header(client, seeded_db):
    _assert_no_cache(client.get("/api/categories/"))


def test_get_category_cache_header(client, seeded_db):
    _assert_no_cache(client.get("/api/categories/clock-and-timing"))
