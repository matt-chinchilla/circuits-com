"""Migration 041 — merge duplicate parts, then lock identity with two constraints.

**Why this file exists at all.** Every other test in this suite runs on SQLite
via ``Base.metadata.create_all``. That harness structurally cannot test a data
migration: it never runs alembic, and the merge is Postgres SQL. So production
data migrations have historically shipped with no automated proof whatsoever.
This is the first Postgres-backed test in the repo, and it exists because the
duplicates 041 cleans up were themselves created silently and sat in production
for months.

**How it stays honest.** It executes the migration's real ``upgrade()`` against
a real Postgres inside a transaction that is ALWAYS rolled back — there is no
second transcription of the SQL that could drift from the shipped one. It runs
against the full local catalog (~175k parts), so the index builds and the merge
are exercised at production volume, and the migration's own effect on the real
duplicate groups is part of what is proven.

Skips cleanly when no local Postgres is up, so `pytest tests/` on a bare
checkout stays green. Refuses outright to run against a non-local host: this
opens a write transaction, and only the rollback keeps it harmless.
"""

from __future__ import annotations

import importlib.util
import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError, OperationalError

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "041_part_identity.py"
)

# The local dev stack (docker-compose maps 5432 with dev-default credentials).
DEFAULT_URL = "postgresql://circuits:circuits@localhost:5432/circuits"
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1", "db")

EPOCH = datetime(2026, 1, 1, tzinfo=UTC)


def _database_url() -> str:
    url = os.environ.get("MIGRATION_TEST_DATABASE_URL", DEFAULT_URL)
    host = url.split("@")[-1].split("/")[0].split(":")[0]
    if host not in LOCAL_HOSTS:
        pytest.fail(
            f"refusing to run the migration harness against {host!r}. It opens a "
            "write transaction and only the rollback makes that safe; point "
            "MIGRATION_TEST_DATABASE_URL at a local database."
        )
    return url


def _load_migration():
    if not MIGRATION_PATH.exists():
        pytest.fail(f"migration not written yet: {MIGRATION_PATH}")
    spec = importlib.util.spec_from_file_location("migration_041", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── fixture world ────────────────────────────────────────────────────────────
#
# One transaction for the whole module: `upgrade()` builds two indexes over the
# full catalog, so running it per-test would pay that cost eleven times. Each
# test still asserts exactly one behaviour, against its own slice of rows.


@pytest.fixture(scope="module")
def conn():
    url = _database_url()
    try:
        engine = create_engine(url)
        connection = engine.connect()
    except OperationalError as exc:  # pragma: no cover - depends on local stack
        pytest.skip(f"no local Postgres for the migration harness: {exc}")
    transaction = connection.begin()
    try:
        yield connection
    finally:
        transaction.rollback()
        connection.close()
        engine.dispose()


def _new_manufacturer(conn, name: str) -> uuid.UUID:
    mid = uuid.uuid4()
    conn.execute(
        text(
            "INSERT INTO manufacturers (id, name, slug, canonical_key, source, "
            "created_at, updated_at) VALUES (:id, :n, :s, :k, 'catalog', now(), now())"
        ),
        {"id": mid, "n": name, "s": f"t-{mid.hex[:12]}", "k": f"t-{mid.hex[:12]}"},
    )
    return mid


def _part(
    conn,
    *,
    sku,
    mfr,
    minutes,
    image=None,
    datasheet=None,
    package=None,
    maker_name="Harness Semiconductor",
) -> uuid.UUID:
    pid = uuid.uuid4()
    conn.execute(
        text(
            "INSERT INTO parts (id, sku, slug, manufacturer_name, manufacturer_id, "
            "image_url, datasheet_url, package, lifecycle_status, created_at, updated_at) "
            "VALUES (:id, :sku, :slug, :mn, :mid, :img, :ds, :pkg, 'active', :ts, :ts)"
        ),
        {
            "id": pid,
            "sku": sku,
            "slug": sku.lower(),
            "mn": maker_name,
            "mid": mfr,
            "img": image,
            "ds": datasheet,
            "pkg": package,
            "ts": EPOCH + timedelta(minutes=minutes),
        },
    )
    return pid


def _listing(conn, *, part, supplier, price, minutes, stock=1) -> uuid.UUID:
    lid = uuid.uuid4()
    conn.execute(
        text(
            "INSERT INTO part_listings (id, part_id, supplier_id, unit_price, "
            "stock_quantity, currency, last_updated, created_at, updated_at) "
            "VALUES (:id, :p, :s, :price, :stock, 'USD', :ts, :ts, :ts)"
        ),
        {
            "id": lid,
            "p": part,
            "s": supplier,
            "price": price,
            "stock": stock,
            "ts": EPOCH + timedelta(minutes=minutes),
        },
    )
    return lid


def _price_break(conn, listing: uuid.UUID, qty: int, price: str) -> uuid.UUID:
    bid = uuid.uuid4()
    conn.execute(
        text(
            "INSERT INTO price_breaks (id, listing_id, min_quantity, unit_price) "
            "VALUES (:id, :l, :q, :p)"
        ),
        {"id": bid, "l": listing, "q": qty, "p": price},
    )
    return bid


@pytest.fixture(scope="module")
def pre_migration(conn):
    """Rewind 041's schema changes so the upgrade path is testable repeatedly.

    Once 041 has actually been applied to the local database — which happens
    the moment the stack next boots — the fixtures below could not even INSERT
    their duplicate pair, and `upgrade()` would die creating objects that
    already exist. This file would quietly become a test that only ever ran on
    a pre-migration database, i.e. once. Dropping the two objects inside the
    module's always-rolled-back transaction restores the old shape for the
    duration, so the migration stays exercised forever after.
    """
    conn.execute(text("DROP INDEX IF EXISTS uq_parts_manufacturer_sku_upper"))
    conn.execute(
        text(
            "ALTER TABLE part_listings "
            "DROP CONSTRAINT IF EXISTS uq_part_listings_part_supplier"
        )
    )


@pytest.fixture(scope="module")
def world(conn, pre_migration):
    """Every merge scenario, inserted before the migration runs."""
    suppliers = [
        row[0] for row in conn.execute(text("SELECT id FROM suppliers ORDER BY created_at LIMIT 3"))
    ]
    if len(suppliers) < 3:  # pragma: no cover - depends on local seed
        pytest.skip("local database has fewer than 3 suppliers to build listings from")
    acme, globex, initech = suppliers

    mfr = _new_manufacturer(conn, "Harness Semiconductor")
    other = _new_manufacturer(conn, "Harness Instruments")

    w: dict[str, object] = {"mfr": mfr, "other": other, "suppliers": suppliers}

    # 1. Case-only duplicate. The OLDER row is field-poor but listing-rich, the
    #    newer one carries the only photo — production's actual shape for the
    #    nRF52833 and SiT1533 groups.
    w["old"] = _part(conn, sku="HRN-1000-A", mfr=mfr, minutes=0, datasheet="http://d/1")
    w["new"] = _part(
        conn, sku="hrn-1000-a", mfr=mfr, minutes=60, image="http://i/1", package="QFN-48"
    )

    # Supplier collision: both rows list ACME. The fresher price must win.
    w["stale_listing"] = _listing(conn, part=w["old"], supplier=acme, price="9.99", minutes=0)
    w["fresh_listing"] = _listing(conn, part=w["new"], supplier=acme, price="7.50", minutes=90)
    w["stale_break"] = _price_break(conn, w["stale_listing"], 10, "9.00")
    w["fresh_break"] = _price_break(conn, w["fresh_listing"], 10, "7.00")

    # No collision: only the loser lists GLOBEX, so that offer must survive.
    w["moved_listing"] = _listing(conn, part=w["new"], supplier=globex, price="8.25", minutes=30)
    w["moved_break"] = _price_break(conn, w["moved_listing"], 100, "8.00")

    # Only the survivor lists INITECH.
    w["kept_listing"] = _listing(conn, part=w["old"], supplier=initech, price="8.75", minutes=10)

    # 2. Punctuation variants of one manufacturer — genuinely different parts.
    w["diode_68v"] = _part(conn, sku="HRN-1.5SMC68AHM3", mfr=mfr, minutes=0)
    w["diode_6v8"] = _part(conn, sku="HRN-1.5SMC6.8AHM3", mfr=mfr, minutes=1)

    # 3. Same MPN, different manufacturers — unrelated products.
    w["shared_a"] = _part(conn, sku="HRN-SHARED-1", mfr=mfr, minutes=0)
    w["shared_b"] = _part(conn, sku="HRN-SHARED-1", mfr=other, minutes=1)

    # 4. Two rows the maker was never resolved for, sharing an MPN but made by
    #    different companies. GROUP BY treats NULLs as EQUAL in Postgres, so a
    #    merge that does not exclude them folds these two into one product.
    #    Production carries 3,229 unlinked rows and is still creating more
    #    until the write-time resolver deploys, so this hazard is live even
    #    though today's catalog happens not to contain an instance of it.
    w["unlinked_alpha"] = _part(
        conn, sku="HRN-UNLINKED-1", mfr=None, minutes=0, maker_name="Alpha Devices"
    )
    w["unlinked_beta"] = _part(
        conn, sku="HRN-UNLINKED-1", mfr=None, minutes=1, maker_name="Beta Devices"
    )

    return w


@pytest.fixture(scope="module")
def migrated(conn, world):
    """Run the migration's real upgrade() once, over the whole catalog.

    Rewinds first. Once 041 has actually been applied to the local database —
    which it will be, the moment the stack next boots — `upgrade()` would die
    trying to create objects that already exist, and this whole file would
    become a test that only ever ran once. Dropping them inside the fixture's
    (always rolled back) transaction restores the pre-migration shape, so the
    upgrade path stays exercised on a migrated database forever after.
    """
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    module = _load_migration()
    ctx = MigrationContext.configure(conn)
    with Operations.context(ctx):
        module.upgrade()
    return world


def _exists(conn, part_id) -> bool:
    return (
        conn.execute(text("SELECT 1 FROM parts WHERE id = :id"), {"id": part_id}).first()
        is not None
    )


# ── the merge ────────────────────────────────────────────────────────────────


def test_merge_collapses_a_case_only_duplicate_pair(conn, migrated):
    """Two rows differing only in MPN capitalisation become one."""
    remaining = conn.execute(
        text("SELECT count(*) FROM parts WHERE upper(sku) = 'HRN-1000-A'")
    ).scalar()
    assert remaining == 1


def test_merge_keeps_the_oldest_row_as_the_survivor(conn, migrated):
    """The incumbent wins, matching how every other slot in this codebase resolves."""
    assert _exists(conn, migrated["old"])
    assert not _exists(conn, migrated["new"])


def test_merge_backfills_a_photo_the_survivor_lacked(conn, migrated):
    """Oldest-wins must not throw away data only the loser had.

    Two of production's six groups have the photo on the NEWER row (a 2026-08
    feed import) and the listings on the older one. A plain delete loses the
    photo silently.
    """
    image = conn.execute(
        text("SELECT image_url FROM parts WHERE id = :id"), {"id": migrated["old"]}
    ).scalar()
    assert image == "http://i/1"


def test_merge_does_not_overwrite_a_field_the_survivor_already_had(conn, migrated):
    datasheet = conn.execute(
        text("SELECT datasheet_url FROM parts WHERE id = :id"), {"id": migrated["old"]}
    ).scalar()
    assert datasheet == "http://d/1"


def test_merge_moves_an_uncontested_listing_to_the_survivor(conn, migrated):
    """A distributor only the loser carried must not lose its offer."""
    owner = conn.execute(
        text("SELECT part_id FROM part_listings WHERE id = :id"),
        {"id": migrated["moved_listing"]},
    ).scalar()
    assert owner == migrated["old"]


def test_merge_keeps_the_fresher_side_of_a_supplier_collision(conn, migrated):
    """Both rows listed ACME. One row per distributor survives — the newer price."""
    assert _exists_listing(conn, migrated["fresh_listing"])
    assert not _exists_listing(conn, migrated["stale_listing"])


def _exists_listing(conn, listing_id) -> bool:
    return (
        conn.execute(text("SELECT 1 FROM part_listings WHERE id = :id"), {"id": listing_id}).first()
        is not None
    )


def test_merge_deletes_the_price_breaks_of_a_dropped_listing(conn, migrated):
    """Dropping a listing must not orphan its price breaks."""
    orphan = conn.execute(
        text("SELECT 1 FROM price_breaks WHERE id = :id"), {"id": migrated["stale_break"]}
    ).first()
    assert orphan is None


def test_merge_leaves_no_orphaned_price_breaks_anywhere(conn, migrated):
    """Whole-table invariant, not just the harness rows."""
    orphans = conn.execute(
        text(
            "SELECT count(*) FROM price_breaks b "
            "LEFT JOIN part_listings l ON l.id = b.listing_id WHERE l.id IS NULL"
        )
    ).scalar()
    assert orphans == 0


def test_merge_leaves_punctuation_variants_alone(conn, migrated):
    """1.5SMC6.8AHM3 is a 6.8V diode and 1.5SMC68AHM3 is a 68V one."""
    assert _exists(conn, migrated["diode_68v"])
    assert _exists(conn, migrated["diode_6v8"])


def test_merge_leaves_one_mpn_under_two_manufacturers_alone(conn, migrated):
    """49 real MPN pairs span different makers and are unrelated products."""
    assert _exists(conn, migrated["shared_a"])
    assert _exists(conn, migrated["shared_b"])


def test_merge_never_folds_two_unlinked_rows_together(conn, migrated):
    """NULL manufacturer_id means "maker unknown", not "same maker".

    Postgres GROUP BY treats NULLs as equal, so a merge keyed on
    (manufacturer_id, upper(sku)) without an IS NOT NULL guard would collapse
    every unlinked row that happens to share an MPN — merging two different
    companies' products into one listing page.
    """
    assert _exists(conn, migrated["unlinked_alpha"])
    assert _exists(conn, migrated["unlinked_beta"])


def test_merge_clears_every_duplicate_in_the_real_catalog(conn, migrated):
    """The whole point: after 041 the identity key holds table-wide.

    Scoped to linked rows because that is exactly what the unique index
    constrains — Postgres treats NULLs as distinct for uniqueness, so unlinked
    rows are outside the key until the seed resolves them and 042 forbids them.
    """
    groups = conn.execute(
        text(
            "SELECT count(*) FROM (SELECT 1 FROM parts WHERE manufacturer_id IS NOT NULL "
            "GROUP BY manufacturer_id, upper(sku) HAVING count(*) > 1) x"
        )
    ).scalar()
    assert groups == 0


# ── the constraints ──────────────────────────────────────────────────────────


def test_part_identity_index_rejects_a_case_variant_insert(conn, migrated):
    """The constraint, not the application, is what makes duplicates impossible."""
    savepoint = conn.begin_nested()
    with pytest.raises(IntegrityError):
        _part(conn, sku="HRN-1000-a", mfr=migrated["mfr"], minutes=999)
        conn.execute(text("SELECT 1"))
    savepoint.rollback()


def test_part_identity_index_still_permits_a_different_manufacturer(conn, migrated):
    savepoint = conn.begin_nested()
    _part(conn, sku="HRN-1000-A", mfr=migrated["other"], minutes=999)
    savepoint.rollback()


def test_listing_constraint_rejects_a_second_row_for_one_distributor(conn, migrated):
    """One offer per distributor per part — routes/parts.py used to be the only guard."""
    savepoint = conn.begin_nested()
    with pytest.raises(IntegrityError):
        _listing(
            conn,
            part=migrated["old"],
            supplier=migrated["suppliers"][2],  # INITECH already has one
            price="1.00",
            minutes=999,
        )
        conn.execute(text("SELECT 1"))
    savepoint.rollback()


def test_migration_is_idempotent_on_the_data_it_already_merged(conn, migrated):
    """Re-running the merge half must be a no-op, not a second round of deletes."""
    before = conn.execute(text("SELECT count(*) FROM parts")).scalar()
    module = _load_migration()
    conn.execute(text(module.MERGE_DUPLICATE_PARTS))
    after = conn.execute(text("SELECT count(*) FROM parts")).scalar()
    assert after == before
