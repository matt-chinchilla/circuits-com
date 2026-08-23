"""Shared plumbing for the suite's few genuinely Postgres-backed tests.

Almost everything here runs on SQLite via `Base.metadata.create_all`, which is
fast and dialect-agnostic enough for application logic. Two things it cannot
express, and which therefore need a real engine:

* a data migration (Postgres SQL, run through alembic)
* a cross-process advisory lock (SQLite has no such concept)

Both skip cleanly when the local stack is down, so `pytest tests/` on a bare
checkout stays green, and both refuse to run against a non-local host.
"""

from __future__ import annotations

import os

import pytest

# The local dev stack — docker-compose maps 5432 with dev-default credentials.
DEFAULT_URL = "postgresql://circuits:circuits@localhost:5432/circuits"
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1", "db")


def database_url() -> str:
    """A local Postgres DSN, or fail loudly if pointed somewhere it shouldn't be."""
    url = os.environ.get("MIGRATION_TEST_DATABASE_URL", DEFAULT_URL)
    host = url.split("@")[-1].split("/")[0].split(":")[0]
    if host not in LOCAL_HOSTS:
        pytest.fail(
            f"refusing to run the Postgres harness against {host!r}. These tests "
            "open write transactions and take locks; only a local database is safe."
        )
    return url


def postgres_engine():
    """An engine on the local stack, or skip the calling module."""
    from sqlalchemy import create_engine
    from sqlalchemy.exc import OperationalError

    try:
        engine = create_engine(database_url())
        engine.connect().close()
    except OperationalError as exc:  # pragma: no cover - depends on local stack
        pytest.skip(f"no local Postgres for the harness: {exc}")
    return engine
