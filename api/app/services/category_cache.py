"""Per-process cache of RENDERED category pages, with stale-while-revalidate.

Owner, 2026-09-11: "is there a way to prevent the site from needing to
re-query the category pages" — the connectors page (115k parts) cost 3.3s
warm and 6.8s cold on every visit, for every visitor, because nothing between
Postgres and the browser remembered the answer. The response for a given
(slug, query) is the same for everyone, and the catalog changes a few times a
day, so the API keeps the bytes it last sent:

  * FRESH  (< FRESH_SECONDS)  — served as-is, no query.
  * STALE  (< USABLE_SECONDS) — served as-is, and rebuilt ONCE in a
    background thread with its own session, so the visitor who trips the
    expiry still gets the instant answer and the next one gets a new one.
  * older, or absent          — rendered on the request.

A warmer thread renders every category's canonical first page at startup
and again on an interval, so the pages everyone lands on are never rendered
on a visitor's clock at all.

Correctness comes from `clear()`, which the catalog-mutation seam
(`search_service.invalidate_catalog_caches`) and the sponsor writers call:
an admin's edit is visible on the next request. The TTLs bound what the
seam cannot see — the nightly feed-import container writes from ANOTHER
process, so its parts land within FRESH_SECONDS plus a warm cycle.

Single uvicorn worker (settings.API_WORKERS) means one process holds the one
cache; the lock is for the request threadpool + the refresh/warm threads.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass

FRESH_SECONDS = 10 * 60
USABLE_SECONDS = 60 * 60
MAX_ENTRIES = 256
WARM_INTERVAL_SECONDS = 25 * 60
WARM_INITIAL_DELAY_SECONDS = 3.0

Rendered = tuple[bytes, str]  # (body, etag)

# Where a rebuild or a warm gets its database session. The app's factory in
# production; conftest points it at the test engine so a synchronous rebuild
# under pytest reads the same in-memory database the test wrote.
from app.db.session import SessionLocal  # noqa: E402

session_factory: Callable[[], object] = SessionLocal
Rebuild = Callable[[], Rendered | None]


@dataclass
class Entry:
    body: bytes
    etag: str
    at: float
    rebuild: Rebuild


_lock = threading.Lock()
_entries: OrderedDict[str, Entry] = OrderedDict()
_refreshing: set[str] = set()
# Tests flip this off so a stale hit rebuilds synchronously on the request's
# own thread (a background thread would race the test's session).
background_refresh = True


def key_for(slug: str, params: Iterable[tuple[str, object]]) -> str:
    """One key per distinct page: the slug plus the sorted, normalised params.
    Lists are sorted so `mfg=a&mfg=b` and `mfg=b&mfg=a` share an entry."""
    parts = []
    for name, value in sorted(params, key=lambda kv: kv[0]):
        if isinstance(value, list | tuple | set | frozenset):
            value = ",".join(sorted(str(v) for v in value))
        parts.append(f"{name}={value}")
    return f"{slug}?{'&'.join(parts)}"


def get(key: str) -> Entry | None:
    with _lock:
        entry = _entries.get(key)
        if entry is not None:
            _entries.move_to_end(key)
        return entry


def put(key: str, body: bytes, etag: str, rebuild: Rebuild) -> None:
    with _lock:
        _entries[key] = Entry(body=body, etag=etag, at=time.monotonic(), rebuild=rebuild)
        _entries.move_to_end(key)
        while len(_entries) > MAX_ENTRIES:
            _entries.popitem(last=False)


def age(entry: Entry) -> float:
    return time.monotonic() - entry.at


def is_fresh(entry: Entry) -> bool:
    return age(entry) < FRESH_SECONDS


def is_usable(entry: Entry) -> bool:
    return age(entry) < USABLE_SECONDS


def clear() -> None:
    """Forget every page. Called on any catalog or sponsor mutation."""
    with _lock:
        _entries.clear()


def size() -> int:
    with _lock:
        return len(_entries)


def refresh(key: str, entry: Entry) -> None:
    """Rebuild a STALE entry — once, in the background, while it keeps serving."""
    if not background_refresh:
        _rebuild(key, entry)
        return
    with _lock:
        if key in _refreshing:
            return
        _refreshing.add(key)
    threading.Thread(target=_rebuild_guarded, args=(key, entry), daemon=True).start()


def _rebuild_guarded(key: str, entry: Entry) -> None:
    try:
        _rebuild(key, entry)
    finally:
        with _lock:
            _refreshing.discard(key)


def _rebuild(key: str, entry: Entry) -> None:
    try:
        rendered = entry.rebuild()
    except Exception:  # noqa: BLE001 - a failed refresh keeps serving the old page
        return
    if rendered is None:
        with _lock:
            _entries.pop(key, None)
        return
    put(key, rendered[0], rendered[1], entry.rebuild)


# ── Warming ────────────────────────────────────────────────────────────────

_warmer: threading.Thread | None = None


def start_warmer(warm: Callable[[], None], interval: float = WARM_INTERVAL_SECONDS) -> None:
    """Run `warm()` shortly after startup and then every `interval` seconds,
    on a daemon thread. Idempotent per process."""
    global _warmer
    if _warmer is not None and _warmer.is_alive():
        return

    def loop() -> None:
        time.sleep(WARM_INITIAL_DELAY_SECONDS)
        while True:
            try:
                warm()
            except Exception:  # noqa: BLE001 - warming is best-effort; requests still render
                pass
            time.sleep(interval)

    _warmer = threading.Thread(target=loop, name="category-cache-warmer", daemon=True)
    _warmer.start()


def _reset_for_tests() -> None:
    global background_refresh
    with _lock:
        _entries.clear()
        _refreshing.clear()
    background_refresh = False
