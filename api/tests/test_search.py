"""Tests for /api/search endpoint."""

import pytest


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
    assert data["parts"] == []


def test_search_by_part_sku(client, seeded_db):
    """GET /api/search?q=LM7805 returns matching parts."""
    response = client.get("/api/search?q=LM7805")
    assert response.status_code == 200
    data = response.json()
    assert "parts" in data
    assert len(data["parts"]) == 1
    part = data["parts"][0]
    assert part["sku"] == "LM7805CT"
    assert part["manufacturer_name"] == "Texas Instruments"
    assert part["listings_count"] == 2
    assert part["best_price"] is not None
    assert part["best_price"] == pytest.approx(0.48, abs=0.01)


def test_search_by_part_manufacturer(client, seeded_db):
    """GET /api/search?q=STMicroelectronics returns matching parts."""
    response = client.get("/api/search?q=STMicroelectronics")
    assert response.status_code == 200
    data = response.json()
    assert "parts" in data
    part_skus = [p["sku"] for p in data["parts"]]
    assert "STM32F407VGT6" in part_skus


def test_search_by_part_description(client, seeded_db):
    """GET /api/search?q=Cortex returns matching parts via description."""
    response = client.get("/api/search?q=Cortex")
    assert response.status_code == 200
    data = response.json()
    assert "parts" in data
    part_skus = [p["sku"] for p in data["parts"]]
    assert "STM32F407VGT6" in part_skus
