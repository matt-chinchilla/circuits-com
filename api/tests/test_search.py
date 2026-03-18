"""Tests for /api/search endpoint."""


def test_search_by_category_name(client, seeded_db):
    """GET /api/search?q=Clock returns matching categories."""
    response = client.get("/api/search?q=Clock")
    assert response.status_code == 200
    data = response.json()
    assert "categories" in data
    assert "suppliers" in data
    category_names = [c["name"] for c in data["categories"]]
    assert "Clock and Timing" in category_names


def test_search_by_supplier_name(client, seeded_db):
    """GET /api/search?q=Avnet returns matching suppliers."""
    response = client.get("/api/search?q=Avnet")
    assert response.status_code == 200
    data = response.json()
    assert "suppliers" in data
    supplier_names = [s["name"] for s in data["suppliers"]]
    assert "Avnet" in supplier_names


def test_search_empty_results(client, seeded_db):
    """GET /api/search?q=zzzznothing returns empty arrays."""
    response = client.get("/api/search?q=zzzznothing")
    assert response.status_code == 200
    data = response.json()
    assert data["categories"] == []
    assert data["suppliers"] == []
