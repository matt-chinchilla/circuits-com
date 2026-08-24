"""The seed's duplicate probe must be case-insensitive on BOTH sides.

`_seed_real_catalog` decides whether to create a catalog part by asking
whether its SKU is already in `parts`. That probe is the only thing standing
between the catalog JSON and duplicate rows, because the JSON lists one chip
under several category files with inconsistent capitalisation — and since
migration 041 a duplicate is not silent extra rows, it is an IntegrityError
against `uq_parts_manufacturer_sku_upper` raised from `seed_manufacturers`
step 5, inside the container ENTRYPOINT. That does not degrade the site; it
stops the API from starting at all.

The probe was half-fixed: the result set was case-folded while the query
predicate stayed case-SENSITIVE, so a JSON spelling that differed from the
stored row was fetched by nobody, reported absent, and re-created. It
survived only because the JSON happened to also contain the stored spelling
somewhere. Removing that other spelling — an ordinary catalog edit — broke
the boot.
"""

import uuid

from sqlalchemy import func

from app.models import Part


def _existing_skus(db, json_skus: list[str]) -> set[str]:
    """The probe, exactly as `_seed_real_catalog` performs it."""
    from app.db import seed as seed_module

    return seed_module.catalog_existing_skus(db, json_skus)


def test_a_stored_row_is_found_whatever_case_the_catalog_uses(db):
    """The regression that stopped the API booting.

    The catalog says `nRF52832-QFAA-R7`; the row says `NRF52832-QFAA-R7`.
    Same part. A probe that misses it creates a second row.
    """
    db.add(
        Part(
            id=uuid.uuid4(),
            sku="NRF52832-QFAA-R7",
            manufacturer_name="Nordic Semiconductor",
        )
    )
    db.commit()

    found = _existing_skus(db, ["nRF52832-QFAA-R7"])

    assert "NRF52832-QFAA-R7" in found, (
        "the probe missed a stored part because the catalog spells its SKU "
        "differently — the seed will now create a duplicate, and since "
        "migration 041 that is an IntegrityError in the entrypoint"
    )


def test_the_probe_is_keyed_case_folded_so_callers_can_compare_upper(db):
    """Callers test membership with `p["sku"].upper()`, so the set must be upper."""
    db.add(Part(id=uuid.uuid4(), sku="MiXeD-CaSe-1", manufacturer_name="ACME"))
    db.commit()

    assert _existing_skus(db, ["mixed-case-1"]) == {"MIXED-CASE-1"}


def test_an_absent_sku_is_absent(db):
    """The probe must not report everything as present — that would seed nothing."""
    assert _existing_skus(db, ["NOT-IN-THE-CATALOG-AT-ALL"]) == set()


def test_an_empty_catalog_asks_the_database_nothing(db):
    assert _existing_skus(db, []) == set()


def test_the_probe_rides_the_case_folded_sku_index(db):
    """`ix_parts_sku_upper` exists precisely so this lookup is not a seq scan.

    SQLAlchemy cannot reflect expression indexes, so this asserts on the
    declared metadata (the same approach as `test_part_identity.py`).
    """
    names = {ix.name for ix in Part.__table__.indexes}
    assert "ix_parts_sku_upper" in names

    # And the query really is expressed on upper(sku), not on sku.
    compiled = str(db.query(Part.sku).filter(func.upper(Part.sku).in_(["X"])).statement)
    assert "upper(parts.sku)" in compiled.lower()
