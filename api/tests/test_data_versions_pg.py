"""The Postgres path of services/data_versions — the pg_stat_user_tables read.

The SQLite suite only ever sees the count(*) fallback; this proves the query
prod actually runs parses, names every scoped table, and hashes. Skips when
the local stack is down (pg_harness).
"""

import re

import pytest
from sqlalchemy.orm import Session

from app.services.data_versions import _TABLES, SCOPES, data_versions, write_counters

from .pg_harness import postgres_engine, upgrade_in_transaction


@pytest.fixture(scope="module")
def conn():
    engine = postgres_engine()
    connection = engine.connect()
    transaction = connection.begin()
    try:
        # A branch's new tables join SCOPES before the shared local database is
        # migrated; apply them inside this rolled-back transaction.
        upgrade_in_transaction(connection)
        yield connection
    finally:
        transaction.rollback()
        connection.close()
        engine.dispose()


def test_every_scoped_table_has_a_write_counter(conn):
    with Session(bind=conn) as db:
        counters = write_counters(db)
    assert set(counters) == set(_TABLES), set(_TABLES) - set(counters)
    assert all(isinstance(v, int) and v >= 0 for v in counters.values())


def test_versions_hash_every_scope(conn):
    with Session(bind=conn) as db:
        versions = data_versions(db)
        again = data_versions(db)
    assert set(versions) == set(SCOPES)
    assert all(re.fullmatch(r"[0-9a-f]{12}", v) for v in versions.values())
    assert versions == again
