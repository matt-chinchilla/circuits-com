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

2026-08-25: the census itself was caught certifying two lies. `users` was
declared reseeded-from-source — but seed.py rebuilds exactly four STAFF rows
and has never created a customer, so a reseed destroyed every registered
account. And the calendar restore's safety was argued from `created_by_id`
being ON DELETE SET NULL — which governs a later delete of the referenced row
and does nothing for an INSERT naming a row that no longer exists (measured:
the straight load died on the FK with psql exit 3 and restored ZERO events).
So declarations below are no longer just listed: they are checked against what
deploy.sh and seed.py actually do.
"""

import re
import uuid
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
# the POINT of a reseed. (Honesty notes: `parts`/`part_listings`/`price_breaks`
# come back only as far as the catalog JSON goes — every feed-imported part
# beyond it (~171k on prod) is destroyed, recoverable only from the full -Fc
# safety dump deploy_reseed now takes first. `users` and `supplier_feeds` were
# both listed here until 2026-08-25; both declarations were FALSE — the seed
# rebuilds exactly four staff accounts and has never written a supplier_feeds
# row.)
RESEEDED_FROM_SOURCE = {
    "categories",
    "category_suppliers",
    "part_listings",
    "parts",
    "price_breaks",
    "revenue",
    "sponsors",
    "suppliers",
}

# Wiped by the TRUNCATE and NOT rebuilt — deploy_reseed dumps each one before
# the TRUNCATE (`dump_marker` is how it is dumped) and restores it from `file`
# in the `restored` phase. `users` is the keystone and MUST come back
# before_seed: seed.py's _seed_admin_user keys on username, so the seed ADOPTS
# the restored staff rows (uuids, bcrypt hashes intact) instead of colliding
# with them, customers come back whole, and every after_seed restore's user
# ids then resolve.
CARRIED_BY_HAND = {
    "users": {
        "file": "/tmp/users-backup.sql",
        "restored": "before_seed",
        "dump_marker": "--table=users",
    },
    "calendar_events": {
        "file": "/tmp/calendar-backup.sql",
        "restored": "after_seed",
        "dump_marker": "--table=calendar_events",
    },
    "calendar_reminder_sends": {
        "file": "/tmp/calendar-backup.sql",
        "restored": "after_seed",
        "dump_marker": "--table=calendar_reminder_sends",
    },
    "messages": {
        "file": "/tmp/messages-backup.sql",
        "restored": "after_seed",
        "dump_marker": "--table=messages",
    },
    "bom_shares": {
        "file": "/tmp/bom-shares-backup.sql",
        "restored": "after_seed",
        "dump_marker": "--table=bom_shares",
    },
    "supplier_feeds": {
        "file": "/tmp/feeds-backup.tsv",
        "restored": "after_seed",
        "dump_marker": "FROM supplier_feeds f",
    },
}

# Wiped, not rebuilt, not backed up individually — deliberate. activity_events
# is operational history (feed-run lines, admin actions) keyed to supplier
# uuids the seed re-mints; carrying it would leave rows saying "something
# happened to a supplier that no longer exists". It IS inside the full -Fc
# safety dump. bom_shares moved OUT of here 2026-08-25: with users carried, a
# customer's saved BOM links restore cleanly, and "accepted loss" only ever
# made sense while their account died anyway.
ACCEPTED_LOSSES = {"activity_events"}


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


def test_carried_tables_are_dumped_before_the_truncate_and_restored_in_their_phase():
    """Order is the whole trick — and `users` is the special case that makes
    the rest work. Dumping after the TRUNCATE dumps nothing. Restoring users
    AFTER the seed collides with the freshly minted staff rows on username and
    lower(email); restoring them BETWEEN the TRUNCATE and the seed lets
    _seed_admin_user ADOPT them, so every after_seed restore's user ids
    resolve. Everything else points at users (or, for supplier_feeds, at the
    reseeded suppliers) and must come back after the seed."""
    reseed = _deploy_reseed_body()
    truncate_at = reseed.index("TRUNCATE sponsors")
    seed_at = reseed.index("app.db.seed")
    assert reseed.index("pre-reseed-safety.dump") < truncate_at, (
        "the full -Fc safety dump must run while there is still data to dump"
    )
    for table, spec in sorted(CARRIED_BY_HAND.items()):
        assert spec["dump_marker"] in reseed, (
            f"{table} is in the reseed cascade and is not rebuilt by the seed, "
            f"but deploy_reseed never dumps it — a --reseed drops every row"
        )
        assert reseed.count(spec["file"]) >= 2, (
            f"{table}'s staging file must appear at least twice: dumped into, restored from"
        )
        assert reseed.index(spec["file"]) < truncate_at, (
            f"{table} is backed up after the TRUNCATE has already emptied it"
        )
        restore_at = reseed.rindex(spec["file"])
        if spec["restored"] == "before_seed":
            assert truncate_at < restore_at < seed_at, (
                f"{table} must be restored BETWEEN the TRUNCATE and the seed — "
                "restored after it, its unique keys collide with the seed's fresh rows"
            )
        else:
            assert restore_at > seed_at, (
                f"{table} is restored before the seed recreates the rows its FKs point at"
            )


def test_the_messages_restore_keeps_user_ids_that_resolve_and_nulls_the_rest():
    """Users come back with their uuids intact BEFORE messages, so message
    ownership now genuinely survives a reseed. The NULL-where-unresolvable
    guard stays as the safety net for a row minted in the seconds between the
    dumps: NULL means the shared staff inbox, which beats dropping the row or
    aborting half-restored."""
    reseed = _deploy_reseed_body()
    assert reseed.rindex("/tmp/users-backup.sql") < reseed.rindex("/tmp/messages-backup.sql"), (
        "messages must be restored after users, or every restored user_id NULLs out"
    )
    assert "UPDATE public.messages m SET user_id = NULL" in reseed
    assert "DROP CONSTRAINT IF EXISTS fk_messages_user_id" in reseed
    assert "ADD CONSTRAINT fk_messages_user_id" in reseed, (
        "the constraint must go back on — re-adding it re-validates every restored row"
    )
    assert reseed.count("ON_ERROR_STOP") >= 2, "a half-restored inbox must fail loudly"


def test_the_calendar_restore_does_not_trust_on_delete_set_null():
    """A comment once asserted that created_by_id being ON DELETE SET NULL made
    the calendar restore a straight psql load. ON DELETE governs a later
    delete of the referenced ROW; it does nothing for an INSERT naming a row
    that no longer exists. Measured on the real schema: the straight load died
    on calendar_events_created_by_id_fkey (psql exit 3) and restored ZERO
    events, because the seed re-mints every user uuid. Two defenses now,
    either one sufficient: users are restored before the calendar with their
    uuids intact, and the load carries the same NULL-where-unresolvable guard
    the messages restore uses — which IS the column's declared semantics."""
    reseed = _deploy_reseed_body()
    assert reseed.rindex("/tmp/users-backup.sql") < reseed.rindex("/tmp/calendar-backup.sql"), (
        "the calendar must be restored after users, or attribution dies on the FK"
    )
    assert "DROP CONSTRAINT IF EXISTS calendar_events_created_by_id_fkey" in reseed
    assert "UPDATE public.calendar_events e SET created_by_id = NULL" in reseed
    assert "ADD CONSTRAINT calendar_events_created_by_id_fkey" in reseed
    assert "ON DELETE SET NULL" in reseed, (
        "the re-added constraint must keep the column's declared delete semantics"
    )


def test_the_users_restore_carries_customers_and_relinks_suppliers_by_name():
    """seed.py rebuilds exactly the four staff rows and creates NO customer
    accounts, so declaring `users` reseeded-from-source certified the loss of
    every registered customer — login, password hash, and everything keyed to
    their uuid. The restore must (a) load under the dropped supplier FK, since
    suppliers is EMPTY at that instant and any kept supplier_id aborts the
    COPY, (b) NULL those links, (c) re-add the constraint so it re-validates,
    and (d) relink BY SUPPLIER NAME after the seed — the uuid links are
    unrecoverable because the seed mints new supplier uuids."""
    assert "users" not in RESEEDED_FROM_SOURCE
    assert CARRIED_BY_HAND["users"]["restored"] == "before_seed"
    reseed = _deploy_reseed_body()
    assert "DROP CONSTRAINT IF EXISTS users_supplier_id_fkey" in reseed
    assert "UPDATE public.users u SET supplier_id = NULL" in reseed
    assert "ADD CONSTRAINT users_supplier_id_fkey" in reseed
    assert "s.name = l.supplier_name" in reseed, "the relink must key on supplier NAME"
    assert reseed.rindex("user-supplier-links.tsv") > reseed.index("app.db.seed"), (
        "the relink needs the seeded suppliers to exist"
    )


def test_the_feed_config_is_rekeyed_by_supplier_name():
    """supplier_feeds' PRIMARY KEY is the supplier uuid and every supplier uuid
    changes on a reseed, so a uuid-keyed pg_dump carry can never restore it —
    and the census used to declare it reseeded-from-source, which seed.py has
    never done. Losing it meant every "Nightly auto-import" toggle silently
    turned OFF and every import cursor died. It travels as (supplier NAME,
    config) and is re-keyed onto the reseeded suppliers; rows whose supplier
    the seed no longer creates are dropped with the supplier itself."""
    seed_src = (REPO_ROOT / "api" / "app" / "db" / "seed.py").read_text()
    assert "supplier_feed" not in seed_src.lower(), (
        "seed.py now writes supplier_feeds — move it to RESEEDED_FROM_SOURCE "
        "and retire the name-keyed carry"
    )
    reseed = _deploy_reseed_body()
    assert "--table=supplier_feeds" not in reseed, (
        "a uuid-keyed pg_dump of supplier_feeds cannot restore onto re-minted suppliers"
    )
    assert "FROM supplier_feeds f" in reseed  # the name-keyed COPY dump
    assert "JOIN public.suppliers s ON s.name = r.supplier_name" in reseed
    assert "auto_import_enabled" in reseed
    assert "import_cursor" in reseed
    assert reseed.rindex("feeds-backup.tsv") > reseed.index("app.db.seed")


def test_the_seed_adopts_restored_users_instead_of_recreating_them(db):
    """The users carry works ONLY because _seed_admin_user keys on username:
    a restored staff row is adopted (uuid and bcrypt hash kept, the declared
    role re-asserted) and customer rows are left alone. If the seed ever
    switches to delete-and-recreate, the carry silently reverts to destroying
    every uuid the later restores point at — this goes red first."""
    from app.db.seed import _seed_admin_user
    from app.models import User

    staff_id = uuid.uuid4()
    customer_id = uuid.uuid4()
    db.add(
        User(
            id=staff_id,
            username="matthew",
            email="matthew@circuitcenter.ai",
            password_hash="$2b$12$prod-hash-carried-across",
            role="admin",
        )
    )
    db.add(
        User(
            id=customer_id,
            username="customer@example.com",
            email="customer@example.com",
            password_hash="$2b$12$x",
            role="user",
        )
    )
    db.flush()

    _seed_admin_user(db)

    matthew = db.query(User).filter(User.username == "matthew").one()
    assert matthew.id == staff_id, "the seed re-minted matthew instead of adopting the restored row"
    assert matthew.password_hash == "$2b$12$prod-hash-carried-across"
    assert matthew.role == "owner", "the seed-declared role invariant must still self-heal"
    assert db.query(User).filter(User.id == customer_id).count() == 1
    assert db.query(User).count() == 5  # four staff + the customer, no duplicates


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


# ── The destructive-operation gate ──────────────────────────────────────────
# `--reseed` destroys every feed-imported part: nothing in any seed source can
# recreate them. That hazard was once recorded ONLY as a comment in deploy.sh
# ("~171k on prod — think hard before running this there") and nothing enforced
# it — one flag, no questions, 198,577 parts gone. These pin the gate that
# replaced the comment.


def test_reseed_asks_before_it_destroys():
    """deploy_reseed must call the confirmation gate BEFORE the TRUNCATE.

    Ordering IS the assertion: a confirmation that runs after the truncate is
    not a confirmation, it is an apology.
    """
    body = _deploy_reseed_body()
    assert "confirm_reseed" in body, (
        "deploy_reseed no longer calls confirm_reseed — --reseed would destroy "
        "the feed-imported catalog with no prompt, which is how 198,577 parts "
        "were lost once already."
    )
    # Anchor on the STATEMENT, not the word: deploy_reseed's own comment
    # explains TRUNCATE semantics dozens of lines before it runs one.
    assert body.index("confirm_reseed") < body.index("TRUNCATE sponsors"), (
        "confirm_reseed must run BEFORE the TRUNCATE, not after it."
    )


def test_the_gate_requires_typing_the_measured_count():
    """A y/N prompt is muscle memory; typing the number requires reading it.

    The number must be MEASURED against the live database and against what the
    seed can actually put back — a literal baked into the script would go stale
    and understate the loss.
    """
    deploy = REPO_ROOT / "deploy.sh"
    if not deploy.exists():
        pytest.skip("deploy.sh not present (running outside a repo checkout)")
    body = deploy.read_text()
    start = body.index("confirm_reseed()")
    gate = body[start : body.index("\ndeploy_reseed()", start)]

    assert "SELECT count(*) FROM parts" in gate, (
        "the gate must COUNT the live catalog, not print a hardcoded figure"
    )
    assert "catalog_data" in gate, (
        "the gate must count what the seed can put back, or the number it "
        "quotes is the wrong number"
    )
    assert "read -r" in gate, "the gate must actually wait for input"
    assert "exit 0" in gate, "a mismatched answer must cancel, not continue"


def test_the_gate_writes_the_undo_before_destroying_anything():
    body = _deploy_reseed_body()
    assert "pre-reseed-safety.dump" in body
    assert body.index("pre-reseed-safety.dump") < body.index("TRUNCATE sponsors"), (
        "the safety dump must be written BEFORE the TRUNCATE — it is the only "
        "route back for the parts that nothing else carries"
    )


# ── `circuits pull --users` ─────────────────────────────────────────────────
# The mode is additive and CUSTOMER-ONLY. Widening it into a plain `users` copy
# would (a) overwrite local staff password hashes with prod's, locking the
# developer out of their own console, and (b) re-mint local user uuids, orphaning
# every local messages.user_id / calendar_events.created_by_id / bom_shares.user_id
# that points at them. These pin the four properties that keep it safe.


def _pull_script() -> str:
    script = REPO_ROOT / "pull-prod-data.sh"
    if not script.exists():
        pytest.skip("pull-prod-data.sh not present")
    return script.read_text()


def _users_mode() -> str:
    body = _pull_script()
    start = body.index('if [[ "$MODE" == "--users" ]]')
    return body[start : body.index('\necho "done."', start)]


def test_the_users_pull_is_not_part_of_the_default_run():
    """It carries real addresses and password hashes onto a dev machine, so it
    must be asked for explicitly — never swept in by a bare `circuits pull`."""
    mode = _users_mode()
    assert '"$MODE" == "--all"' not in mode.split("\n")[0], (
        "--users must not run under --all; it has to be opt-in per invocation"
    )


def test_the_users_pull_takes_customers_only():
    mode = _users_mode()
    assert "WHERE u.role = 'user'" in mode, (
        "the export must filter to customers — pulling staff rows would "
        "overwrite local admin password hashes with production's"
    )


def test_the_users_pull_cannot_overwrite_a_staff_row():
    """The UPDATE needs role='user' on the LOCAL side too.

    Without it, a customer who registered on prod using a staff address would
    match that local staff row on email and overwrite its password hash.
    """
    mode = _users_mode()
    update = mode[mode.index("UPDATE users u SET username") :]
    update = update[: update.index("INSERT INTO users")]
    assert "u.role = 'user'" in update, (
        "the upsert must restrict itself to local customer rows"
    )


def test_the_users_pull_matches_on_the_indexed_expression():
    """lower(email) is what uq_users_email_lower covers, so at most one local
    row can ever match — and an existing row keeps its uuid, which is what lets
    local messages stay attached to it."""
    mode = _users_mode()
    assert "lower(u.email) = lower(i.email)" in mode


def test_the_users_pull_carries_company_links_by_name():
    """supplier_id / manufacturer_id are per-environment surrogates — the whole
    catalog transfer pair is natural-key based for this reason — so a pulled
    uuid would point at nothing locally."""
    mode = _users_mode()
    assert "JOIN suppliers s ON s.name = i.supplier_name" in mode
    assert "JOIN manufacturers m ON m.name = i.manufacturer_name" in mode
    # And the export sends the NAMES, not the ids it resolved them from.
    export = mode[mode.index("COPY (") : mode.index(") TO STDOUT")]
    assert "s.name, m.name" in export
    assert "u.supplier_id," not in export
