"""Manufacturers API — CRUD, promote/link (the sponsor bridge), merge queue."""

import csv

import pytest

from app.db.seed_manufacturers import seed_manufacturers
from app.models import Manufacturer, ManufacturerMergeCandidate, Part, Supplier


@pytest.fixture
def mfr_db(db, seeded_db, tmp_path):
    p = tmp_path / "m.csv"
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["Company", "URL", "Logo", "Number of parts"])
        w.writeheader()
        w.writerow({"Company": "Lumissil", "URL": "https://lumissil.com", "Logo": "", "Number of parts": "10"})
        w.writerow({"Company": "Diodes Incorporated", "URL": "https://diodes.com", "Logo": "", "Number of parts": "20"})
    import uuid

    db.add(Part(id=uuid.uuid4(), sku="LU-9", manufacturer_name="Lumissil (ISSI)",
                category_id=seeded_db["child"].id))
    db.commit()
    seed_manufacturers(db, csv_path=p)
    db.commit()
    return db


def test_list_paginates_and_caps(client, mfr_db, auth_header):
    body = client.get("/api/admin/manufacturers/?per_page=999", headers=auth_header()).json()
    assert body["per_page"] == 100
    assert body["total"] >= 3  # 2 CSV + ≥1 provisional


def test_promote_creates_and_links(client, mfr_db, auth_header):
    m = mfr_db.query(Manufacturer).filter_by(canonical_key="lumissil").one()
    h = auth_header()
    resp = client.post(f"/api/admin/manufacturers/{m.id}/promote", headers=h)
    assert resp.status_code == 200
    sid = resp.json()["supplier_id"]
    sup = mfr_db.query(Supplier).filter_by(name="Lumissil").one()
    assert str(sup.id) == sid and sup.manufacturer_id == m.id
    # second promote → 409 (already linked)
    assert client.post(f"/api/admin/manufacturers/{m.id}/promote", headers=h).status_code == 409
    # delete while linked → 409
    assert client.delete(f"/api/admin/manufacturers/{m.id}", headers=h).status_code == 409
    # detail shows the link
    body = client.get(f"/api/admin/manufacturers/{m.id}", headers=h).json()
    assert body["linked_supplier_name"] == "Lumissil"


def test_link_existing_supplier_and_one_company_one_link(client, mfr_db, auth_header, seeded_db):
    h = auth_header()
    m = mfr_db.query(Manufacturer).filter_by(canonical_key="diodes").one()
    sup = mfr_db.query(Supplier).first()
    resp = client.post(f"/api/admin/manufacturers/{m.id}/link",
                       json={"supplier_id": str(sup.id)}, headers=h)
    assert resp.status_code == 200
    other = mfr_db.query(Manufacturer).filter_by(canonical_key="lumissil").one()
    resp2 = client.post(f"/api/admin/manufacturers/{other.id}/link",
                        json={"supplier_id": str(sup.id)}, headers=h)
    assert resp2.status_code == 409  # supplier already linked


def test_candidate_approve_repoints_parts(client, mfr_db, auth_header):
    h = auth_header()
    lum = mfr_db.query(Manufacturer).filter_by(canonical_key="lumissil").one()
    cand = (
        mfr_db.query(ManufacturerMergeCandidate)
        .filter_by(left_manufacturer_id=lum.id, rule="prefix", status="pending").first()
    )
    assert cand is not None
    resp = client.post(f"/api/admin/manufacturers/candidates/{cand.id}/approve", headers=h)
    assert resp.status_code == 200
    part = mfr_db.query(Part).filter_by(sku="LU-9").one()
    assert part.manufacturer_id == lum.id
    assert mfr_db.query(Manufacturer).filter_by(canonical_key="lumissil issi").first() is None
    lum = mfr_db.query(Manufacturer).filter_by(canonical_key="lumissil").one()
    assert lum.catalog_part_count == 1


def test_create_duplicate_canon_409(client, mfr_db, auth_header):
    resp = client.post("/api/admin/manufacturers/",
                       json={"name": "Diodes Inc."}, headers=auth_header())
    assert resp.status_code == 409
