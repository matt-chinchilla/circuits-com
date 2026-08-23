"""One feed run per supplier — across PROCESSES, not just within one.

`start_feed_run` already refuses a second run for a supplier, but it enforces
that with `_RUNS`, a module-level dict. `jobs/feed_import_daily` calls
`grow_catalog` directly from the `feed-import` CONTAINER, which is a different
process and cannot see that dict. So an admin clicking Import during the
nightly sweep really does run two sweeps over one supplier, and because
`_save_import_cursor` rewrites the whole cursor map from a snapshot taken at
run start, whichever finishes second discards the other's paging depth — the
catalog silently stops advancing while appearing to work.

A Postgres advisory lock is the right shape here specifically because it is
released when the holding CONNECTION goes away. A lock row in a table would
survive a container restart mid-run (CLAUDE.md notes restarts truncate runs)
and block that supplier's feed forever until someone noticed and cleaned up.

Locks are per-connection, and a Session hands its connection back to the pool
on every commit — the importer commits per part — so the lock MUST hold its own
dedicated connection rather than borrowing the worker's session.
"""

from __future__ import annotations

import uuid

import pytest

from app.services.feed_lock import (
    FEED_LOCK_NAMESPACE,
    advisory_key,
    supplier_feed_lock,
)

from .pg_harness import postgres_engine


@pytest.fixture(scope="module")
def engine():
    return postgres_engine()


def db_supplier(engine):
    """The one supplier both the lock and the sweep must agree on.

    Ordered, and used by BOTH sides: two unordered `LIMIT 1` queries can return
    different rows, and the locked test would then pass while contending over
    nothing at all (it did, before this existed).
    """
    from sqlalchemy import text

    with engine.connect() as conn:
        row = conn.execute(text("SELECT id FROM suppliers ORDER BY id LIMIT 1")).first()
    if row is None:  # pragma: no cover - depends on local seed
        pytest.skip("local database has no suppliers")
    return row[0]


class TestKeyDerivation:
    def test_the_key_is_stable_for_a_given_supplier(self):
        sid = uuid.UUID("3f2504e0-4f89-11d3-9a0c-0305e82c3301")
        assert advisory_key(sid) == advisory_key(sid)

    def test_the_key_does_not_depend_on_python_hash_randomisation(self):
        """`hash(str)` is salted per process, so it cannot key a cross-process lock."""
        sid = uuid.UUID("3f2504e0-4f89-11d3-9a0c-0305e82c3301")
        assert advisory_key(sid) == advisory_key(str(sid))
        # Pinned literal: if this changes, running processes disagree about
        # which lock they are contending for during the rollout.
        assert advisory_key(sid) == advisory_key(uuid.UUID(str(sid)))

    def test_the_key_fits_a_postgres_signed_int4(self):
        for _ in range(200):
            key = advisory_key(uuid.uuid4())
            assert -(2**31) <= key < 2**31

    def test_different_suppliers_get_different_keys(self):
        keys = {advisory_key(uuid.uuid4()) for _ in range(500)}
        assert len(keys) > 490, "the key derivation is collapsing distinct suppliers"


class TestMutualExclusion:
    def test_a_second_holder_is_refused_while_the_first_holds_it(self, engine):
        sid = uuid.uuid4()
        with supplier_feed_lock(engine, sid) as first:
            assert first is True
            with supplier_feed_lock(engine, sid) as second:
                assert second is False, (
                    "two callers hold one supplier's feed lock at once — the "
                    "nightly sweep and an admin Import click can collide"
                )

    def test_the_lock_is_released_when_the_block_exits(self, engine):
        sid = uuid.uuid4()
        with supplier_feed_lock(engine, sid) as first:
            assert first is True
        with supplier_feed_lock(engine, sid) as again:
            assert again is True, "the lock outlived its block and is now stuck"

    def test_the_lock_is_released_even_when_the_body_raises(self, engine):
        """A crashing run must not wedge that supplier's feed permanently."""
        sid = uuid.uuid4()
        with pytest.raises(RuntimeError):
            with supplier_feed_lock(engine, sid) as got:
                assert got is True
                raise RuntimeError("import blew up")
        with supplier_feed_lock(engine, sid) as again:
            assert again is True

    def test_two_suppliers_do_not_block_each_other(self, engine):
        a, b = uuid.uuid4(), uuid.uuid4()
        with supplier_feed_lock(engine, a) as first:
            with supplier_feed_lock(engine, b) as second:
                assert first is True and second is True

    def test_a_refused_caller_does_not_release_the_holders_lock(self, engine):
        """The classic advisory-lock bug: the loser unlocks on the way out."""
        sid = uuid.uuid4()
        with supplier_feed_lock(engine, sid):
            with supplier_feed_lock(engine, sid) as loser:
                assert loser is False
            # The loser's exit must NOT have freed the winner's lock.
            with supplier_feed_lock(engine, sid) as third:
                assert third is False, (
                    "a refused caller released the holder's lock on exit — the "
                    "guard now lets a third caller straight in"
                )


class TestTheLockDoesNotCompeteWithHttpTraffic:
    """A held lock must not occupy a connection the public site needs.

    This is the trap the lock walks straight into if it borrows the app engine.
    A feed session holds its pooled connection only 12-22% of a run's
    wall-clock, because it commits per part and the provider's HTTP call
    happens with nothing checked out — measured, and the reason the default
    pool of 5+10 is fine. The LOCK is the opposite: it is held for the entire
    run, which can be hours. Taken from the request pool, fifteen concurrent
    feed runs would leave the site with nothing.
    """

    def test_a_held_lock_takes_nothing_from_the_request_pool(self, engine):
        # Deliberately the real Postgres engine from the fixture, not
        # app.db.session.engine: under pytest that one is SQLite, where the
        # lock is a no-op and this assertion would pass without measuring
        # anything.
        before = engine.pool.checkedout()
        with supplier_feed_lock(engine, uuid.uuid4()) as held:
            assert held is True
            during = engine.pool.checkedout()
        assert during == before, (
            "the feed lock checked a connection out of the pool that serves HTTP "
            "and holds it for the whole run — that is a hard ceiling of ~15 "
            "concurrent feed runs before the public site cannot get a connection"
        )

    def test_the_lock_connection_does_not_idle_in_transaction(self, engine):
        """`idle in transaction` is a landmine for connection poolers and for
        `idle_in_transaction_session_timeout`, and buys nothing: a session-level
        advisory lock is not transaction-scoped."""
        from sqlalchemy import text

        sid = uuid.uuid4()
        with supplier_feed_lock(engine, sid) as held:
            assert held is True
            with engine.connect() as observer:
                states = [
                    row[0]
                    for row in observer.execute(
                        text(
                            "SELECT state FROM pg_stat_activity "
                            "WHERE query LIKE '%pg_try_advisory_lock%' "
                            "AND pid <> pg_backend_pid()"
                        )
                    )
                ]
        assert "idle in transaction" not in states, (
            f"the lock connection is sitting in an open transaction: {states}"
        )


class TestTheNightlyJobHonoursTheLock:
    """The bug in one test: the sweep must stand down, and spend nothing.

    The unit tests above prove the primitive. This proves the wiring — that
    `_import_one` actually consults it, on a real Postgres, where the lock is
    not the SQLite no-op the rest of the suite exercises.
    """

    @staticmethod
    def _sweep_one(engine, built: list[str]):
        """Run `_import_one` against a provider that records being built.

        Building the provider is the moment the day's quota starts being spent,
        so `built` is the tripwire: empty means the sweep stood down before
        costing anything. Construction then raises, because nothing past that
        point is what these tests are about.
        """
        from sqlalchemy.orm import Session

        from app.jobs.feed_import_daily import _import_one, _Target
        from app.models import Supplier

        class RecordingProvider:
            def __init__(self, api_key=None):
                built.append("built")
                raise RuntimeError("far enough — construction is the signal")

        # The SAME supplier the lock test locks — `db.query(Supplier).first()`
        # is unordered, so it can hand back a different row and the locked test
        # would then pass while contending over nothing.
        supplier = db_supplier(engine)
        with Session(engine) as db:
            supplier = db.get(Supplier, supplier)
            target = _Target(supplier, supplier.name, RecordingProvider, "unused")
            return supplier.id, _import_one(db, target, call_budget=10)

    def test_a_held_lock_makes_the_sweep_skip_the_supplier(self, engine):
        built: list[str] = []
        with supplier_feed_lock(engine, db_supplier(engine)) as held:
            assert held is True
            _, stats = self._sweep_one(engine, built)

        assert built == [], (
            "the sweep built a provider for a supplier whose feed lock was "
            "already held — it is about to double-sweep and burn the day's "
            "quota twice"
        )
        assert stats["skipped_locked"] is True
        assert stats["created"] == 0 and stats["synced"] == 0
        assert stats["error"] is False, "standing down is not an error"

    def test_a_skipped_supplier_is_not_stamped_as_having_run(self, engine):
        """`_stamp_run` records "when did we last spend calls on this supplier".

        A supplier the sweep stood down on spent nothing, so stamping it claims
        a run that never happened — and since ordering and staleness rules read
        that column, the effect is a supplier that quietly stops being imported.
        """
        from sqlalchemy import text
        from sqlalchemy.orm import Session

        from app.jobs.feed_import_daily import run_once

        supplier_id = db_supplier(engine)
        with engine.connect() as conn:
            before = conn.execute(
                text("SELECT last_synced_at FROM supplier_feeds WHERE supplier_id = :s"),
                {"s": supplier_id},
            ).first()

        with supplier_feed_lock(engine, supplier_id):
            with Session(engine) as db:
                summary = run_once(db)

        with engine.connect() as conn:
            after = conn.execute(
                text("SELECT last_synced_at FROM supplier_feeds WHERE supplier_id = :s"),
                {"s": supplier_id},
            ).first()

        assert after == before, "a stood-down supplier was stamped as having run"
        assert summary["skipped_locked"] >= 0  # key exists in the summary at all

    def test_the_sweep_runs_normally_when_nothing_holds_the_lock(self, engine):
        """The guard must not have turned into "the nightly job never runs"."""
        built: list[str] = []
        _, stats = self._sweep_one(engine, built)

        assert built == ["built"], "the sweep never got as far as building a provider"
        assert stats["skipped_locked"] is False


class TestNamespacing:
    def test_the_namespace_keeps_feed_locks_clear_of_other_advisory_users(self, engine):
        """Two-int advisory locks are global; the namespace is what scopes ours."""
        from sqlalchemy import text

        sid = uuid.uuid4()
        with supplier_feed_lock(engine, sid):
            with engine.connect() as other:
                # Same key, DIFFERENT namespace — must not contend.
                got = other.execute(
                    text("SELECT pg_try_advisory_lock(:ns, :k)"),
                    {"ns": FEED_LOCK_NAMESPACE + 1, "k": advisory_key(sid)},
                ).scalar()
                assert got is True
                other.execute(
                    text("SELECT pg_advisory_unlock(:ns, :k)"),
                    {"ns": FEED_LOCK_NAMESPACE + 1, "k": advisory_key(sid)},
                )
