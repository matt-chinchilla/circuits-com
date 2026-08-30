"""The manufacturer backfill must survive twin rows (hardened 2026-08-30).

The step-5 backfill links unlinked parts to their canon-resolved maker. An
unlinked TWIN — same sku and maker as a row already linked, legal under
uq_parts_manufacturer_sku_upper only because NULL manufacturer_id compares
distinct — made that UPDATE collide and CRASH THE BOOT: the seed runs on
every container start, so one twin row crash-looped the api (2026-08-27,
six twins fixed by hand; 2026-08-28, forty-eight more existed; 2026-08-30 it
bit again during the prerender work). Twins now stay unlinked on purpose —
linking is not the tool that merges duplicate rows — and are counted out
loud as parts_collision_skipped.

The identity index is model-declared, so SQLite reproduces the collision
faithfully: reverting the ~collides filter makes the survival test die with
IntegrityError, which is this suite's mutation proof.
"""

import csv
import uuid

from app.db.seed_manufacturers import seed_manufacturers
from app.models import Manufacturer, Part


def _csv(tmp_path, companies):
    p = tmp_path / "manufacturers.csv"
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["Company", "URL", "Logo", "Number of parts"])
        w.writeheader()
        for name in companies:
            w.writerow({"Company": name, "URL": "", "Logo": "", "Number of parts": "1"})
    return p


def _part(db, sku, maker_name, category, manufacturer_id=None):
    part = Part(
        id=uuid.uuid4(),
        sku=sku,
        slug=sku.lower(),
        manufacturer_name=maker_name,
        manufacturer_id=manufacturer_id,
        category_id=category.id,
    )
    db.add(part)
    db.flush()
    return part


def test_a_twin_row_no_longer_crash_loops_the_boot(db, seeded_db, tmp_path):
    """The exact production shape: a linked original, an unlinked twin with
    the same sku in a different case, and an innocent unlinked sibling. The
    seed must finish, link the sibling, and leave the twin alone."""
    path = _csv(tmp_path, ["Nordic Semiconductor"])
    seed_manufacturers(db, csv_path=path)
    db.commit()
    maker = (
        db.query(Manufacturer)
        .filter(Manufacturer.canonical_key == "nordic semiconductor")
        .one()
    )
    child = seeded_db["child"]
    original = _part(db, "NRF52840-QIAA-R7", "Nordic Semiconductor", child, manufacturer_id=maker.id)
    twin = _part(db, "nRF52840-QIAA-R7", "Nordic Semiconductor", child)  # unlinked
    innocent = _part(db, "NRF9160-SIAA-R7", "Nordic Semiconductor", child)  # unlinked, no twin
    db.commit()

    counts = seed_manufacturers(db, csv_path=path)  # would raise IntegrityError before the fix
    db.commit()
    db.expire_all()

    assert db.query(Part).filter(Part.id == innocent.id).one().manufacturer_id == maker.id
    assert db.query(Part).filter(Part.id == twin.id).one().manufacturer_id is None
    assert db.query(Part).filter(Part.id == original.id).one().manufacturer_id == maker.id
    assert counts["parts_collision_skipped"] == 1


def test_a_clean_catalog_reports_zero_skipped(db, seeded_db, tmp_path):
    path = _csv(tmp_path, ["Nordic Semiconductor"])
    seed_manufacturers(db, csv_path=path)
    db.commit()
    _part(db, "NRF9160-SIAA-R7", "Nordic Semiconductor", seeded_db["child"])
    db.commit()

    counts = seed_manufacturers(db, csv_path=path)

    assert counts["parts_backfilled"] == 1
    assert counts["parts_collision_skipped"] == 0
