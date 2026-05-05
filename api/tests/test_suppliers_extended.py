"""Tests for extended supplier routes: create, detail, update, parts."""

import uuid

from app.models import (
    Category,
    CategorySupplier,
    PartListing,
    PriceBreak,
    Revenue,
    Sponsor,
    Supplier,
    User,
)


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

    def test_create_supplier_with_contact_name(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post("/api/suppliers/", json={
            "name": "Contact Test Corp",
            "contact_name": "Jane Doe",
        }, headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["contact_name"] == "Jane Doe"

    def test_list_suppliers_includes_contact_name(self, client, seeded_db):
        headers = _auth_header(client)
        client.post("/api/suppliers/", json={
            "name": "Listed Contact Corp",
            "contact_name": "John Smith",
        }, headers=headers)

        resp = client.get("/api/suppliers/")
        assert resp.status_code == 200
        names = {s["name"]: s for s in resp.json()}
        assert "Listed Contact Corp" in names
        assert names["Listed Contact Corp"]["contact_name"] == "John Smith"

    def test_update_supplier_contact_name(self, client, seeded_db):
        headers = _auth_header(client)
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.put(f"/api/suppliers/{supplier_id}", json={
            "contact_name": "New Salesperson",
        }, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["contact_name"] == "New Salesperson"


class TestListSuppliersAggregates:
    """Regression: GET /api/suppliers/ must include parts_count and categories
    on every item — the admin Suppliers list page renders these on every card,
    and prior to this test the endpoint returned bare ORM rows so every card
    fell through to `?? 0` and showed '0 parts · No categories'."""

    def test_list_suppliers_includes_parts_count(self, client, seeded_db):
        resp = client.get("/api/suppliers/")
        assert resp.status_code == 200
        rows = {s["name"]: s for s in resp.json()}
        assert "Avnet" in rows and "Kennedy Electronics" in rows
        # seeded_db: each supplier has exactly 1 PartListing for part1 (LM7805CT)
        assert rows["Avnet"]["parts_count"] == 1
        assert rows["Kennedy Electronics"]["parts_count"] == 1

    def test_list_suppliers_includes_categories(self, client, seeded_db):
        resp = client.get("/api/suppliers/")
        rows = {s["name"]: s for s in resp.json()}
        # both seeded suppliers are linked to the "Clock and Timing" subcategory
        assert rows["Avnet"]["categories"] == ["Clock and Timing"]
        assert rows["Kennedy Electronics"]["categories"] == ["Clock and Timing"]

    def test_list_suppliers_zero_for_supplier_without_parts_or_categories(
        self, client, seeded_db
    ):
        headers = _auth_header(client)
        client.post(
            "/api/suppliers/", json={"name": "Empty Co"}, headers=headers
        )
        resp = client.get("/api/suppliers/")
        empty = next(s for s in resp.json() if s["name"] == "Empty Co")
        assert empty["parts_count"] == 0
        assert empty["categories"] == []


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


class TestDeleteSupplier:
    """Regression: DELETE /api/suppliers/{id} cascades to all child tables.
    Pre-fix this route did not exist (405). Post-fix the supplier and every
    PartListing / PriceBreak / Sponsor / CategorySupplier / Revenue row that
    references the supplier are removed atomically, while User.supplier_id is
    nulled (company-user accounts are preserved)."""

    def test_delete_supplier_cascades_all_dependents(self, client, seeded_db):
        # supplier2 (Kennedy) seeded with: 1 listing, 1 sponsor, 1 revenue,
        # 1 category-supplier link, and is the supplier_id of company_user.
        # We attach TWO additional CategorySupplier rows so the cascade hits
        # multiple selectin-loaded relationship rows — without `db.expire(...)`
        # the parent delete would crash trying to NULL composite-PK columns
        # on the second + third stale rows. Single-category coverage would
        # not regression-test the `db.expire` workaround.
        from tests.conftest import TestingSessionLocal

        with TestingSessionLocal() as setup_db:
            extra_a = Category(
                id=uuid.uuid4(),
                name="Extra Cat A",
                slug="extra-cat-a",
                icon="A",
                sort_order=10,
            )
            extra_b = Category(
                id=uuid.uuid4(),
                name="Extra Cat B",
                slug="extra-cat-b",
                icon="B",
                sort_order=11,
            )
            setup_db.add_all([extra_a, extra_b])
            setup_db.flush()
            setup_db.add_all(
                [
                    CategorySupplier(
                        category_id=extra_a.id,
                        supplier_id=seeded_db["supplier2"].id,
                        is_featured=False,
                        rank=2,
                    ),
                    CategorySupplier(
                        category_id=extra_b.id,
                        supplier_id=seeded_db["supplier2"].id,
                        is_featured=False,
                        rank=3,
                    ),
                ]
            )
            setup_db.commit()

        supplier_id = str(seeded_db["supplier2"].id)
        listing_id = seeded_db["listing2"].id
        company_user_id = seeded_db["company_user"].id

        headers = _auth_header(client)
        resp = client.delete(f"/api/suppliers/{supplier_id}", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

        with TestingSessionLocal() as db:
            assert db.query(Supplier).filter_by(id=seeded_db["supplier2"].id).first() is None
            assert db.query(PartListing).filter_by(id=listing_id).first() is None
            assert (
                db.query(PriceBreak).filter_by(listing_id=listing_id).count() == 0
            )
            assert (
                db.query(Sponsor).filter_by(supplier_id=seeded_db["supplier2"].id).count() == 0
            )
            assert (
                db.query(CategorySupplier)
                .filter_by(supplier_id=seeded_db["supplier2"].id)
                .count() == 0
            )
            assert (
                db.query(Revenue).filter_by(supplier_id=seeded_db["supplier2"].id).count() == 0
            )
            # User survives but is unlinked
            user = db.query(User).filter_by(id=company_user_id).first()
            assert user is not None
            assert user.supplier_id is None

    def test_delete_supplier_with_no_dependents(self, client, seeded_db):
        # Create a fresh supplier with nothing attached, then delete it.
        headers = _auth_header(client)
        created = client.post(
            "/api/suppliers/", json={"name": "Disposable Co"}, headers=headers
        ).json()
        new_id = created["id"]

        resp = client.delete(f"/api/suppliers/{new_id}", headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}

        # Confirm it's gone from the listing
        listing = client.get("/api/suppliers/").json()
        assert "Disposable Co" not in [s["name"] for s in listing]

    def test_delete_supplier_not_found(self, client, seeded_db):
        headers = _auth_header(client)
        fake_id = str(uuid.uuid4())
        resp = client.delete(f"/api/suppliers/{fake_id}", headers=headers)
        assert resp.status_code == 404

    def test_delete_supplier_requires_auth(self, client, seeded_db):
        supplier_id = str(seeded_db["supplier1"].id)
        resp = client.delete(f"/api/suppliers/{supplier_id}")
        assert resp.status_code == 401


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
