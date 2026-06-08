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


def test_get_partners_cache_header(client, seeded_db):
    # The Preferred-Partners banner endpoint must also stay non-cacheable, and —
    # unlike the list/detail routes — it carries a strong ETag for conditional
    # GET (cheap 304 revalidation). Resolves clock-and-timing -> its parent.
    r = client.get("/api/categories/clock-and-timing/partners")
    _assert_no_cache(r)
    assert r.headers.get("etag"), "partners endpoint must carry an ETag for conditional GET"


def test_get_category_etag_header(client, seeded_db):
    # Detail route gains a strong content-hash ETag (conditional GET) so a warm
    # re-nav revalidates as a cheap 304 instead of re-sending the full body.
    # Stays no-cache (banner single-source freshness) — mirrors /partners.
    r = client.get("/api/categories/clock-and-timing")
    _assert_no_cache(r)
    etag = r.headers.get("etag")
    assert etag, "detail endpoint must carry an ETag for conditional GET"
    assert not etag.startswith("W/"), f"ETag must be strong (content hash), got: {etag!r}"


def test_get_category_304_on_matching_if_none_match(client, seeded_db):
    # A warm re-navigation sends If-None-Match with the prior ETag; the server
    # returns 304 with an empty body (no 23 KB re-transfer). Mirrors /partners.
    first = client.get("/api/categories/clock-and-timing")
    etag = first.headers["etag"]
    second = client.get("/api/categories/clock-and-timing", headers={"If-None-Match": etag})
    assert second.status_code == 304, f"expected 304, got {second.status_code}"
    assert second.content == b"", f"304 body must be empty, got {second.content!r}"
    assert second.headers["etag"] == etag, "304 must echo the same ETag"
