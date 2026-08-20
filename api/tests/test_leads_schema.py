"""Schema invariants for the Manufacturers/Leads tables (migration 036).

The FK-DIRECTION test is the load-bearing one: deploy.sh --reseed TRUNCATEs
suppliers CASCADE, and TRUNCATE CASCADE follows REFERENCING FKs regardless of
ON DELETE. Sales data survives reseed because no new table points into the
truncate graph — this test is what keeps that true.
"""

from app.db.session import Base

PROTECTED = {"suppliers", "users", "categories", "sponsors", "parts", "category_suppliers"}
NEW_TABLES = ["manufacturers", "manufacturer_aliases", "manufacturer_merge_candidates", "leads", "lead_contacts"]


def test_new_tables_exist():
    for t in NEW_TABLES:
        assert t in Base.metadata.tables, t


def test_reseed_fk_isolation():
    for t in NEW_TABLES:
        for fk in Base.metadata.tables[t].foreign_keys:
            target = fk.column.table.name
            assert target not in PROTECTED, f"{t} -> {target} joins the TRUNCATE graph"


def test_bridge_direction_and_delete_behavior():
    fks = [fk for fk in Base.metadata.tables["suppliers"].foreign_keys if fk.column.table.name == "manufacturers"]
    assert len(fks) == 1
    assert fks[0].ondelete == "SET NULL"


def test_parts_bridge():
    fks = [fk for fk in Base.metadata.tables["parts"].foreign_keys if fk.column.table.name == "manufacturers"]
    assert len(fks) == 1
    assert fks[0].ondelete == "SET NULL"


def test_recorded_by_is_free_string_not_fk():
    col = Base.metadata.tables["lead_contacts"].c.recorded_by
    assert not col.foreign_keys
    assert col.type.length >= 120


def test_length_contracts():
    m = Base.metadata.tables["manufacturers"]
    assert m.c.canonical_key.type.length >= 220
    assert m.c.name.type.length >= 200
    lead = Base.metadata.tables["leads"]
    assert lead.c.source_key.type.length >= 300
    assert lead.c.company_slug.type.length >= 220


def test_canonical_key_unique_in_metadata():
    m = Base.metadata.tables["manufacturers"]
    uniques = [c for c in m.constraints if getattr(c, "columns", None) and {col.name for col in c.columns} == {"canonical_key"}]
    unique_ix = [i for i in m.indexes if i.unique and {col.name for col in i.columns} == {"canonical_key"}]
    assert uniques or unique_ix, "canonical_key must be UNIQUE via __table_args__ (SQLite parity)"


def test_lead_source_key_unique():
    lead = Base.metadata.tables["leads"]
    uniques = [c for c in lead.constraints if getattr(c, "columns", None) and {col.name for col in c.columns} == {"source_key"}]
    unique_ix = [i for i in lead.indexes if i.unique and {col.name for col in i.columns} == {"source_key"}]
    assert uniques or unique_ix
