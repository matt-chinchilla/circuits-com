"""Guards for the prod→local catalog transfer pair (scripts/catalog_*.py).

THE BUG (2026-08-21): migration 036 added parts.manufacturer_id and
suppliers.manufacturer_id — FKs into a table whose UUIDs are minted PER
DATABASE. catalog_export.py serializes columns generically, so the surrogate
started traveling and the load died on parts_manufacturer_id_fkey. The
scripts' own contract is NATURAL keys ("UUIDs differ per environment"), and
seed_manufacturers step 5 re-links parts by name wherever manufacturer_id is
NULL — so both sides must simply never carry the column. These tests parse
the scripts rather than importing them (both run their work at module top
level)."""

from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def test_export_never_ships_the_manufacturer_surrogate():
    src = (SCRIPTS / "catalog_export.py").read_text()
    for line in src.splitlines():
        if "row_dict(" in line and "def " not in line:
            assert "manufacturer_id" in line, (
                "every row_dict call must skip manufacturer_id — it is a "
                f"per-environment surrogate, not a natural key: {line.strip()}"
            )


def test_load_refuses_a_manufacturer_surrogate_from_old_exports():
    src = (SCRIPTS / "catalog_load.py").read_text()
    assert '"manufacturer_id"' in src.split("PART_SKIP =")[1].split("\n")[0], (
        "PART_SKIP must drop manufacturer_id so a pre-fix export file still "
        "loads (defense at the boundary, not only at the source)"
    )
    assert "SUPPLIER_SKIP" in src and '"manufacturer_id"' in src.split("SUPPLIER_SKIP =")[1].split("\n")[0], (
        "supplier upserts must skip manufacturer_id too — suppliers carry the "
        "same FK plus the uq_suppliers_manufacturer partial-unique index"
    )
