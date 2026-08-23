"""One feed run per supplier, enforced across PROCESSES.

`start_feed_run` refuses a second run for a supplier using `_RUNS`, a
module-level dict. That works between two admin clicks, because both land in
the api process. It does nothing about `jobs/feed_import_daily`, which calls
`grow_catalog` directly from the `feed-import` CONTAINER and cannot see that
dict at all. An Import click during the nightly sweep therefore runs two sweeps
over one supplier, and since `_save_import_cursor` rewrites the whole cursor
map from a snapshot taken at run start, whichever finishes second discards the
other's paging depth — the catalog quietly stops advancing while both runs
report success.

**Why an advisory lock and not a lock row.** The failure that matters is a
container restart mid-run, which this codebase already expects ("container
restart truncates a run"). A row in a table survives that and blocks the
supplier's feed until a human notices; an advisory lock is released by Postgres
the moment the holding connection goes away. That is the whole argument — it
picks the failure mode that self-heals over the one that needs an operator.

**Why a dedicated connection.** Advisory locks belong to a CONNECTION, and a
SQLAlchemy Session hands its connection back to the pool at every `commit()` —
which the importer does once per part. Borrowing the worker's session would
release the lock within milliseconds and then leave it set on a pooled
connection handed to some unrelated request. So the lock opens and holds its
own connection for the run's duration. Measured cost: a feed run occupies a
pooled connection roughly 12-22% of its wall-clock today, so one more held
connection per concurrent run is affordable against a pool of 15.

Non-Postgres engines (the SQLite test suite) get a permissive no-op: there is
one process and no concurrency to arbitrate. The real behaviour is covered by
tests/test_feed_lock.py, which runs against a real Postgres.
"""

from __future__ import annotations

import logging
import uuid
import zlib
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

# Advisory locks live in one global space per database, shared with anything
# else that might use them. The namespace half of the two-int form is what
# keeps feed locks from colliding with a future unrelated user.
FEED_LOCK_NAMESPACE = 0x0FEED


def advisory_key(supplier_id: uuid.UUID | str) -> int:
    """A stable signed int4 for this supplier.

    CRC32 of the canonical UUID text, NOT `hash()`: Python salts string hashing
    per process (PYTHONHASHSEED), so `hash()` would give the api container and
    the feed-import container different keys and the lock would never contend —
    a guard that looks present and is inert.
    """
    canonical = str(uuid.UUID(str(supplier_id)))
    unsigned = zlib.crc32(canonical.encode("ascii"))
    # pg_try_advisory_lock(int4, int4) takes SIGNED 32-bit ints.
    return unsigned - 2**32 if unsigned >= 2**31 else unsigned


@contextmanager
def supplier_feed_lock(engine: Engine, supplier_id: uuid.UUID | str) -> Iterator[bool]:
    """Hold this supplier's feed lock for the block. Yields whether we got it.

    Yields False rather than raising so the caller decides what a collision
    means: the api route turns it into a 409, the nightly job skips the
    supplier and moves on to the next one.
    """
    if engine.dialect.name != "postgresql":
        yield True
        return

    key = advisory_key(supplier_id)
    connection = engine.connect()
    acquired = False
    try:
        acquired = bool(
            connection.execute(
                text("SELECT pg_try_advisory_lock(:ns, :key)"),
                {"ns": FEED_LOCK_NAMESPACE, "key": key},
            ).scalar()
        )
        yield acquired
    finally:
        # Only the holder unlocks. Unlocking unconditionally is the classic bug
        # in this pattern: a REFUSED caller's exit would decrement the holder's
        # lock and let a third caller straight in.
        if acquired:
            try:
                connection.execute(
                    text("SELECT pg_advisory_unlock(:ns, :key)"),
                    {"ns": FEED_LOCK_NAMESPACE, "key": key},
                )
            except Exception:  # pragma: no cover - the close below still frees it
                logger.warning("feed lock unlock failed for %s", supplier_id, exc_info=True)
        connection.close()
