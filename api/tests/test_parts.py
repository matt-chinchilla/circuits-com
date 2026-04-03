"""Tests for parts CRUD routes."""


def _auth_header(client):
    resp = client.post("/api/auth/login", json={
        "username": "admin",
        "password": "testpass123",
    })
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


class TestListParts:
    def test_list_parts_paginated(self, client, seeded_db):
        resp = client.get("/api/parts/")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert "total" in data
        assert "page" in data
        assert "pages" in data
        assert data["total"] == 2
        assert data["page"] == 1
        assert len(data["items"]) == 2

    def test_list_parts_with_search(self, client, seeded_db):
        resp = client.get("/api/parts/?search=LM7805")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert data["items"][0]["mpn"] == "LM7805CT"

    def test_list_parts_search_by_description(self, client, seeded_db):
        resp = client.get("/api/parts/?search=Cortex")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert data["items"][0]["mpn"] == "STM32F407VGT6"

    def test_list_parts_with_category_filter(self, client, seeded_db):
        category_id = str(seeded_db["child"].id)
        resp = client.get(f"/api/parts/?category_id={category_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 2

    def test_list_parts_with_supplier_filter(self, client, seeded_db):
        # supplier1 has 1 listing (for part1), supplier2 has 1 listing (for part1)
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.get(f"/api/parts/?supplier_id={supplier_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 1

    def test_list_parts_pagination(self, client, seeded_db):
        resp = client.get("/api/parts/?page=1&per_page=1")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) == 1
        assert data["pages"] == 2
        assert data["total"] == 2


class TestCreatePart:
    def test_create_part(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post("/api/parts/", json={
            "mpn": "NE555P",
            "description": "Timer IC",
            "manufacturer_name": "Texas Instruments",
        }, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["mpn"] == "NE555P"
        assert data["manufacturer_name"] == "Texas Instruments"
        assert data["id"] is not None

    def test_create_part_with_category(self, client, seeded_db):
        headers = _auth_header(client)
        cat_id = str(seeded_db["child"].id)
        resp = client.post("/api/parts/", json={
            "mpn": "NE556P",
            "manufacturer_name": "TI",
            "category_id": cat_id,
            "lifecycle_status": "active",
        }, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["category_id"] == cat_id

    def test_create_part_requires_auth(self, client, seeded_db):
        resp = client.post("/api/parts/", json={
            "mpn": "NE555P",
            "manufacturer_name": "TI",
        })
        assert resp.status_code == 401


class TestGetPartDetail:
    def test_get_part_detail(self, client, seeded_db):
        part_id = str(seeded_db["part1"].id)
        resp = client.get(f"/api/parts/{part_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["mpn"] == "LM7805CT"
        assert "listings" in data
        assert len(data["listings"]) == 2
        # Check listing structure
        listing = data["listings"][0]
        assert "supplier_name" in listing
        assert "price_breaks" in listing

    def test_get_part_detail_with_price_breaks(self, client, seeded_db):
        part_id = str(seeded_db["part1"].id)
        resp = client.get(f"/api/parts/{part_id}")
        data = resp.json()
        # listing1 (Avnet) has 3 price breaks
        avnet_listing = [l for l in data["listings"] if l["supplier_name"] == "Avnet"][0]
        assert len(avnet_listing["price_breaks"]) == 3

    def test_get_part_not_found(self, client, seeded_db):
        import uuid
        fake_id = str(uuid.uuid4())
        resp = client.get(f"/api/parts/{fake_id}")
        assert resp.status_code == 404


class TestUpdatePart:
    def test_update_part(self, client, seeded_db):
        headers = _auth_header(client)
        part_id = str(seeded_db["part1"].id)
        resp = client.put(f"/api/parts/{part_id}", json={
            "description": "Updated description",
        }, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["description"] == "Updated description"
        # mpn unchanged
        assert resp.json()["mpn"] == "LM7805CT"

    def test_update_part_requires_auth(self, client, seeded_db):
        part_id = str(seeded_db["part1"].id)
        resp = client.put(f"/api/parts/{part_id}", json={
            "description": "no auth",
        })
        assert resp.status_code == 401

    def test_update_part_not_found(self, client, seeded_db):
        import uuid
        headers = _auth_header(client)
        fake_id = str(uuid.uuid4())
        resp = client.put(f"/api/parts/{fake_id}", json={
            "description": "nope",
        }, headers=headers)
        assert resp.status_code == 404


class TestDeletePart:
    def test_delete_part(self, client, seeded_db):
        headers = _auth_header(client)
        # Delete part2 (no listings)
        part_id = str(seeded_db["part2"].id)
        resp = client.delete(f"/api/parts/{part_id}", headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}
        # Verify it's gone
        resp = client.get(f"/api/parts/{part_id}")
        assert resp.status_code == 404

    def test_delete_part_with_listings(self, client, seeded_db):
        headers = _auth_header(client)
        # part1 has listings and price breaks
        part_id = str(seeded_db["part1"].id)
        resp = client.delete(f"/api/parts/{part_id}", headers=headers)
        assert resp.status_code == 200

    def test_delete_part_requires_auth(self, client, seeded_db):
        part_id = str(seeded_db["part1"].id)
        resp = client.delete(f"/api/parts/{part_id}")
        assert resp.status_code == 401


class TestBatchImport:
    def test_batch_import_happy_path(self, client, seeded_db):
        headers = _auth_header(client)
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.post("/api/parts/batch", json={
            "supplier_id": supplier_id,
            "parts": [
                {
                    "mpn": "BATCH001",
                    "manufacturer_name": "Batch Corp",
                    "description": "Batch part 1",
                    "unit_price": 1.50,
                    "sku": "B001",
                    "stock_quantity": 100,
                },
                {
                    "mpn": "BATCH002",
                    "manufacturer_name": "Batch Corp",
                    "description": "Batch part 2",
                },
            ],
        }, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["created"] == 2
        assert data["errors"] == []

    def test_batch_import_with_errors(self, client, seeded_db):
        headers = _auth_header(client)
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.post("/api/parts/batch", json={
            "supplier_id": supplier_id,
            "parts": [
                {
                    "mpn": "",
                    "manufacturer_name": "Corp",
                },
            ],
        }, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["errors"]) > 0

    def test_batch_import_requires_auth(self, client, seeded_db):
        resp = client.post("/api/parts/batch", json={
            "supplier_id": str(seeded_db["supplier1"].id),
            "parts": [],
        })
        assert resp.status_code == 401
