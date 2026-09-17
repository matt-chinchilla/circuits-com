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


def test_load_reconciles_breaks_instead_of_replacing_them():
    """2026-08-28 rework: the loader used to DELETE + re-INSERT every price
    break on every pass (~850k row-ops and ~1/2 GB WAL for a no-op pull —
    the importer's pre-reconciler disease). The blanket per-listing delete
    must not come back; deletes are id-targeted diffs only."""
    src = (SCRIPTS / "catalog_load.py").read_text()
    assert ".delete()" not in src, (
        "a Query.delete() in the loader is the wholesale-replace pattern — "
        "reconcile rung-by-rung instead"
    )
    assert "PriceBreak.id.in_" in src, "break deletes must target diffed ids"


def test_load_keys_parts_on_the_real_identity():
    """Part identity is (manufacturer, case-folded MPN) — test_part_identity's
    49 cross-manufacturer MPN pairs are REAL distinct products, and the old
    sku-only key folded each pair into one row and cross-wrote it on every
    pull. The loader must key through canon(manufacturer_name) + upper(sku)."""
    src = (SCRIPTS / "catalog_load.py").read_text()
    assert "from app.services.manufacturer_canon import canon" in src
    assert "def part_identity" in src and "canon(" in src and ".upper()" in src


def test_neither_side_carries_the_founder_flag():
    """`suppliers.founder` (054) is PER-ENVIRONMENT operational state, not
    catalog data: the owner sets it on prod, and `circuits push` upserts an
    existing supplier field by field (catalog_load's supplier branch walks
    rec.items() and setattr's each column). A local DB where every row is
    false would therefore overwrite prod's founding distributors on the next
    push. Skipped on BOTH sides — at the source so it never travels, and at
    the boundary so an export file written before this fix still loads."""
    export = (SCRIPTS / "catalog_export.py").read_text()
    supplier_line = next(
        line for line in export.splitlines() if '"t": "supplier"' in line and "row_dict(" in line
    )
    # The exact tuple, not just the substring: a regression that re-adds the
    # flag alongside the skip (`**row_dict(row, skip=("id", "manufacturer_id")),
    # "founder": row["founder"]`) still has "founder" somewhere on the line.
    assert 'skip=("id", "manufacturer_id", "founder")' in supplier_line, (
        "the supplier row_dict must skip founder — per-environment state, not "
        f"a natural key: {supplier_line.strip()}"
    )

    load = (SCRIPTS / "catalog_load.py").read_text()
    assert '"founder"' in load.split("SUPPLIER_SKIP =")[1].split("\n")[0], (
        "SUPPLIER_SKIP must drop founder so an old export cannot clobber "
        "prod's flags"
    )
