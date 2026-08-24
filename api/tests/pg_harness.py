"""Shared plumbing for the suite's few genuinely Postgres-backed tests.

Almost everything here runs on SQLite via `Base.metadata.create_all`, which is
fast and dialect-agnostic enough for application logic. Three things it cannot
express, and which therefore need a real engine:

* a data migration (Postgres SQL, run through alembic)
* a cross-process advisory lock (SQLite has no such concept)
* what a write PHYSICALLY does — `ctid` row identity and HOT-update accounting,
  which is how the feed's price-ladder reconciler proves it wrote nothing

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
    """An engine on the local stack, or skip the calling module.

    Also checks the target actually holds the application schema. The env var
    above is SHARED with tests/test_auth_hardening.py, whose live-Postgres
    replay test has used it since migration 022 — and that one points at the
    server's `postgres` database so it can create a throwaway. Pointed there,
    everything here would fail with a confusing "relation parts does not
    exist" instead of skipping.
    """
    from sqlalchemy import create_engine, inspect

    try:
        engine = create_engine(database_url())
        with engine.connect() as probe:
            has_schema = inspect(probe).has_table("parts")
    except Exception as exc:  # noqa: BLE001 - see below
        # Deliberately broad. Catching only OperationalError broke the promise
        # above: a checkout without psycopg2 raises ModuleNotFoundError from
        # create_engine, and a malformed URL raises ArgumentError — neither is
        # an OperationalError, so both modules would COLLECT-ERROR instead of
        # skipping. Nothing here can fail in a way worth failing the suite for.
        pytest.skip(f"no usable local Postgres for the harness: {exc}")
    if not has_schema:  # pragma: no cover - depends on where the env var points
        pytest.skip(
            f"{database_url().rsplit('/', 1)[-1]!r} has no `parts` table — "
            "MIGRATION_TEST_DATABASE_URL is pointing at a database without the "
            "application schema (test_auth_hardening defaults it to `postgres`)."
        )
    return engine
