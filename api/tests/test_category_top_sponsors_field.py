"""Contract tests for GET /api/categories/{slug}.top_sponsors shape (CSB v13).

Clean break: the legacy singular ``sponsor`` key is gone — replaced with
``top_sponsors: list[SponsorResponse]`` (always present, length 0 or 1
today, room for multi-sponsor banners later).
"""

import uuid

from app.models import Category, Sponsor, Supplier


def _seed_category_and_supplier(db):
    supplier = Supplier(
        id=uuid.uuid4(),
        name="Top-Sponsors Distributor",
        phone="555-111-2222",
        website="topsponsors.example.com",
        email="info@topsponsors.example.com",
    )
    category = Category(
        id=uuid.uuid4(),
        name="Top Sponsors Category",
        slug="top-sponsors-cat",
        icon="lightning",
        sort_order=0,
    )
    db.add_all([supplier, category])
    db.commit()
    db.refresh(supplier)
    db.refresh(category)
    return supplier, category


def test_top_sponsors_is_list(client, db):
    """Response JSON must carry key 'top_sponsors' typed as list."""
    _, category = _seed_category_and_supplier(db)
    response = client.get(f"/api/categories/{category.slug}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert "top_sponsors" in body, body.keys()
    assert isinstance(body["top_sponsors"], list)


def test_singular_sponsor_key_absent(client, db):
    """Clean break — the old singular 'sponsor' field must be gone."""
    _, category = _seed_category_and_supplier(db)
    response = client.get(f"/api/categories/{category.slug}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert "sponsor" not in body, (
        "Expected clean break — 'sponsor' should be replaced by 'top_sponsors'."
    )


def test_top_sponsors_populated_when_sponsor_exists(client, db):
    """With one Active sponsor seeded, top_sponsors has exactly one entry."""
    supplier, category = _seed_category_and_supplier(db)
    sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=supplier.id,
        category_id=category.id,
        image_url="/top.jpg",
        description="Top sponsor",
        tier="gold",
        status="Active",
    )
    db.add(sponsor)
    db.commit()

    response = client.get(f"/api/categories/{category.slug}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["top_sponsors"]) == 1


def test_top_sponsors_empty_when_no_sponsor(client, db):
    """With no sponsor seeded, top_sponsors is an empty list (not null)."""
    _, category = _seed_category_and_supplier(db)
    response = client.get(f"/api/categories/{category.slug}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["top_sponsors"] == []
