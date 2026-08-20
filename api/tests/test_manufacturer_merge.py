"""seed_manufacturers — the merge pipeline (synthesis §5.3 steps 1-6).

Contract under test: canon-equality auto-merge ONLY; CSV-internal collisions
preserved as separate rows + review candidate; catalog names attach or create
provisional rows; Microchip USA never-merge; parts.manufacturer_id backfill;
catalog_part_count recompute; strict idempotency.
"""

import csv
import uuid

from app.db.seed_manufacturers import seed_manufacturers
from app.models import Manufacturer, ManufacturerAlias, ManufacturerMergeCandidate, Part


FIXTURE_ROWS = [
    {"Company": "Diodes Incorporated", "URL": "https://www.diodes.com/", "Logo": "", "Number of parts": "5000"},
    {"Company": "Lumissil", "URL": "https://www.lumissil.com/", "Logo": "", "Number of parts": "800"},
    {"Company": "Microchip Technology", "URL": "https://www.microchip.com/", "Logo": "", "Number of parts": "90000"},
    {"Company": "Microchip USA", "URL": "https://www.microchipusa.com/", "Logo": "", "Number of parts": "12"},
    {"Company": "Amphenol", "URL": "https://www.amphenol.com/", "Logo": "", "Number of parts": "40000"},
    {"Company": "Amphenol Ltd", "URL": "https://www.amphenol.co.uk/", "Logo": "", "Number of parts": "300"},
]


def _write_fixture(tmp_path):
    p = tmp_path / "manufacturers.csv"
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["Company", "URL", "Logo", "Number of parts"])
        w.writeheader()
        w.writerows(FIXTURE_ROWS)
    return p


def _add_part(db, sku, mfr, category_id):
    part = Part(id=uuid.uuid4(), sku=sku, manufacturer_name=mfr, category_id=category_id)
    db.add(part)
    return part


def test_full_pipeline(db, seeded_db, tmp_path):
    cat = seeded_db["child"].id
    _add_part(db, "DI-1", "Diodes Inc.", cat)          # canon-attaches to CSV row
    _add_part(db, "DI-2", "Diodes Incorporated", cat)  # same company, exact CSV name
    _add_part(db, "LU-1", "Lumissil (ISSI)", cat)      # distinct canon -> provisional
    db.commit()

    counts = seed_manufacturers(db, csv_path=_write_fixture(tmp_path))

    # CSV rows all landed; Amphenol collision preserved as TWO rows.
    amphenols = db.query(Manufacturer).filter(Manufacturer.name.like("Amphenol%")).all()
    assert len(amphenols) == 2
    keys = {m.canonical_key for m in amphenols}
    assert "amphenol" in keys and any("|" in k for k in keys)
    coll = db.query(ManufacturerMergeCandidate).filter_by(rule="csv-collision").all()
    assert len(coll) == 1

    # Both Diodes spellings resolve to ONE manufacturer; parts backfilled.
    diodes = db.query(Manufacturer).filter_by(canonical_key="diodes").one()
    p1 = db.query(Part).filter_by(sku="DI-1").one()
    p2 = db.query(Part).filter_by(sku="DI-2").one()
    assert p1.manufacturer_id == diodes.id == p2.manufacturer_id
    assert diodes.catalog_part_count == 2

    # Lumissil (ISSI) stays SEPARATE (provisional) + a prefix candidate exists.
    issi = db.query(Manufacturer).filter_by(canonical_key="lumissil issi").one()
    assert issi.source == "catalog"
    lum = db.query(Manufacturer).filter_by(canonical_key="lumissil").one()
    assert issi.id != lum.id
    pref = db.query(ManufacturerMergeCandidate).filter_by(rule="prefix").all()
    assert any("lumissil" in (c.evidence or "").lower() for c in pref)

    # Microchip never-merge rule seeded as a REJECTED candidate.
    never = db.query(ManufacturerMergeCandidate).filter_by(rule="never", status="rejected").all()
    assert len(never) == 1

    # Aliases: one row per accepted raw spelling, globally unique canon.
    alias_canons = [a.alias_canon for a in db.query(ManufacturerAlias).all()]
    assert len(alias_canons) == len(set(alias_canons))
    assert counts["manufacturers_csv"] == 6


def test_idempotent_rerun(db, seeded_db, tmp_path):
    cat = seeded_db["child"].id
    _add_part(db, "DI-1", "Diodes Inc.", cat)
    db.commit()
    path = _write_fixture(tmp_path)
    seed_manufacturers(db, csv_path=path)
    before = (
        db.query(Manufacturer).count(),
        db.query(ManufacturerAlias).count(),
        db.query(ManufacturerMergeCandidate).count(),
    )
    counts2 = seed_manufacturers(db, csv_path=path)
    after = (
        db.query(Manufacturer).count(),
        db.query(ManufacturerAlias).count(),
        db.query(ManufacturerMergeCandidate).count(),
    )
    assert before == after
    assert counts2["manufacturers_created"] == 0


def test_missing_csv_is_quiet(db, seeded_db, tmp_path):
    counts = seed_manufacturers(db, csv_path=tmp_path / "absent.csv")
    assert counts == {}
