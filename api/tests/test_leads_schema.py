"""Schema invariants for the Manufacturers/Leads tables (migration 036), and
the reseed-cascade census that guards the whole schema.

The FK-DIRECTION tests are the load-bearing ones: deploy.sh --reseed TRUNCATEs
suppliers CASCADE, and TRUNCATE CASCADE is TABLE-level and TRANSITIVE — it
follows every REFERENCING foreign key and ignores ON DELETE entirely. Sales
data survives a reseed because no CRM table points into the truncate graph.

That per-table check was not enough. Migration 043 added messages.user_id ->
users(id); users has been inside the cascade all along (users.supplier_id ->
suppliers), so `messages` silently joined it and a routine reseed destroyed
every contact, join and keyword-request the public had ever sent. Nothing
failed, because this file only ever looked at the five CRM tables. So the
census below walks the cascade over the ENTIRE metadata and demands that every
member be DECLARED — reseeded from source, carried across by hand in
deploy.sh, or a named accepted loss. A new foreign key that drags a table in
now fails here until somebody decides which of the three it is.
"""

import re
from collections import defaultdict
from pathlib import Path

import pytest

import app.models  # noqa: F401  — registers every table on Base.metadata
from app.db.session import Base

REPO_ROOT = Path(__file__).resolve().parents[2]

PROTECTED = {"suppliers", "users", "categories", "sponsors", "parts", "category_suppliers"}
NEW_TABLES = [
    "manufacturers",
    "manufacturer_aliases",
    "manufacturer_merge_candidates",
    "leads",
    "lead_contacts",
]

# The exact statement deploy_reseed runs.
TRUNCATE_ROOTS = {"sponsors", "category_suppliers", "categories", "suppliers"}

# Wiped by the TRUNCATE and rebuilt by `python -m app.db.seed`. Losing these is
# the POINT of a reseed.
RESEEDED_FROM_SOURCE = {
    "categories",
    "category_suppliers",
    "part_listings",
    "parts",
    "price_breaks",
    "revenue",
    "sponsors",
    "suppliers",
    "supplier_feeds",
    "users",
}

# Wiped by the TRUNCATE and NOT rebuilt — so deploy_reseed pg_dumps them before
# and restores them after the seed. Value = the file it stages them in.
CARRIED_BY_HAND = {
    "calendar_events": "/tmp/calendar-backup.sql",
    "calendar_reminder_sends": "/tmp/calendar-backup.sql",
    "messages": "/tmp/messages-backup.sql",
}

# Wiped, not rebuilt, not backed up — known, pre-existing, and deliberately not
# adjudicated here. `activity_events` is admin feed history; `bom_shares` has
# been in the cascade since migration 038 and shared BOM links die on a reseed.
# Listed so they cannot be confused with a NEW entrant.
ACCEPTED_LOSSES = {"activity_events", "bom_shares"}


def _truncate_cascade_closure(metadata=None) -> set[str]:
    """Every table `TRUNCATE <roots> CASCADE` reaches, by the same rule Postgres
    uses: walk REFERENCING foreign keys transitively, ignoring ON DELETE."""
    metadata = metadata or Base.metadata
    referencing = defaultdict(set)
    for table in metadata.tables.values():
        for fk in table.foreign_keys:
            referencing[fk.column.table.name].add(table.name)
    reached = set(TRUNCATE_ROOTS)
    stack = list(TRUNCATE_ROOTS)
    while stack:
        for child in referencing[stack.pop()]:
            if child not in reached:
                reached.add(child)
                stack.append(child)
    return reached


def _deploy_reseed_body() -> str:
    deploy = REPO_ROOT / "deploy.sh"
    if not deploy.exists():
        pytest.skip("deploy.sh not present (running outside a repo checkout)")
    body = deploy.read_text()
    start = body.index("deploy_reseed()")
    return body[start : body.index("\n}", start)]


def test_new_tables_exist():
    for t in NEW_TABLES:
        assert t in Base.metadata.tables, t


def test_reseed_fk_isolation():
    for t in NEW_TABLES:
        for fk in Base.metadata.tables[t].foreign_keys:
            target = fk.column.table.name
            assert target not in PROTECTED, f"{t} -> {target} joins the TRUNCATE graph"


def test_bridge_direction_and_delete_behavior():
    fks = [
        fk
        for fk in Base.metadata.tables["suppliers"].foreign_keys
        if fk.column.table.name == "manufacturers"
    ]
    assert len(fks) == 1
    assert fks[0].ondelete == "SET NULL"


def test_parts_bridge():
    fks = [
        fk
        for fk in Base.metadata.tables["parts"].foreign_keys
        if fk.column.table.name == "manufacturers"
    ]
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
    uniques = [
        c
        for c in m.constraints
        if getattr(c, "columns", None) and {col.name for col in c.columns} == {"canonical_key"}
    ]
    unique_ix = [
        i for i in m.indexes if i.unique and {col.name for col in i.columns} == {"canonical_key"}
    ]
    assert uniques or unique_ix, "canonical_key must be UNIQUE via __table_args__ (SQLite parity)"


def test_lead_source_key_unique():
    lead = Base.metadata.tables["leads"]
    uniques = [
        c
        for c in lead.constraints
        if getattr(c, "columns", None) and {col.name for col in c.columns} == {"source_key"}
    ]
    unique_ix = [
        i for i in lead.indexes if i.unique and {col.name for col in i.columns} == {"source_key"}
    ]
    assert uniques or unique_ix


# ── The reseed cascade census ───────────────────────────────────────────────


def test_every_table_in_the_reseed_cascade_is_declared():
    """A new FK into the truncate graph must be a deliberate decision.

    Migration 043 made this test's absence expensive: messages.user_id put the
    public inbox in the cascade and nothing said so.
    """
    reached = _truncate_cascade_closure()
    declared = RESEEDED_FROM_SOURCE | set(CARRIED_BY_HAND) | ACCEPTED_LOSSES
    undeclared = reached - declared
    assert not undeclared, (
        f"{sorted(undeclared)} joined the `TRUNCATE {', '.join(sorted(TRUNCATE_ROOTS))} "
        "CASCADE` graph via a new foreign key. A reseed now DELETES every row. "
        "Decide which it is and say so here: reseeded from source, carried "
        "across by hand in deploy.sh's deploy_reseed (dump before the TRUNCATE, "
        "restore after the seed), or an accepted loss."
    )
    stale = declared - reached
    assert not stale, f"{sorted(stale)} is declared but no longer in the cascade — prune it"


def test_the_cascade_walk_actually_finds_a_new_dependant():
    """Teeth check: the walk must be transitive, not one hop.

    Built on a throwaway MetaData so it proves the algorithm rather than
    restating the live schema.
    """
    import sqlalchemy as sa

    md = sa.MetaData()
    sa.Table("suppliers", md, sa.Column("id", sa.Integer, primary_key=True))
    sa.Table(
        "users",
        md,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("supplier_id", sa.Integer, sa.ForeignKey("suppliers.id")),
    )
    # Two hops from a root, and ON DELETE SET NULL — which CASCADE ignores.
    sa.Table(
        "somebodys_new_table",
        md,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="SET NULL")),
    )
    sa.Table("unrelated", md, sa.Column("id", sa.Integer, primary_key=True))

    reached = _truncate_cascade_closure(md)
    assert "somebodys_new_table" in reached
    assert "unrelated" not in reached


def test_carried_tables_are_dumped_before_the_truncate_and_restored_after_the_seed():
    """Order is the whole trick: restoring before the seed fails the FKs the
    restored rows point at, and dumping after the TRUNCATE dumps nothing."""
    reseed = _deploy_reseed_body()
    truncate_at = reseed.index("TRUNCATE sponsors")
    seed_at = reseed.index("app.db.seed")
    for table, backup_file in sorted(CARRIED_BY_HAND.items()):
        assert f"--table={table}" in reseed, (
            f"{table} is in the reseed cascade and is not rebuilt by the seed, "
            f"but deploy_reseed never pg_dumps it — a --reseed drops every row"
        )
        assert reseed.index(backup_file) < truncate_at, (
            f"{table} is backed up after the TRUNCATE has already emptied it"
        )
        assert reseed.rindex(backup_file) > seed_at, (
            f"{table} is restored before the seed recreates the rows its FKs point at"
        )


def test_the_messages_restore_nulls_user_ids_that_no_longer_resolve():
    """The seed mints new user uuids and never recreates CUSTOMER accounts, so
    a straight restore dies on messages.user_id and puts back NOTHING. NULL
    means the shared staff inbox — the honest fallback. Dropping the row is
    not."""
    reseed = _deploy_reseed_body()
    assert "SET user_id = NULL" in reseed
    assert "DROP CONSTRAINT IF EXISTS fk_messages_user_id" in reseed
    assert "ADD CONSTRAINT fk_messages_user_id" in reseed, (
        "the constraint must go back on — re-adding it re-validates every restored row"
    )
    assert reseed.count("ON_ERROR_STOP") >= 2, "a half-restored inbox must fail loudly"


def test_the_reporting_pull_survives_the_same_foreign_key():
    """`circuits pull --reporting` TRUNCATEs the local messages table and
    reloads prod's. Prod user rows are not local rows, so an unguarded COPY
    aborts on the FK — and psql exits 0 without ON_ERROR_STOP, leaving the
    local table empty and the script reporting success."""
    script = REPO_ROOT / "pull-prod-data.sh"
    if not script.exists():
        pytest.skip("pull-prod-data.sh not present")
    body = script.read_text()
    reporting = body[body.index('"--reporting"') : body.index('"--catalog"')]
    assert "ON_ERROR_STOP=1" in reporting, "a failed reload must not exit 0"
    assert "SET user_id = NULL" in reporting
    assert re.search(r"BEGIN;.*COMMIT;", reporting, re.S), (
        "truncate + reload must be one transaction, or a failure leaves the local inbox empty"
    )
