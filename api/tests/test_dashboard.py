"""Tests for dashboard routes: stats, activity, revenue, popular."""


class TestDashboardAuth:
    def test_stats_requires_auth(self, client, seeded_db):
        resp = client.get("/api/dashboard/stats")
        assert resp.status_code == 401

    def test_activity_requires_auth(self, client, seeded_db):
        resp = client.get("/api/dashboard/activity")
        assert resp.status_code == 401

    def test_revenue_requires_auth(self, client, seeded_db):
        resp = client.get("/api/dashboard/revenue")
        assert resp.status_code == 401

    def test_popular_requires_auth(self, client, seeded_db):
        resp = client.get("/api/dashboard/popular")
        assert resp.status_code == 401


def _auth_header(client):
    resp = client.post("/api/auth/login", json={
        "username": "admin",
        "password": "testpass123",
    })
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


class TestStats:
    def test_stats_returns_counts(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.get("/api/dashboard/stats", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["parts_count"] == 2
        assert data["suppliers_count"] == 2
        assert data["revenue_total"] == 600.0  # 500 + 100
        assert data["sponsors_count"] == 1


class TestActivity:
    def test_activity_returns_recent_items(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.get("/api/dashboard/activity", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) <= 10
        # Should have both part_added and revenue types
        types = {item["type"] for item in data}
        assert "part_added" in types
        assert "revenue" in types
        for item in data:
            assert "description" in item
            assert "created_at" in item


class TestRevenue:
    def test_revenue_returns_monthly(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.get("/api/dashboard/revenue", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        # Revenue in seeded_db is for March 2026
        if data:
            entry = data[0]
            assert "month" in entry
            assert "total" in entry
            assert "sponsorship" in entry
            assert "listing_fee" in entry
            assert "featured" in entry


class TestPopular:
    def test_popular_returns_top(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.get("/api/dashboard/popular", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "top_categories" in data
        assert "top_suppliers" in data
        assert len(data["top_categories"]) > 0
        assert len(data["top_suppliers"]) > 0
        # Check structure
        cat = data["top_categories"][0]
        assert "name" in cat
        assert "parts_count" in cat
        sup = data["top_suppliers"][0]
        assert "name" in sup
        assert "listings_count" in sup
