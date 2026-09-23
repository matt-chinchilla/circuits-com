"""``usable_code(..., lock=True)`` really takes a row lock — on Postgres.

LU-F19: two buyers must not both spend a single-use code's last use. The guard
is ``SELECT … FOR UPDATE`` on the code row inside the intent transaction, and
SQLite (the rest of the suite) has no row locks, so ``with_for_update()`` there
is a silent no-op: removing it left every other test green. This proves it on
the engine prod runs, with TWO connections — conn 1 holds the lock in an open
transaction, conn 2 must fail to take it within ``lock_timeout``.

Scratch schema, never real data: a row one connection holds uncommitted is
invisible to another, so the code row has to be COMMITTED — into a throwaway
schema (``sales_codes`` + ``checkout_intents`` built from the models there),
reached through ``search_path`` and dropped at the end. Skips when the local
stack is down; refuses a non-local host (pg_harness).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models.sales import CheckoutIntent, SalesCode
from app.services.sales_codes import usable_code

from .pg_harness import postgres_engine

CODE = "ABCD2345"  # Crockford base32, 8 chars — already normalised
LOCK_NOT_AVAILABLE = "55P03"


@pytest.fixture(scope="module")
def scratch():
    """``(engine, schema)`` with one committed single-use Gold code in a
    throwaway schema; the schema is dropped whatever happens."""
    engine = postgres_engine()
    schema = f"test_f6_{uuid.uuid4().hex[:12]}"
    with engine.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    try:
        with engine.begin() as conn:
            conn.execute(text(f'SET LOCAL search_path TO "{schema}"'))
            Base.metadata.create_all(conn, tables=[SalesCode.__table__, CheckoutIntent.__table__])
            conn.execute(
                SalesCode.__table__.insert().values(
                    id=uuid.uuid4(),
                    code=CODE,
                    code_points=5,
                    tier="gold",
                    max_uses=1,
                    uses=0,
                    expires_at=datetime.now(UTC) + timedelta(days=7),
                    rep="rep",
                    created_by="test",
                    active=True,
                    created_at=datetime.now(UTC),
                )
            )
        yield engine, schema
    finally:
        with engine.begin() as conn:
            conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        engine.dispose()


def _open(engine, schema: str):
    """A connection inside an open transaction scoped to the scratch schema."""
    conn = engine.connect()
    txn = conn.begin()
    conn.execute(text(f'SET LOCAL search_path TO "{schema}"'))
    return conn, txn


def _use(session: Session):
    return usable_code(session, CODE, tier="gold", category_id=None, email=None, lock=True)


def test_scratch_schema_holds_the_code_not_public(scratch):
    """The lock test below must be reading OUR row: the scratch table has it,
    and the unqualified name resolves to the scratch schema."""
    engine, schema = scratch
    conn, txn = _open(engine, schema)
    try:
        where = conn.execute(
            text(
                "SELECT n.nspname FROM pg_class c JOIN pg_namespace n "
                "ON n.oid = c.relnamespace WHERE c.oid = 'sales_codes'::regclass"
            )
        ).scalar()
        assert where == schema
        with Session(bind=conn) as session:
            assert _use(session) is not None
    finally:
        txn.rollback()
        conn.close()


def test_a_locked_code_cannot_be_locked_by_a_second_buyer(scratch):
    engine, schema = scratch
    first, first_txn = _open(engine, schema)
    second, second_txn = _open(engine, schema)
    try:
        holder = Session(bind=first)
        assert _use(holder) is not None  # buyer 1 holds the row, uncommitted

        second.execute(text("SET LOCAL lock_timeout = '300ms'"))
        contender = Session(bind=second)
        with pytest.raises(OperationalError) as err:
            _use(contender)
        assert getattr(err.value.orig, "pgcode", None) == LOCK_NOT_AVAILABLE
        contender.close()
        holder.close()
    finally:
        second_txn.rollback()
        second.close()
        first_txn.rollback()
        first.close()


def test_the_lock_is_released_with_the_first_transaction(scratch):
    """Control: once buyer 1's transaction ends, buyer 2 locks the row at once
    — the refusal above is the held row lock, not something else."""
    engine, schema = scratch
    first, first_txn = _open(engine, schema)
    with Session(bind=first) as holder:
        assert _use(holder) is not None
    first_txn.rollback()
    first.close()

    second, second_txn = _open(engine, schema)
    try:
        second.execute(text("SET LOCAL lock_timeout = '300ms'"))
        with Session(bind=second) as contender:
            assert _use(contender) is not None
    finally:
        second_txn.rollback()
        second.close()


def test_an_unlocked_read_is_not_blocked(scratch):
    """``lock=False`` (the /quote pricing path) reads straight through a held
    lock — only the spending path serialises."""
    engine, schema = scratch
    first, first_txn = _open(engine, schema)
    second, second_txn = _open(engine, schema)
    try:
        holder = Session(bind=first)
        assert _use(holder) is not None
        second.execute(text("SET LOCAL lock_timeout = '300ms'"))
        reader = Session(bind=second)
        row = usable_code(reader, CODE, tier="gold", category_id=None, email=None, lock=False)
        assert row is not None
        reader.close()
        holder.close()
    finally:
        second_txn.rollback()
        second.close()
        first_txn.rollback()
        first.close()
