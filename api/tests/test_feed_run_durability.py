"""A feed run must outlive the socket that started it.

THE DEFECT THIS PINS. Until 2026-08-20 the import WAS the response body:
`POST /api/suppliers/{id}/import` returned `StreamingResponse(stream())` and
`stream()` drove `grow_catalog` itself, so Starlette advanced the run one
`__next__()` per chunk the client read. The socket was the engine. When the
transport died — a phone freezing the tab, a proxy read-timeout, a laptop
sleeping — Starlette stopped pulling, the generator was closed, and the import
ENDED SILENTLY mid-sweep with a plain `200 OK` in the log. Nothing recorded
that a run had been intended, so nothing could finish it and nobody could come
back to watch it.

So the four contracts here are all one contract seen from four sides:

1. **The work does not need a reader.** A run started with NO observer at all
   still produces every event and every activity row, and still closes its
   provider. This is the whole fix, tested at the seam where it lives.
2. **Leaving detaches, it never cancels.** Closing an observer mid-run — which
   is exactly what Starlette does to the response generator on disconnect —
   changes nothing about the run, and does not release the provider early.
   The provider closes ONCE, when the WORK ends.
3. **A lost view can be recovered.** `GET /api/suppliers/{id}/feed-run` replays
   everything said so far and then follows live, ending on the same
   `sync_finished`. A run nobody is watching is still there to attach to.
4. **A second click is refused, not double-spent.** Two runs on one supplier
   would spend the same rate-limited daily quota twice against the same rows.

Plus the heartbeat, which is a wire-contract question: an observer may be
legitimately silent for minutes (a sweep of already-known MPNs yields no event
while still spending ~2.1 s per provider call) and nginx cuts an idle proxied
response at 60 s. The blank lines that keep it alive must never be mistaken for
events by anything that reads the stream.
"""

import json
import threading
import time
import uuid
from decimal import Decimal

import anyio
import pytest

from app.config import settings
from app.main import app as fastapi_app
from app.models import ActivityEvent, Part, PartListing, PriceBreak, Supplier
from app.services.part_feed import importer as importer_module
from app.services.part_feed.importer import (
    FeedRunActive,
    get_feed_run,
    reset_feed_runs,
    start_feed_run,
    sync_supplier_listings,
)
from tests.conftest import TestingSessionLocal
from tests.feed_helpers import FakeProvider as _FakeProvider
from tests.feed_helpers import feed_part as _feed_part

FAKE_KEY = "test-key-not-real"  # never a real credential; only truthiness is checked

# Every wait in this file is bounded. A run that never finishes is a FAILURE,
# not a hang that eats the suite's time budget.
WAIT_SECONDS = 10.0


class _GatedProvider(_FakeProvider):
    """Answers normally, but BLOCKS on the Nth lookup until released.

    The only way to assert anything about a run in flight is to hold it in
    flight deterministically — a sleep would make these tests flaky on a loaded
    machine, and a fast provider would finish before the test could disconnect.
    """

    def __init__(self, by_mpn=None, block_on=2):
        super().__init__(by_mpn=by_mpn)
        self.block_on = block_on
        self.lookups = 0
        self.blocked = threading.Event()
        self.release = threading.Event()
        self.closed = 0

    def lookup_mpn(self, mpn):
        self.lookups += 1
        if self.lookups == self.block_on:
            self.blocked.set()
            assert self.release.wait(WAIT_SECONDS), "gate was never released"
        return super().lookup_mpn(mpn)

    def close(self):
        self.closed += 1


class _CountingProvider(_FakeProvider):
    """A provider that records how many times it was closed."""

    def __init__(self, by_mpn=None):
        super().__init__(by_mpn=by_mpn)
        self.closed = 0

    def close(self):
        self.closed += 1


@pytest.fixture(autouse=True)
def worker_uses_the_test_database(monkeypatch):
    """Point the run WORKER at the in-memory test database, and leave no run.

    The worker owns its own session, opened from `importer.SessionLocal`, which
    under pytest points at conftest's DATABASE_URL default — a DIFFERENT
    database from the in-memory engine every fixture writes to.
    `TestingSessionLocal` binds that engine (StaticPool, `check_same_thread`
    already False), so the worker thread shares the test's data.

    The registry is MODULE state: a run left behind by one test would 409 the
    next test's click on the same supplier.
    """
    monkeypatch.setattr(importer_module, "SessionLocal", TestingSessionLocal)
    reset_feed_runs()
    yield
    reset_feed_runs()


@pytest.fixture
def feed_key(monkeypatch):
    monkeypatch.setattr(settings, "MOUSER_API_KEY", FAKE_KEY)


@pytest.fixture
def mouser_supplier(db, seeded_db):
    """A supplier the registry covers, carrying THREE listed parts.

    Three, because every contract here needs a run long enough to be
    interrupted in the middle of: one part finishes before a test can react.
    """
    supplier: Supplier = seeded_db["supplier1"]
    supplier.website = "mouser.com"
    category_id = seeded_db["part1"].category_id
    # Clear whatever the shared seed already listed against this supplier:
    # `sync_supplier_listings` walks EVERY listed part, so an extra seeded row
    # would silently change every event count asserted below.
    existing = [row.id for row in db.query(PartListing.id).filter_by(supplier_id=supplier.id)]
    if existing:
        db.query(PriceBreak).filter(PriceBreak.listing_id.in_(existing)).delete(
            synchronize_session=False
        )
        db.query(PartListing).filter(PartListing.id.in_(existing)).delete(synchronize_session=False)
        db.commit()
    for n in range(1, 4):
        part = Part(
            id=uuid.uuid4(),
            sku=f"DUR-{n}",
            slug=f"dur-{n}",
            manufacturer_name="Feed Mfr",
            description="durability fixture part",
            category_id=category_id,
        )
        db.add(part)
        db.flush()
        db.add(
            PartListing(
                id=uuid.uuid4(),
                part_id=part.id,
                supplier_id=supplier.id,
                sku=f"621-DUR-{n}",
                stock_quantity=1,
                unit_price=Decimal("0.10"),
            )
        )
    db.commit()
    return supplier


@pytest.fixture
def three_part_provider():
    def _make(cls=_CountingProvider, **kwargs):
        return cls(by_mpn={f"DUR-{n}": _feed_part(f"DUR-{n}") for n in (1, 2, 3)}, **kwargs)

    return _make


def _sync_work(limit=25):
    """The same `work` shape the route hands `start_feed_run`."""
    return lambda db, provider, supplier: sync_supplier_listings(
        db, provider, supplier, limit=limit
    )


def _await_finished(run, timeout=WAIT_SECONDS):
    deadline = threading.Event()
    for _ in range(int(timeout * 100)):
        if not run.running:
            return
        deadline.wait(0.01)
    raise AssertionError("the run never finished")


def _kinds(events):
    return [e["kind"] for e in events]


def _use_fake_provider(monkeypatch, provider, slug="mouser"):
    """Make the ROUTE build `provider` — `match_provider` returns a CLASS."""

    class _Scripted:
        @classmethod
        def from_credential(cls, key):
            return cls(api_key=key)

        def __new__(cls, api_key=None):
            return provider

    monkeypatch.setattr("app.routes.suppliers.match_provider", lambda supplier: (slug, _Scripted))
    return provider


class TestTheWorkDoesNotNeedAReader:
    """Contract 1 — the run is the work, not the response body."""

    def test_a_run_with_no_observer_at_all_completes_and_records_everything(
        self, db, mouser_supplier, three_part_provider
    ):
        """No socket, no reader, nobody attached — the whole run still happens.

        This is the defect stated positively. Before the split, a generator
        nobody pulled did NOTHING; here nobody pulls and everything happens.
        """
        provider = three_part_provider()

        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        _await_finished(run)

        assert _kinds(run.events) == [
            "sync_started",
            "part_synced",
            "part_synced",
            "part_synced",
            "sync_finished",
        ]
        # media_filled counts in BOTH — the fixture parts start imageless, so
        # every one of them is a media write as well as a listing refresh.
        assert run.events[-1]["counts"] == {
            "synced": 3,
            "media_filled": 3,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }
        rows = sorted(r.kind for r in db.query(ActivityEvent).all())
        assert rows == ["part_synced"] * 3 + ["sync_finished", "sync_started"]
        # Released when the WORK ended, and exactly once.
        assert provider.closed == 1

    def test_a_run_that_blows_up_reports_its_own_failure_with_nobody_listening(
        self, db, mouser_supplier, three_part_provider
    ):
        """Contract 1 for the abort path: the terminal events are produced by
        the WORK, so they exist whether or not a socket does.

        The tally is the point — the parts already committed must still be
        counted, or the summary understates the run directly above a line
        promising the progress was saved."""

        class _OneThenBoom(_CountingProvider):
            def __init__(self, by_mpn=None):
                super().__init__(by_mpn=by_mpn)
                self.n = 0

            def lookup_mpn(self, mpn):
                self.n += 1
                if self.n > 1:
                    raise RuntimeError("Mouser API HTTP 500 on /search/partnumber")
                return super().lookup_mpn(mpn)

        provider = three_part_provider(cls=_OneThenBoom)

        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        _await_finished(run)

        assert _kinds(run.events) == [
            "sync_started",
            "part_synced",
            "sync_error",
            "sync_finished",
        ]
        assert run.events[-1]["detail"] == "sync aborted"
        assert run.events[-1]["counts"]["synced"] == 1
        assert provider.closed == 1

    def test_an_import_that_blows_up_is_named_for_the_run_the_operator_started(
        self, db, mouser_supplier, three_part_provider
    ):
        """`mode` picks the abort TITLE and the activity labels, and nothing
        else — the wire shape is identical on both routes."""

        def _boom(db_, provider, supplier):
            raise RuntimeError("quota")
            yield  # pragma: no cover - makes this a generator

        provider = three_part_provider()
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="import",
            provider=provider,
            work=_boom,
            session_factory=TestingSessionLocal,
        )
        _await_finished(run)

        assert [e["title"] for e in run.events if e["kind"] == "sync_error"] == ["Import failed"]
        assert run.events[-1]["detail"] == "import aborted"
        stored = sorted(r.kind for r in db.query(ActivityEvent).all())
        assert "import_finished" in stored


class TestLeavingDetachesItNeverCancels:
    """Contract 2 — closing an observer is what a client disconnect DOES."""

    def test_closing_an_observer_mid_run_does_not_stop_the_run(
        self, db, mouser_supplier, three_part_provider
    ):
        provider = three_part_provider(cls=_GatedProvider, block_on=2)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert provider.blocked.wait(WAIT_SECONDS), "the run never reached the gate"

        watcher = run.observe()
        seen = [next(watcher)]
        # EXACTLY what Starlette does to the response body generator when the
        # transport dies.
        watcher.close()
        assert _kinds(seen) == ["sync_started"]
        # Still going, and still holding its provider.
        assert run.running
        assert provider.closed == 0

        provider.release.set()
        _await_finished(run)

        assert _kinds(run.events) == [
            "sync_started",
            "part_synced",
            "part_synced",
            "part_synced",
            "sync_finished",
        ]
        assert run.events[-1]["counts"]["synced"] == 3
        # Closed at WORK end — not when the reader left.
        assert provider.closed == 1
        assert sorted(r.kind for r in db.query(ActivityEvent).all()) == ["part_synced"] * 3 + [
            "sync_finished",
            "sync_started",
        ]

    def test_an_abandoned_observer_is_unsubscribed_so_its_queue_cannot_grow(
        self, db, mouser_supplier, three_part_provider
    ):
        """The detach is bookkeeping, but unbounded bookkeeping is a leak: a
        reader that never comes back must not keep receiving a run's events."""
        provider = three_part_provider(cls=_GatedProvider, block_on=2)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert provider.blocked.wait(WAIT_SECONDS)

        watcher = run.observe()
        next(watcher)
        assert len(run._subscribers) == 1
        watcher.close()
        assert run._subscribers == []

        provider.release.set()
        _await_finished(run)


class TestReattach:
    """Contract 3 — GET /{id}/feed-run is the door back in."""

    def test_reattaching_replays_the_run_so_far_then_follows_it_live(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider
    ):
        provider = three_part_provider(cls=_GatedProvider, block_on=3)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        # Held after the 2nd part, so there is REAL backlog to replay.
        assert provider.blocked.wait(WAIT_SECONDS)

        # Release once the observer is reading, so the response covers both
        # halves: the replay, and then the live tail.
        threading.Timer(0.2, provider.release.set).start()
        resp = client.get(f"/api/suppliers/{mouser_supplier.id}/feed-run", headers=auth_header())

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/x-ndjson")
        assert resp.headers["x-feed-run-id"] == run.run_id
        assert resp.headers["x-feed-run-mode"] == "sync"
        events = [json.loads(line) for line in resp.text.splitlines() if line.strip()]
        assert _kinds(events) == [
            "sync_started",
            "part_synced",
            "part_synced",
            "part_synced",
            "sync_finished",
        ]
        # The SAME terminal event the original socket would have seen.
        assert events[-1]["counts"]["synced"] == 3

    def test_a_finished_run_is_still_readable_inside_the_retention_window(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider
    ):
        """An operator who comes back after the run ended gets the summary,
        not a 404 — losing the socket must not lose the answer."""
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=three_part_provider(),
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        _await_finished(run)

        resp = client.get(f"/api/suppliers/{mouser_supplier.id}/feed-run", headers=auth_header())

        assert resp.status_code == 200
        events = [json.loads(line) for line in resp.text.splitlines() if line.strip()]
        assert _kinds(events)[-1] == "sync_finished"

    def test_the_replay_of_a_finished_run_says_so_in_its_headers(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider
    ):
        """`X-Feed-Run-Active` is what separates "watch this" from "read this".

        A finished run stays readable for the retention window, so a 200 on
        this route is NOT evidence of live work — and the console, which shows
        a live dot and offers Pause off exactly that, spent the whole replay of
        a PAUSED run claiming the run was still going (owner-reported
        2026-08-21). The body cannot say it: a replay looks identical to a live
        stream until the moment it ends.
        """
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="import",
            provider=three_part_provider(),
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        _await_finished(run)

        resp = client.get(f"/api/suppliers/{mouser_supplier.id}/feed-run", headers=auth_header())

        assert resp.status_code == 200
        assert resp.headers["x-feed-run-active"] == "false"
        # Still the whole run — the flag changes how it reads, not what it says.
        events = [json.loads(line) for line in resp.text.splitlines() if line.strip()]
        assert _kinds(events)[-1] == "sync_finished"

    def test_a_run_still_going_is_reported_active(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider
    ):
        provider = three_part_provider(cls=_GatedProvider, block_on=3)
        start_feed_run(
            supplier=mouser_supplier,
            mode="import",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert provider.blocked.wait(WAIT_SECONDS)
        threading.Timer(0.2, provider.release.set).start()

        resp = client.get(f"/api/suppliers/{mouser_supplier.id}/feed-run", headers=auth_header())

        # Read at the moment the headers were built, which is the moment the
        # console needs it: the stream's own ending settles it afterwards.
        assert resp.headers["x-feed-run-active"] == "true"

    def test_starting_a_run_reports_it_active(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider, monkeypatch
    ):
        """Both POST doors share this response builder — a click that STARTS
        a run must never label it finished."""
        _use_fake_provider(monkeypatch, three_part_provider())

        resp = client.post(f"/api/suppliers/{mouser_supplier.id}/sync", headers=auth_header())

        assert resp.status_code == 200
        assert resp.headers["x-feed-run-active"] == "true"

    def test_no_run_is_a_404_not_an_empty_stream(
        self, client, auth_header, feed_key, mouser_supplier
    ):
        """The client PROBES this endpoint to decide whether a run is going.
        An empty 200 would read as "a run with nothing in it"."""
        resp = client.get(f"/api/suppliers/{mouser_supplier.id}/feed-run", headers=auth_header())

        assert resp.status_code == 404
        assert resp.json()["detail"] == "no_feed_run"

    def test_an_unknown_supplier_is_404_and_unauthenticated_is_401(
        self, client, seeded_db, auth_header, feed_key
    ):
        assert client.get(f"/api/suppliers/{uuid.uuid4()}/feed-run").status_code == 401
        assert (
            client.get(f"/api/suppliers/{uuid.uuid4()}/feed-run", headers=auth_header()).status_code
            == 404
        )

    def test_the_demo_account_cannot_watch_a_run_it_cannot_start(
        self, client, db, seeded_db, feed_key, mouser_supplier
    ):
        """`get_current_user` gates the demo on WRITES, so a GET needs its own
        line — otherwise the one account handed to any anonymous visitor can
        read a run it is forbidden to cause."""
        import bcrypt

        from app.models import User

        db.add(
            User(
                id=uuid.uuid4(),
                username="demo",
                password_hash=bcrypt.hashpw(b"demo", bcrypt.gensalt()).decode(),
                role="admin",
                email="demo@circuitcenter.ai",
            )
        )
        db.commit()
        token = client.post("/api/auth/demo").json()["token"]

        resp = client.get(
            f"/api/suppliers/{mouser_supplier.id}/feed-run",
            headers={"Authorization": f"Bearer {token}"},
        )

        assert resp.status_code == 403
        assert resp.json()["detail"] == "demo_account_read_only"


class TestOneRunPerSupplier:
    """Contract 4 — a second click is refused, never double-spent."""

    def test_a_second_click_while_a_run_is_going_is_409_and_spends_nothing(
        self,
        client,
        db,
        auth_header,
        feed_key,
        mouser_supplier,
        three_part_provider,
        monkeypatch,
    ):
        held = three_part_provider(cls=_GatedProvider, block_on=2)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=held,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert held.blocked.wait(WAIT_SECONDS)

        second = _use_fake_provider(monkeypatch, three_part_provider())
        resp = client.post(f"/api/suppliers/{mouser_supplier.id}/sync", headers=auth_header())

        assert resp.status_code == 409
        assert resp.json()["detail"] == "feed_run_already_active"
        # The refused click spent no quota — and released the provider it had
        # already built rather than leaking its connection pool.
        assert second.calls_made == 0
        assert second.closed == 1

        held.release.set()
        _await_finished(run)

    def test_a_finished_run_does_not_block_the_next_one(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider, monkeypatch
    ):
        """Retention keeps a finished run readable; it must not keep the
        supplier locked."""
        first = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=three_part_provider(),
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        _await_finished(first)

        _use_fake_provider(monkeypatch, three_part_provider())
        resp = client.post(f"/api/suppliers/{mouser_supplier.id}/sync", headers=auth_header())

        assert resp.status_code == 200
        assert get_feed_run(mouser_supplier.id).run_id != first.run_id

    def test_start_feed_run_raises_rather_than_queueing(
        self, db, mouser_supplier, three_part_provider
    ):
        held = three_part_provider(cls=_GatedProvider, block_on=2)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=held,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert held.blocked.wait(WAIT_SECONDS)

        with pytest.raises(FeedRunActive):
            start_feed_run(
                supplier=mouser_supplier,
                mode="sync",
                provider=three_part_provider(),
                work=_sync_work(),
                session_factory=TestingSessionLocal,
            )

        held.release.set()
        _await_finished(run)


class TestHeartbeat:
    """Keep-alive traffic must never be mistaken for an event.

    nginx cuts an idle proxied response at 60 s and neither nginx config sets
    `proxy_read_timeout`, so a run that is legitimately silent needs to put a
    byte on the wire. A bare newline is the cheapest thing that is not an
    event: NDJSON readers skip blank lines (the admin client's `parseNdjson`
    does, and so does every helper in this suite).
    """

    def test_observe_ticks_none_while_the_run_is_silent(
        self, db, mouser_supplier, three_part_provider
    ):
        provider = three_part_provider(cls=_GatedProvider, block_on=2)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert provider.blocked.wait(WAIT_SECONDS)

        watcher = run.observe(heartbeat_seconds=0.01)
        # The backlog drains first; the run is then wedged at the gate, so
        # everything after it is a tick and nothing else.
        seen: list[dict] = []
        ticks = 0
        for item in watcher:
            if item is None:
                ticks += 1
                if ticks == 2:
                    break
            else:
                assert ticks == 0, "an event arrived after the run had gone silent"
                seen.append(item)
        watcher.close()

        assert ticks == 2
        assert _kinds(seen)[0] == "sync_started"

        provider.release.set()
        _await_finished(run)

    def test_the_wire_carries_blank_lines_that_parse_to_no_events(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider, monkeypatch
    ):
        monkeypatch.setattr("app.routes.suppliers.FEED_RUN_HEARTBEAT_SECONDS", 0.02)
        provider = three_part_provider(cls=_GatedProvider, block_on=3)
        start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert provider.blocked.wait(WAIT_SECONDS)

        threading.Timer(0.3, provider.release.set).start()
        resp = client.get(f"/api/suppliers/{mouser_supplier.id}/feed-run", headers=auth_header())

        assert resp.status_code == 200
        raw = resp.text.splitlines()
        assert any(not line.strip() for line in raw), "no heartbeat reached the wire"
        events = [json.loads(line) for line in raw if line.strip()]
        assert _kinds(events) == [
            "sync_started",
            "part_synced",
            "part_synced",
            "part_synced",
            "sync_finished",
        ]


def _post_and_hang_up(path, headers, stop_after=1):
    """Drive the ASGI app directly and drop the connection mid-stream.

    `TestClient` cannot express the failure this whole file is about: it
    BUFFERS a streaming response, running the app to completion before handing
    back a body, so nothing it does can disconnect in the middle of a run.
    uvicorn's behaviour is the one that matters — a dead socket becomes an
    `http.disconnect` message, Starlette cancels the response body, and the
    generator driving it is closed. That is exactly what happens here: no
    socket, the same protocol event, deterministic.

    `spec_version` is pinned below 2.4 on purpose. Starlette takes the
    task-group/`listen_for_disconnect` path there and the `ClientDisconnect`
    path at or above it; both abandon the body, and pinning one keeps this
    asserting BEHAVIOUR rather than which branch the installed version picks.

    Returns the events the reader saw before it hung up.
    """
    received: list[dict] = []

    async def main():
        hang_up = anyio.Event()
        state = {"first": True, "buffer": ""}

        async def receive():
            if state["first"]:
                state["first"] = False
                return {"type": "http.request", "body": b"", "more_body": False}
            await hang_up.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] != "http.response.body":
                return
            state["buffer"] += message.get("body", b"").decode()
            while "\n" in state["buffer"]:
                line, state["buffer"] = state["buffer"].split("\n", 1)
                if line.strip():
                    received.append(json.loads(line))
            if len(received) >= stop_after:
                hang_up.set()

        await fastapi_app(
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "root_path": "",
                "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
                "client": ("testclient", 50000),
                "server": ("testserver", 80),
            },
            receive,
            send,
        )

    anyio.run(main)
    return received


class TestARealDisconnectOnTheRoute:
    """Contract 1+2 again, but through the ROUTE and through a genuine
    `http.disconnect` — the exact event that used to end the import.

    The observer-level tests above pin the seam; this one pins the wiring, and
    it is the test that would have FAILED against the old design: there, the
    response body WAS `grow_catalog`, so hanging up here stopped the work
    where it stood and left a `200 OK` in the log as the only trace.
    """

    def test_hanging_up_mid_stream_leaves_the_run_running_and_it_finishes(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider, monkeypatch
    ):
        # A short heartbeat so the cancelled body generator is between queue
        # waits (not parked for 20 s) when the disconnect lands — anyio cannot
        # interrupt a threadpool call already in flight, only stop pulling.
        monkeypatch.setattr("app.routes.suppliers.FEED_RUN_HEARTBEAT_SECONDS", 0.02)
        provider = _use_fake_provider(
            monkeypatch, three_part_provider(cls=_GatedProvider, block_on=2)
        )

        seen = _post_and_hang_up(
            f"/api/suppliers/{mouser_supplier.id}/sync", auth_header(), stop_after=2
        )

        assert _kinds(seen) == ["sync_started", "part_synced"]
        assert provider.blocked.wait(WAIT_SECONDS), "the run never reached the gate"
        run = get_feed_run(mouser_supplier.id)
        assert run is not None and run.running, "the disconnect ended the run"
        assert provider.closed == 0, "the reader leaving released the provider pool"

        provider.release.set()
        _await_finished(run)

        assert _kinds(run.events) == [
            "sync_started",
            "part_synced",
            "part_synced",
            "part_synced",
            "sync_finished",
        ]
        assert provider.closed == 1
        # The two parts nobody was watching are in the durable record.
        assert sorted(r.kind for r in db.query(ActivityEvent).all()) == ["part_synced"] * 3 + [
            "sync_finished",
            "sync_started",
        ]

    def test_the_operator_can_come_back_after_hanging_up(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider, monkeypatch
    ):
        """The end-to-end shape of the fix: click, lose the socket, re-attach,
        watch the same run through to its ending."""
        monkeypatch.setattr("app.routes.suppliers.FEED_RUN_HEARTBEAT_SECONDS", 0.02)
        provider = _use_fake_provider(
            monkeypatch, three_part_provider(cls=_GatedProvider, block_on=3)
        )

        _post_and_hang_up(f"/api/suppliers/{mouser_supplier.id}/sync", auth_header(), stop_after=1)
        assert provider.blocked.wait(WAIT_SECONDS)

        run = get_feed_run(mouser_supplier.id)
        threading.Timer(0.05, provider.release.set).start()
        resp = client.get(f"/api/suppliers/{mouser_supplier.id}/feed-run", headers=auth_header())

        assert resp.status_code == 200
        assert resp.headers["x-feed-run-id"] == run.run_id
        events = [json.loads(line) for line in resp.text.splitlines() if line.strip()]
        # Replayed from the TOP — including the event the dead socket already
        # showed — and then live to the same ending.
        assert _kinds(events) == [
            "sync_started",
            "part_synced",
            "part_synced",
            "part_synced",
            "sync_finished",
        ]


class TestRegistryBounds:
    """Retention keeps a finished run readable for an operator who lost the
    view. It is in-process memory holding whole event lists, so it must also
    forget: bounded by a TTL and by a hard cap, and never at the expense of a
    run that is still going.

    (The other in-process limit is stated rather than tested: with more than
    one uvicorn worker a re-attach can land on a worker that never held the
    run, and `activity_events` is the fallback.)
    """

    def _retained(self, finished_ago=0.0):
        run = importer_module.FeedRun(uuid.uuid4(), "retained", "sync")
        run._finish()
        run.finished_at = time.time() - finished_ago
        importer_module._RUNS[run.supplier_id] = run
        return run

    def test_a_finished_run_is_forgotten_once_the_window_passes(self):
        run = self._retained(finished_ago=importer_module._RUN_RETENTION_SECONDS + 1)

        assert get_feed_run(run.supplier_id) is None

    def test_retained_runs_are_capped(self):
        for _ in range(importer_module._MAX_RETAINED_RUNS + 5):
            self._retained()

        get_feed_run(uuid.uuid4())  # any lookup purges

        assert len(importer_module._RUNS) == importer_module._MAX_RETAINED_RUNS

    def test_a_run_still_going_is_never_evicted(self):
        live = importer_module.FeedRun(uuid.uuid4(), "live", "import")
        importer_module._RUNS[live.supplier_id] = live
        for _ in range(importer_module._MAX_RETAINED_RUNS + 5):
            self._retained(finished_ago=importer_module._RUN_RETENTION_SECONDS + 1)

        assert get_feed_run(live.supplier_id) is live


class TestPauseIsAClick:
    """Owner requirement (2026-08-21): clicking Import/Sync while a run is
    active PAUSES it. Pause = wind down at the next safe part — the part in
    hand finishes and commits, the run ends with its real tally and a detail
    that says so, and (for imports) the cursor makes the next click resume.
    Never a freeze-in-place: a paused run holds no thread, session or provider.
    """

    def test_pause_winds_down_at_the_next_safe_part(self, db, mouser_supplier, three_part_provider):
        from app.services.part_feed.importer import request_feed_stop

        provider = three_part_provider(cls=_GatedProvider, block_on=2)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert provider.blocked.wait(WAIT_SECONDS), "the run never reached the gate"

        assert request_feed_stop(mouser_supplier.id) == run.run_id

        provider.release.set()
        _await_finished(run)

        # Part 2 was in hand when the stop landed: it completes and commits;
        # part 3 is never attempted.
        assert _kinds(run.events) == [
            "sync_started",
            "part_synced",
            "part_synced",
            "sync_finished",
        ]
        assert run.events[-1]["counts"]["synced"] == 2
        assert "paused" in run.events[-1]["detail"]
        assert provider.closed == 1
        assert provider.lookups == 2

    def test_a_paused_run_frees_the_slot(self, db, mouser_supplier, three_part_provider):
        from app.services.part_feed.importer import request_feed_stop

        provider = three_part_provider(cls=_GatedProvider, block_on=1)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert provider.blocked.wait(WAIT_SECONDS)
        request_feed_stop(mouser_supplier.id)
        provider.release.set()
        _await_finished(run)

        # The next click starts a FRESH run — no 409 from a paused one.
        second = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=three_part_provider(cls=_CountingProvider),
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        _await_finished(second)
        assert second.run_id != run.run_id
        assert second.events[-1]["kind"] == "sync_finished"

    def test_pause_route_contract(
        self, client, db, auth_header, feed_key, mouser_supplier, three_part_provider
    ):
        provider = three_part_provider(cls=_GatedProvider, block_on=1)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=provider,
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        assert provider.blocked.wait(WAIT_SECONDS)

        resp = client.post(
            f"/api/suppliers/{mouser_supplier.id}/feed-run/pause", headers=auth_header()
        )
        assert resp.status_code == 200
        assert resp.json() == {"pausing": True, "run_id": run.run_id}

        provider.release.set()
        _await_finished(run)
        assert "paused" in run.events[-1]["detail"]

        # After the run ends there is nothing active to pause.
        resp2 = client.post(
            f"/api/suppliers/{mouser_supplier.id}/feed-run/pause", headers=auth_header()
        )
        assert resp2.status_code == 404
        assert resp2.json()["detail"] == "no_feed_run"

    def test_pause_requires_auth_and_a_real_supplier(
        self, client, seeded_db, auth_header, feed_key
    ):
        assert client.post(f"/api/suppliers/{uuid.uuid4()}/feed-run/pause").status_code == 401
        assert (
            client.post(
                f"/api/suppliers/{uuid.uuid4()}/feed-run/pause", headers=auth_header()
            ).status_code
            == 404
        )


class TestARunBustsTheSearchCaches:
    """A feed run rewrites the catalog, so the search TTL caches (derived
    manufacturers, did-you-mean vocabulary, popular-backfill pool) are stale
    the moment it ends. Without the bust an operator watched a run report
    "created: 40" and then searched for none of them for up to ten minutes."""

    def _count_busts(self, monkeypatch):
        from app.services.part_feed import importer as importer_module

        calls: list[int] = []
        monkeypatch.setattr(importer_module, "invalidate_catalog_caches", lambda: calls.append(1))
        return calls

    def test_exactly_once_per_run_not_once_per_part(
        self, db, mouser_supplier, three_part_provider, monkeypatch
    ):
        calls = self._count_busts(monkeypatch)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=three_part_provider(),
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        _await_finished(run)
        # Three parts synced, ONE bust — per-part would clear the cache on
        # every row and make every intervening search re-derive from scratch.
        assert run.events[-1]["counts"]["synced"] == 3
        assert len(calls) == 1

    def test_a_run_that_blows_up_still_busts(
        self, db, mouser_supplier, three_part_provider, monkeypatch
    ):
        """A failed run still committed the parts it got through, so its
        partial writes have to reach search too — the bust lives in the
        worker's `finally`, not on the happy path."""

        def _boom(db_, provider, supplier):
            raise RuntimeError("Mouser API HTTP 500")
            yield  # pragma: no cover - makes this a generator

        calls = self._count_busts(monkeypatch)
        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=three_part_provider(),
            work=_boom,
            session_factory=TestingSessionLocal,
        )
        _await_finished(run)
        assert "sync_error" in _kinds(run.events)
        assert len(calls) == 1

    def test_a_real_run_leaves_the_caches_cold(self, db, mouser_supplier, three_part_provider):
        """No monkeypatching and no clock travel: warm all three caches, run
        the feed for real, and every one of them is gone — so the next search
        re-derives from the catalog the run just wrote."""
        from app.services import search_service

        search_service.search(db, "zzzznothingmatches")  # warms all three
        assert search_service._manufacturers_cache is not None
        assert search_service._vocab_cache is not None
        assert search_service._backfill_ids_cache is not None

        run = start_feed_run(
            supplier=mouser_supplier,
            mode="sync",
            provider=three_part_provider(),
            work=_sync_work(),
            session_factory=TestingSessionLocal,
        )
        _await_finished(run)

        assert search_service._manufacturers_cache is None
        assert search_service._vocab_cache is None
        assert search_service._backfill_ids_cache is None
