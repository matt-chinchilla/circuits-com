"""Tests for Cache-Control headers on category endpoints."""


def test_list_categories_cache_header(client, seeded_db):
    response = client.get("/api/categories/")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=60"


def test_get_category_cache_header(client, seeded_db):
    response = client.get("/api/categories/clock-and-timing")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=60"
