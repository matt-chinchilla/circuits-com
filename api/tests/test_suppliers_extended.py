"""Tests for extended supplier routes: create, detail, update, parts."""

import uuid


def _auth_header(client):
    resp = client.post("/api/auth/login", json={
        "username": "admin",
        "password": "testpass123",
    })
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


class TestCreateSupplier:
    def test_create_supplier(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post("/api/suppliers/", json={
            "name": "New Supplier Inc",
            "phone": "555-1234",
            "website": "newsupplier.com",
            "email": "info@newsupplier.com",
            "description": "A test supplier",
        }, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "New Supplier Inc"
        assert data["phone"] == "555-1234"
        assert data["id"] is not None

    def test_create_supplier_minimal(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post("/api/suppliers/", json={
            "name": "Minimal Supplier",
        }, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Minimal Supplier"
        assert data["phone"] is None

    def test_create_supplier_requires_auth(self, client, seeded_db):
        resp = client.post("/api/suppliers/", json={
            "name": "No Auth",
        })
        assert resp.status_code == 401


class TestGetSupplierDetail:
    def test_get_supplier_detail(self, client, seeded_db):
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.get(f"/api/suppliers/{supplier_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Avnet"
        assert "parts_count" in data
        assert "revenue_total" in data
        assert "categories" in data

    def test_get_supplier_detail_with_revenue(self, client, seeded_db):
        supplier_id = str(seeded_db["supplier2"].id)
        resp = client.get(f"/api/suppliers/{supplier_id}")
        data = resp.json()
        assert data["revenue_total"] == 500.0  # Kennedy has 500 revenue
        assert "Clock and Timing" in data["categories"]

    def test_get_supplier_not_found(self, client, seeded_db):
        fake_id = str(uuid.uuid4())
        resp = client.get(f"/api/suppliers/{fake_id}")
        assert resp.status_code == 404


class TestUpdateSupplier:
    def test_update_supplier(self, client, seeded_db):
        headers = _auth_header(client)
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.put(f"/api/suppliers/{supplier_id}", json={
            "name": "Avnet Updated",
            "website": "avnet-new.com",
        }, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Avnet Updated"
        assert data["website"] == "avnet-new.com"
        # Unchanged fields preserved
        assert data["phone"] == "480-643-2000"

    def test_update_supplier_requires_auth(self, client, seeded_db):
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.put(f"/api/suppliers/{supplier_id}", json={
            "name": "No Auth",
        })
        assert resp.status_code == 401

    def test_update_supplier_not_found(self, client, seeded_db):
        headers = _auth_header(client)
        fake_id = str(uuid.uuid4())
        resp = client.put(f"/api/suppliers/{fake_id}", json={
            "name": "Nope",
        }, headers=headers)
        assert resp.status_code == 404


class TestGetSupplierParts:
    def test_get_supplier_parts(self, client, seeded_db):
        # supplier1 (Avnet) has listing for part1
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.get(f"/api/suppliers/{supplier_id}/parts")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert "total" in data
        assert data["total"] >= 1
        # Verify structure
        item = data["items"][0]
        assert "sku" in item
        assert "manufacturer_name" in item

    def test_get_supplier_parts_not_found(self, client, seeded_db):
        fake_id = str(uuid.uuid4())
        resp = client.get(f"/api/suppliers/{fake_id}/parts")
        assert resp.status_code == 404

    def test_get_supplier_parts_pagination(self, client, seeded_db):
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.get(f"/api/suppliers/{supplier_id}/parts?page=1&per_page=1")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) <= 1
