"""The tripwire fired — this file is now the pin on what replaced it.

WHAT THIS FILE USED TO BE. The category page fetched every part for a category
in ONE request (`per_page=500`) and did the filtering, sorting and paging in
the browser. Server-side paging was DEFERRED by the 2026-06-07 category-page
performance spec, which pre-approved this exact rework in its Deferred section
and asked for a tripwire: a test that replayed the seed's attachment logic over
`app/db/catalog_data/*.json` and failed once any top-level rollup passed 450
parts, 90% of the 500 cap.

IT FIRED. The catalog is past 200k parts: 27 of 28 top-level categories and 127
of 189 leaf subcategories exceed 500, so pages silently truncated — Connectors
rendered 500 of 39,353 — and the header count lied about the rest.

WHAT IT IS NOW. Measuring the catalog for growth is pointless once growth is
handled, so the file keeps its name (the ledger of a tripwire that did its job)
and pins the behaviour that answers it: a category holding far more than 500
parts pages correctly, reports a TRUE total, and cannot be talked into
returning more than 100 rows at a time. If a future change reinstates
fetch-everything, these assertions fail rather than a threshold silently
creeping.

The catalog JSON is not needed for any of that — this seeds a category with 512
parts directly, which is both faster and independent of what the real catalog
happens to hold this month.
"""

import uuid

from app.models import Category, Part

# One more than the old 500-row cap: the point is a category the retired model
# could not have shown whole.
PART_COUNT = 512
OLD_FETCH_EVERYTHING_CAP = 500
MAX_PER_PAGE = 100


def _seed_big_category(db, *, slug: str, count: int = PART_COUNT) -> Category:
    """A LEAF category holding `count` parts, skus ordered PART-0000 upward."""
    parent = Category(
        id=uuid.uuid4(), name="Connectors", slug=f"{slug}-parent", icon="plugs", sort_order=0
    )
    db.add(parent)
    db.flush()
    leaf = Category(
        id=uuid.uuid4(),
        name="Headers",
        slug=slug,
        icon="plug",
        parent_id=parent.id,
        sort_order=0,
    )
    db.add(leaf)
    db.flush()
    db.add_all(
        [
            Part(
                id=uuid.uuid4(),
                sku=f"PART-{i:04d}",
                manufacturer_name="Molex",
                category_id=leaf.id,
                sub_slug=slug,
                lifecycle_status="active",
            )
            for i in range(count)
        ]
    )
    db.commit()
    return leaf


def test_a_category_past_the_old_cap_reports_its_true_total(client, db):
    """The count in the header is the whole category, not the page.

    This is the assertion the truncation broke: Connectors said 500 while
    holding 39,353, and nothing in the response admitted it.
    """
    _seed_big_category(db, slug="headers-total")

    data = client.get("/api/categories/headers-total").json()
    parts = data["parts"]

    assert parts["total"] == PART_COUNT
    assert parts["total"] > OLD_FETCH_EVERYTHING_CAP, "the point is a category past the old cap"
    assert data["facets"]["total_unfiltered"] == PART_COUNT


def test_every_part_is_reachable_by_paging(client, db):
    """Nothing is stranded past the end of the first page.

    Pages the WHOLE category at the maximum page size and asserts the union is
    the category — the truncated model could reach 500 of these and no more,
    whatever the client did.
    """
    _seed_big_category(db, slug="headers-paging")

    seen: set[str] = set()
    first = client.get("/api/categories/headers-paging?parts_per_page=100&parts_page=1").json()
    pages = first["parts"]["pages"]
    assert pages == 6, f"512 parts at 100/page is 6 pages, got {pages}"

    for page in range(1, pages + 1):
        body = client.get(
            f"/api/categories/headers-paging?parts_per_page=100&parts_page={page}"
        ).json()["parts"]
        assert body["page"] == page
        assert body["total"] == PART_COUNT, "the total must not drift between pages"
        seen.update(p["sku"] for p in body["items"])

    assert len(seen) == PART_COUNT, f"paging reached {len(seen)} of {PART_COUNT} parts"
    assert seen == {f"PART-{i:04d}" for i in range(PART_COUNT)}


def test_pages_do_not_overlap(client, db):
    """Consecutive pages are disjoint — a wobbly sort would repeat rows on one
    page while hiding them from another, which is truncation wearing a
    different hat."""
    _seed_big_category(db, slug="headers-disjoint")

    def skus(page: int) -> list[str]:
        body = client.get(
            f"/api/categories/headers-disjoint?parts_per_page=100&parts_page={page}"
        ).json()["parts"]
        return [p["sku"] for p in body["items"]]

    first, second = skus(1), skus(2)
    assert len(first) == 100 and len(second) == 100
    assert not set(first) & set(second)
    # Default leaf sort is sku asc, so the boundary is exact.
    assert first[0] == "PART-0000"
    assert second[0] == "PART-0100"


def test_the_500_ceiling_is_gone(client, db):
    """`parts_per_page=500` — what every call site used to send — is now a 422.

    The ceiling is 100. It is enforced by the route (`le=`) so an over-large
    ask is visible to the caller rather than silently clamped, and again by the
    service's own min() so no internal caller can route around it.
    """
    _seed_big_category(db, slug="headers-ceiling", count=150)

    assert client.get("/api/categories/headers-ceiling?parts_per_page=500").status_code == 422
    assert client.get("/api/categories/headers-ceiling?parts_per_page=101").status_code == 422

    ok = client.get("/api/categories/headers-ceiling?parts_per_page=100")
    assert ok.status_code == 200
    body = ok.json()["parts"]
    assert body["per_page"] == MAX_PER_PAGE
    assert len(body["items"]) == MAX_PER_PAGE


def test_the_service_enforces_the_ceiling_too(db):
    """The second layer, proven directly: the route's `le=` cannot be the only
    guard, or an internal caller reintroduces fetch-everything without a 422 to
    show for it."""
    from app.services.category_service import MAX_PARTS_PER_PAGE, get_category_by_slug

    _seed_big_category(db, slug="headers-service", count=150)

    result = get_category_by_slug(db, "headers-service", parts_per_page=500)
    assert result["parts"]["per_page"] == MAX_PARTS_PER_PAGE
    assert len(result["parts"]["items"]) == MAX_PARTS_PER_PAGE


def test_a_parent_rollup_past_the_cap_pages_too(client, db):
    """The rollup is the case that actually tripped the old threshold: a
    top-level category's page shows every part beneath it."""
    leaf = _seed_big_category(db, slug="headers-rollup")
    parent_slug = f"{leaf.slug}-parent"

    data = client.get(f"/api/categories/{parent_slug}?parts_per_page=100").json()
    assert data["parts"]["total"] == PART_COUNT
    assert data["parts"]["pages"] == 6
    assert data["facets"]["subs"] == [
        {"slug": "headers-rollup", "name": "Headers", "count": PART_COUNT}
    ]
