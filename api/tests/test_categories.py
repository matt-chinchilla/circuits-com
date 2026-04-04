"""Tests for /api/categories endpoints."""


def test_list_categories(client, seeded_db):
    """GET /api/categories returns list with parent category (children are nested)."""
    response = client.get("/api/categories/")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    # Only top-level (parent) categories should be returned
    assert len(data) == 1
    parent = data[0]
    assert parent["name"] == "Integrated Circuits"
    assert parent["slug"] == "integrated-circuits"
    # Children are nested inside parent, not at the top level
    assert "children" in parent
    assert len(parent["children"]) == 1
    assert parent["children"][0]["slug"] == "clock-and-timing"


def test_get_category_by_slug(client, seeded_db):
    """GET /api/categories/clock-and-timing returns detail with suppliers and sponsor."""
    response = client.get("/api/categories/clock-and-timing")
    assert response.status_code == 200
    data = response.json()
    assert data["slug"] == "clock-and-timing"
    assert data["name"] == "Clock and Timing"

    # Should have suppliers
    assert "suppliers" in data
    assert len(data["suppliers"]) == 2
    supplier_names = {s["name"] for s in data["suppliers"]}
    assert "Avnet" in supplier_names
    assert "Kennedy Electronics" in supplier_names

    # Should have sponsor
    assert "sponsor" in data
    assert data["sponsor"] is not None
    assert data["sponsor"]["supplier_name"] == "Kennedy Electronics"
    assert data["sponsor"]["tier"] == "gold"
    assert data["sponsor"]["image_url"] == "/test.jpg"


def test_get_category_includes_parts(client, seeded_db):
    """GET /api/categories/clock-and-timing returns parts for that category."""
    response = client.get("/api/categories/clock-and-timing")
    assert response.status_code == 200
    data = response.json()

    assert "parts" in data
    assert len(data["parts"]) == 2
    part_skus = {p["sku"] for p in data["parts"]}
    assert "LM7805CT" in part_skus
    assert "STM32F407VGT6" in part_skus

    # Check part structure
    lm7805 = [p for p in data["parts"] if p["sku"] == "LM7805CT"][0]
    assert lm7805["manufacturer_name"] == "Texas Instruments"
    assert lm7805["lifecycle_status"] == "active"
    assert lm7805["listings_count"] == 2
    assert lm7805["best_price"] is not None


def test_get_category_parent_has_no_parts(client, seeded_db):
    """GET /api/categories/integrated-circuits returns empty parts for parent (parts are on child)."""
    response = client.get("/api/categories/integrated-circuits")
    assert response.status_code == 200
    data = response.json()

    assert "parts" in data
    assert data["parts"] == []


def test_get_category_not_found(client, seeded_db):
    """GET /api/categories/nonexistent returns 404."""
    response = client.get("/api/categories/nonexistent")
    assert response.status_code == 404
