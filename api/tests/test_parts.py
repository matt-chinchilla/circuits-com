"""Tests for parts CRUD routes."""


def test_part_list_includes_best_price_and_total_stock(client, seeded_db):
    """The admin Parts table needs best_price + total_stock columns. Without
    these on the list response, the table would either render '—' for every
    row (existing behavior) or require a per-row roundtrip to the detail
    endpoint (N+1). seeded_db.part1 has 2 listings with prices 0.52 + 0.48
    and stocks 15000 + 8000.
    """
    resp = client.get("/api/parts/")
    assert resp.status_code == 200
    items = resp.json()["items"]
    # All items expose the fields (even if null for parts without listings)
    for item in items:
        assert "best_price" in item, "best_price must be on every Part list row"
        assert "total_stock" in item, "total_stock must be on every Part list row"

    # part1 (LM7805CT) has 2 listings: best is 0.48, total stock is 23000
    lm7805 = next(p for p in items if p["sku"] == "LM7805CT")
    assert lm7805["best_price"] == 0.48
    assert lm7805["total_stock"] == 23000

    # part2 (STM32F407VGT6) has no listings: both should be null
    stm32 = next(p for p in items if p["sku"] == "STM32F407VGT6")
    assert stm32["best_price"] is None
    assert stm32["total_stock"] is None


def test_part_to_dict_includes_parent_category_icon(db, seeded_db):
    """When a part lives on a subcategory, part_to_dict must surface the
    PARENT category's icon as parent_category_icon, in addition to the
    existing parent_category_name / parent_category_slug.

    The admin Parts table renders the top-level (parent) icon next to the
    'Parent (Sub)' lineage per the v5 Claude Design handoff. Without
    parent_category_icon, the table would either show the subcategory's
    icon (wrong: too specific) or no icon at all (regression vs design).
    """
    from app.routes.parts import part_to_dict

    part = seeded_db["part1"]  # attached to child category
    result = part_to_dict(part, db)

    # Existing fields still present
    assert result["category_name"] == "Clock and Timing"
    assert result["parent_category_name"] == "Integrated Circuits"
    # New field: parent icon — must equal the PARENT's icon, not the child's
    assert "parent_category_icon" in result, (
        "part_to_dict must expose parent_category_icon so admin Parts table "
        "can render the top-level Phosphor icon next to lineage."
    )
    assert result["parent_category_icon"] == "⚡"  # seeded parent icon
    assert result["category_icon"] == "⏰"  # subcategory icon (unchanged)


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
        assert data["items"][0]["sku"] == "LM7805CT"

    def test_list_parts_search_by_description(self, client, seeded_db):
        resp = client.get("/api/parts/?search=Cortex")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert data["items"][0]["sku"] == "STM32F407VGT6"

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
            "sku": "NE555P",
            "description": "Timer IC",
            "manufacturer_name": "Texas Instruments",
        }, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["sku"] == "NE555P"
        assert data["manufacturer_name"] == "Texas Instruments"
        assert data["id"] is not None

    def test_create_part_with_category(self, client, seeded_db):
        headers = _auth_header(client)
        cat_id = str(seeded_db["child"].id)
        resp = client.post("/api/parts/", json={
            "sku": "NE556P",
            "manufacturer_name": "TI",
            "category_id": cat_id,
            "lifecycle_status": "active",
        }, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["category_id"] == cat_id

    def test_create_part_requires_auth(self, client, seeded_db):
        resp = client.post("/api/parts/", json={
            "sku": "NE555P",
            "manufacturer_name": "TI",
        })
        assert resp.status_code == 401


class TestGetPartDetail:
    def test_get_part_detail(self, client, seeded_db):
        part_id = str(seeded_db["part1"].id)
        resp = client.get(f"/api/parts/{part_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["sku"] == "LM7805CT"
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
        # sku unchanged
        assert resp.json()["sku"] == "LM7805CT"

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
                    "sku": "BATCH001",
                    "manufacturer_name": "Batch Corp",
                    "description": "Batch part 1",
                    "unit_price": 1.50,
                    "listing_sku": "B001",
                    "stock_quantity": 100,
                },
                {
                    "sku": "BATCH002",
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
                    "sku": "",
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
