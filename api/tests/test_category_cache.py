"""The rendered category-page cache (app/services/category_cache), as the
route uses it: a second read is the bytes the first one sent, with no query;
a write anywhere in the catalog or the sponsors forgets everything; a stale
page is served while it is rebuilt; the warmer pre-renders every page."""

import uuid

from app.models import Category, Part, Sponsor
from app.routes.categories import warm_category_cache
from app.services import category_cache
from app.services.category_cache import key_for
from app.services.search_service import invalidate_catalog_caches

from .feed_helpers import StatementCounter


def _a_parent_slug(db) -> str:
    return (
        db.query(Category.slug)
        .filter(Category.parent_id.is_(None))
        .order_by(Category.slug)
        .first()[0]
    )


def test_the_key_normalises_order_and_lists():
    a = key_for("cat", [("q", None), ("manufacturers", ["b", "a"]), ("parts_page", 2)])
    b = key_for("cat", [("parts_page", 2), ("manufacturers", ["a", "b"]), ("q", None)])
    assert a == b
    assert key_for("cat", [("parts_page", 3)]) != key_for("cat", [("parts_page", 2)])
    assert key_for("other", [("parts_page", 2)]) != key_for("cat", [("parts_page", 2)])


def test_a_second_read_is_the_same_bytes_with_no_query(client, seeded_db, db):
    slug = _a_parent_slug(db)
    first = client.get(f"/api/categories/{slug}")
    assert first.status_code == 200
    with StatementCounter(db) as counted:
        second = client.get(f"/api/categories/{slug}")
    assert second.status_code == 200
    assert second.content == first.content
    assert second.headers["ETag"] == first.headers["ETag"]
    assert counted.statements == []


def test_revalidation_is_a_304_from_the_cache(client, seeded_db, db):
    slug = _a_parent_slug(db)
    etag = client.get(f"/api/categories/{slug}").headers["ETag"]
    with StatementCounter(db) as counted:
        again = client.get(f"/api/categories/{slug}", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert counted.statements == []


def test_a_different_query_is_a_different_page(client, seeded_db, db):
    slug = _a_parent_slug(db)
    client.get(f"/api/categories/{slug}")
    with StatementCounter(db) as counted:
        client.get(f"/api/categories/{slug}?parts_page=2")
    assert counted.statements, "page 2 must be rendered, not served as page 1"


def test_a_catalog_write_forgets_every_page(client, seeded_db, db):
    slug = _a_parent_slug(db)
    client.get(f"/api/categories/{slug}")
    assert category_cache.size() == 1
    invalidate_catalog_caches()  # the seam every part/supplier write and feed run calls
    assert category_cache.size() == 0
    with StatementCounter(db) as counted:
        client.get(f"/api/categories/{slug}")
    assert counted.statements


def test_deleting_a_sponsor_forgets_every_page(client, seeded_db, db, auth_header):
    slug = _a_parent_slug(db)
    client.get(f"/api/categories/{slug}")
    assert category_cache.size() == 1
    sponsor = db.query(Sponsor).first()
    assert sponsor is not None, "the seed carries sponsors"
    resp = client.delete(f"/api/admin/sponsors/{sponsor.id}", headers=auth_header())
    assert resp.status_code in (200, 204), resp.text
    assert category_cache.size() == 0


def test_a_stale_page_is_served_as_is_and_rebuilt_for_the_next_visitor(
    client, seeded_db, db, monkeypatch
):
    slug = _a_parent_slug(db)
    before = client.get(f"/api/categories/{slug}").json()
    parent = db.query(Category).filter(Category.slug == slug).one()
    child = parent.children[0]
    db.add(Part(id=uuid.uuid4(), sku="STALE-PROBE", manufacturer_name="T", category_id=child.id))
    db.commit()  # NOT through the route, so nothing cleared the cache

    monkeypatch.setattr(category_cache, "FRESH_SECONDS", 0)
    stale = client.get(f"/api/categories/{slug}").json()
    assert stale["parts"]["total"] == before["parts"]["total"], "the stale page is served as-is"
    # The synchronous (test-mode) rebuild already ran; the next read is new,
    # and it is a cache hit, not a render (freshness restored, or every hit
    # would be stale again by construction).
    monkeypatch.setattr(category_cache, "FRESH_SECONDS", 600)
    with StatementCounter(db) as counted:
        after = client.get(f"/api/categories/{slug}").json()
    assert after["parts"]["total"] == before["parts"]["total"] + 1
    assert counted.statements == []


def test_an_unusable_page_is_rendered_on_the_request(client, seeded_db, db, monkeypatch):
    slug = _a_parent_slug(db)
    client.get(f"/api/categories/{slug}")
    monkeypatch.setattr(category_cache, "USABLE_SECONDS", 0)
    with StatementCounter(db) as counted:
        assert client.get(f"/api/categories/{slug}").status_code == 200
    assert counted.statements


def test_misses_and_errors_are_not_cached(client, seeded_db, db):
    assert client.get("/api/categories/no-such-category").status_code == 404
    assert category_cache.size() == 0
    slug = _a_parent_slug(db)
    assert client.get(f"/api/categories/{slug}?sort=bogus").status_code == 422
    assert category_cache.size() == 0


def test_the_lru_bounds_the_cache():
    for i in range(category_cache.MAX_ENTRIES + 5):
        category_cache.put(f"k{i}", b"{}", '"e"', rebuild=lambda: None)
    assert category_cache.size() == category_cache.MAX_ENTRIES
    assert category_cache.get("k0") is None
    assert category_cache.get(f"k{category_cache.MAX_ENTRIES + 4}") is not None


def test_the_warmer_renders_every_category(client, seeded_db, db):
    warmed = warm_category_cache()
    assert warmed == db.query(Category).count()
    slug = _a_parent_slug(db)
    with StatementCounter(db) as counted:
        resp = client.get(
            f"/api/categories/{slug}/?popular_page=1&popular_per_page=1&parts_page=1&parts_per_page=25"
        )
    assert resp.status_code == 200
    assert counted.statements == [], "the canonical first page must come from the warm"
