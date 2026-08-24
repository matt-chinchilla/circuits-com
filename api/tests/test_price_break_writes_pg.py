"""What a price-ladder refresh physically does to Postgres pages.

The rest of the write-budget proof lives in `test_feed_query_budget.py` and
runs on SQLite, which is enough to show that the reconciler emits no SQL for an
unchanged ladder. It is NOT enough to show what the database does with the SQL
it does emit, and that is where the interesting half of this fix lives:

* `ctid` — a row's physical location. A row that survived a pass keeps it; a
  row that was destroyed and recreated cannot. SQLite has no equivalent, so
  the strongest available statement of "nothing was written" can only be made
  here.
* `n_tup_hot_upd` — whether an UPDATE was heap-only. `price_breaks.unit_price`
  is the table's only unindexed column, so repricing in place is HOT-eligible
  and can skip all three of the table's indexes (67 MB of them). A
  delete-and-reinsert never can.

Measured on the local catalog against a real 9-rung Mouser listing before this
file existed:

    identical pass   all 9 rows keep both id and ctid; session dirty/new/deleted 0/0/0
    one rung moves   n_tup_upd +1, n_tup_hot_upd +1, n_tup_ins +0, n_tup_del +0

against 9 deletes and 9 inserts for either case beforehand.

Everything here runs inside a transaction that is always rolled back, and the
harness refuses a non-local host.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.services.part_feed.base import FeedPriceBreak
from app.services.part_feed.importer import _sync_price_breaks

from .feed_helpers import StatementCounter
from .pg_harness import postgres_engine

LADDER = [(1, "1.2700"), (10, "1.1100"), (100, "0.9510"), (1000, "0.8220")]


@pytest.fixture(scope="module")
def conn():
    engine = postgres_engine()
    connection = engine.connect()
    transaction = connection.begin()
    try:
        yield connection
    finally:
        transaction.rollback()
        connection.close()
        engine.dispose()


@pytest.fixture
def listing(conn):
    """A throwaway listing carrying LADDER, on a savepoint of its own.

    The supplier is CREATED rather than borrowed. Reusing the lowest-id
    supplier worked only by luck: `uq_part_listings_part_supplier` makes the
    insert a UniqueViolation the moment that pair is already listed, and
    because the failure would happen in fixture SETUP the savepoint below never
    gets rolled back — the module's shared transaction aborts and every test in
    the file then fails with "current transaction is aborted" instead. On a
    prod-shaped database, where Mouser covers most of the catalog, a collision
    is the likely case rather than the unlucky one.
    """
    savepoint = conn.begin_nested()
    part_id = conn.execute(text("SELECT id FROM parts ORDER BY id LIMIT 1")).scalar()
    if part_id is None:  # pragma: no cover - empty local DB
        savepoint.rollback()
        pytest.skip("local database has no catalog to hang a listing off")

    supplier_id = uuid.uuid4()
    conn.execute(
        text(
            "INSERT INTO suppliers (id, name, created_at, updated_at) VALUES (:i, :n, now(), now())"
        ),
        {"i": supplier_id, "n": f"Write-budget probe {supplier_id.hex[:8]}"},
    )
    listing_id = uuid.uuid4()
    conn.execute(
        text(
            "INSERT INTO part_listings (id, part_id, supplier_id, unit_price, "
            "currency, last_updated) VALUES (:i, :p, :s, 1.00, 'USD', now())"
        ),
        {"i": listing_id, "p": part_id, "s": supplier_id},
    )
    for qty, price in LADDER:
        conn.execute(
            text(
                "INSERT INTO price_breaks (id, listing_id, min_quantity, unit_price) "
                "VALUES (:i, :l, :q, :u)"
            ),
            {"i": uuid.uuid4(), "l": listing_id, "q": qty, "u": Decimal(price)},
        )
    yield listing_id
    savepoint.rollback()


def _rows(conn, listing_id):
    return conn.execute(
        text(
            "SELECT min_quantity, id, unit_price, ctid::text FROM price_breaks "
            "WHERE listing_id = :l ORDER BY min_quantity"
        ),
        {"l": listing_id},
    ).all()


def _session_on(conn):
    """A Session sharing the module's connection — and its rollback.

    Bound to a connection that already has a transaction, a Session defaults to
    `join_transaction_mode="conditional_savepoint"`: its work lands inside a
    SAVEPOINT that `close()` ROLLS BACK. Flushing and closing therefore proves
    nothing at all, and every assertion below would pass by accident. Callers
    commit, which releases the savepoint into the outer transaction that the
    `conn` fixture rolls back at the end.
    """
    from sqlalchemy.orm import Session

    return Session(bind=conn, autoflush=False)


def test_a_confirming_pass_does_not_move_a_single_row(conn, listing):
    """The strongest available statement of "nothing was written"."""
    before = _rows(conn, listing)
    same = [FeedPriceBreak(q, float(p)) for q, p in LADDER]

    with _session_on(conn) as db:
        _sync_price_breaks(db, listing, same)
        db.commit()

    assert _rows(conn, listing) == before, (
        "a pass confirming the stored ladder relocated rows on disk — every "
        "differing ctid is a dead tuple plus three index writes that bought "
        "nothing"
    )


def test_a_confirming_pass_emits_no_write_statement(conn, listing):
    """No INSERT, UPDATE or DELETE reached the database at all.

    This deliberately does NOT assert on `db.new`/`db.dirty`/`db.deleted`. The
    reconciler emits its UPDATE and DELETE through Core `db.execute`, which
    never touches the unit of work, so `dirty` and `deleted` stay empty however
    the code behaves — an earlier version of this test asserted `(0, 0, 0)` and
    passed even when fed a ladder with one rung repriced AND one removed. Only
    the staged-INSERT third of it could ever have failed.
    """
    same = [FeedPriceBreak(q, float(p)) for q, p in LADDER]

    with _session_on(conn) as db, StatementCounter(db) as counted:
        _sync_price_breaks(db, listing, same)
        db.commit()

    writes = counted.writes_to("price_breaks")
    assert writes == [], f"an unchanged ladder still wrote: {writes}"


def test_repricing_one_rung_updates_in_place_and_can_go_hot(conn, listing):
    """One tuple version, no insert, no delete, and eligible to skip the indexes."""
    before = _rows(conn, listing)
    moved = [FeedPriceBreak(q, float(p)) for q, p in LADDER]
    moved[-1].unit_price = 0.7400

    with _session_on(conn) as db:
        _sync_price_breaks(db, listing, moved)
        db.commit()
    after = _rows(conn, listing)

    assert [r[1] for r in after] == [r[1] for r in before], (
        "the repriced ladder was recreated rather than updated — row ids changed"
    )
    relocated = [(a, b) for a, b in zip(before, after, strict=True) if a[3] != b[3]]
    assert len(relocated) == 1, (
        f"{len(relocated)} of {len(before)} rows were physically rewritten to move one price"
    )
    assert relocated[0][1][0] == 1000 and relocated[0][1][2] == Decimal("0.7400")

    # unit_price carries no index, so nothing forced a non-HOT update. Whether
    # Postgres actually took the HOT path depends on free space in the page —
    # the default fillfactor is 100 — so this asserts eligibility, which is
    # what the code controls, rather than the outcome, which it does not.
    indexed = {
        row[0]
        for row in conn.execute(
            text(
                "SELECT a.attname FROM pg_index i "
                "JOIN pg_attribute a ON a.attrelid = i.indrelid "
                "AND a.attnum = ANY(i.indkey) "
                "WHERE i.indrelid = 'price_breaks'::regclass"
            )
        )
    }
    assert "unit_price" not in indexed, (
        "unit_price gained an index, so repricing can no longer be a HOT update; "
        "the write cost of every feed pass just went up by three index writes "
        f"per moved rung (indexed columns: {sorted(indexed)})"
    )
