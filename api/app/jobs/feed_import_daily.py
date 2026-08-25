"""Nightly catalog import — one pass a night, per supplier, inside one budget.

Runs as the `feed-import` compose service. Structure mirrors
app/jobs/sync_costs.py: a pure ``run_once(db, now)`` that tests drive directly,
and a ``main()`` that owns nothing but the clock and the session.

Five properties shape every line below, and each is a test:

**1. The toggle stores INTENT; capability is re-derived at run time.** A
supplier is eligible only if ``supplier_feeds.auto_import_enabled`` is on AND
``match_provider`` still covers it AND ``get_feed_key`` still answers for THAT
provider. The switch was validated when it was flipped, but a key can be
rotated away or a website edited months later — a supplier that can no longer
run is skipped with a log line, never an error, and its switch is left exactly
as the operator set it (see `routes/suppliers.update_feed_settings`, which
refuses to ENABLE without a key but always allows disabling, for the same
reason).

**2. The budget is the loop bound, split evenly, and capped globally.** Every
provider call is a share of a ~1,000/day free tier, so the night gets
``FEED_IMPORT_CALL_BUDGET`` calls total and each eligible supplier gets an even
slice of it. Spend is measured on the provider's OWN counter afterwards, not
assumed from the slice, and the loop stops when the total is gone — so a run
that overshoots one slice cannot quietly borrow the next supplier's.

**3. A quota wall ends the NIGHT; anything else ends one supplier.** The quota
belongs to the API KEY, which is account-wide: continuing after a 429 spends
nothing but wasted requests against every remaining supplier. ``grow_catalog``
catches ``FeedFatalError`` itself and converts it into a ``sync_error`` event
before returning, so on this path THAT EVENT — not an exception — is the wall's
only signal; the ``except FeedFatalError`` below covers the paths where one can
still escape (constructing the provider, a future generator). Any OTHER
exception is one supplier's problem: roll back, log one warning, move to the
next. A nightly job that dies on the third of eight suppliers silently stops
importing for the other five.

**4. Every event goes through ``record_stream_event``, labelled as an
import.** There is no socket here — nobody is watching — so these rows ARE the
run: the dashboard's Recent Activity strip is the only place a nightly import
is ever visible. ``IMPORT_EVENT_KINDS`` files the run-level events under
``import_started``/``import_finished`` so the strip can say "Inventory import"
about a run nobody clicked, without changing a byte of the wire shape the
console parses.

**5. A not-yet-migrated schema is one warning, not a traceback.** Same
reasoning as app/jobs/send_reminders.py: `alembic upgrade head` runs in the API
container's entrypoint and nothing orders this loop after it, so on a deploy
carrying a new migration there is a window where `supplier_feeds` does not
exist yet. The next pass is a day away, nothing is lost by skipping one, and a
traceback on a timer trains everyone to ignore this container's logs.

Operator lever (a manual run, outside the schedule):

    docker compose run --rm feed-import python -m app.jobs.feed_import_daily --once
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import SessionLocal
from app.models import Supplier, SupplierFeed
from app.services.activity import IMPORT_EVENT_KINDS, record_stream_event
from app.services.feed_lock import supplier_feed_lock
from app.services.part_feed import (
    PartFeedProvider,
    get_feed_key,
    grow_catalog,
    match_provider,
    registry,
)
from app.services.part_feed.mouser import FeedFatalError

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Target:
    """One supplier the night will actually run, with what it needs to run it.

    The Supplier ROW travels with it (``grow_catalog`` attaches listings to the
    passed row — a name-matched twin would split the catalog), alongside the
    two scalars the log lines use. The provider is a CLASS plus the key
    resolved for ITS slug, never a built instance: one provider per supplier
    per run, built inside the loop and closed there, so a failure while
    constructing it is one supplier's problem and no HTTP pool outlives the
    supplier it belongs to.
    """

    supplier: Supplier
    name: str
    provider_cls: type[PartFeedProvider]
    api_key: str
    provider_slug: str = "mouser"


def seconds_until_hour(hour_utc: int, now: datetime) -> float:
    """Seconds from `now` to the next ``hour_utc``:00:00 UTC.

    A pure function because it is the whole schedule: the loop sleeps this long
    and then imports. Sleeping to a BOUNDARY rather than for a fixed 24 hours
    is what makes "06:00 UTC" mean 06:00 rather than "whenever the container
    last started, plus a day" — a redeploy would otherwise walk the run time
    across the clock and eventually into the working day, competing with the
    admin's own clicks for the same daily quota.

    Never returns 0: landing exactly on the boundary means the next run is
    tomorrow's, not a second pass of tonight's.
    """
    hour = max(0, min(23, int(hour_utc)))
    target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


NIGHTLY_STRATEGIES: frozenset[str] = frozenset({"category", "family"})
"""Which import strategies may run UNATTENDED. One line to widen.

Both reasons to hold the family sweep back are about things this job cannot
currently do, not about the sweep being unfinished:

**The budget has the wrong shape.** `run_once` splits ONE
`FEED_IMPORT_CALL_BUDGET` evenly across every eligible supplier, and the two
distributors are not comparable spenders. At DigiKey's `_MIN_GAP_SECONDS =
0.55` its whole 1,000-call day burns in roughly eight minutes of wall clock;
the same slice against Mouser takes hours. An even split either starves the
category sweep or hands DigiKey a slice it empties before anyone is awake — and
the daytime Import clicks share that same daily quota.

**Nobody owns `lifecycle_status` yet.** `_stamp_feed_facts` writes it through
`map_lifecycle` from DigiKey's `ProductStatus.Status` and Mouser's
`LifecycleStatus` — two vocabularies over one column. Measured on production:
all 175,728 parts carry a `lifecycle_status` but only 3,181 have a
`lifecycle_verified_at`, so a first DigiKey touch legitimately writes each part
once. It is the SECOND night that is the problem: wherever the two mappings
disagree, each feed flips the column back to its own word and every flip
rewrites all eight of the table's indexes — the same write-waste class commit
9e4abd0 just removed. The disagreement rate is not measurable yet (it needs
live data from both feeds over the same parts), and a provider-authority or
no-downgrade rule belongs in front of the first unattended run, not after it.

Until then DigiKey is admin-click-only: the operator is present, watching the
console, and spending a budget they chose.
"""


def _eligible(db: Session) -> list[_Target]:
    """Suppliers whose nightly import is switched ON *and* could run right now.

    Two halves, deliberately separate: the QUERY reads the operator's intent
    (`auto_import_enabled`), and the loop re-derives CAPABILITY — provider match
    plus a key for that provider — against today's data. The switch cannot store
    capability: it was validated when it was flipped, and the key it depended on
    may since have been rotated away.
    """
    rows = (
        db.query(Supplier)
        .join(SupplierFeed, SupplierFeed.supplier_id == Supplier.id)
        .filter(SupplierFeed.auto_import_enabled.is_(True))
        .order_by(Supplier.name)
        .all()
    )
    targets: list[_Target] = []
    for supplier in rows:
        name = supplier.name
        match = match_provider(supplier)
        if match is None:
            logger.warning(
                "[feed-import] %s is enabled but no provider covers it now — skipping", name
            )
            continue
        provider_slug, provider_cls = match
        if getattr(provider_cls, "import_strategy", "category") not in NIGHTLY_STRATEGIES:
            logger.warning(
                "[feed-import] %s runs the %r import strategy, which is interactive-only "
                "for now — skipping tonight and leaving its switch alone",
                name,
                getattr(provider_cls, "import_strategy", "category"),
            )
            continue
        key = get_feed_key(db, provider_slug)
        if not key:
            # NEVER log the key, and never log its absence as an error: an
            # operator who removed a credential did that on purpose.
            logger.warning(
                "[feed-import] %s is enabled but its feed has no key configured — skipping", name
            )
            continue
        targets.append(
            _Target(
                supplier=supplier,
                name=name,
                provider_cls=provider_cls,
                api_key=key,
                provider_slug=provider_slug,
            )
        )
    return targets


def _stamp_run(db: Session, supplier_id, now: datetime) -> None:
    """Record that this supplier's feed RAN — not that it succeeded.

    Success lives in the activity rows (`import_finished` carries the counts);
    this column answers "when did we last spend calls on this supplier", which
    stays true for an aborted run and is the number any future ordering or
    staleness rule wants. Committed on its own so a later supplier's failure
    cannot roll it back.
    """
    row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier_id).first()
    if row is None:  # deleted mid-run; nothing to stamp
        return
    row.last_synced_at = now
    db.commit()


def _import_one(db: Session, target: _Target, call_budget: int) -> dict:
    """Run ONE supplier's import, recording every event. Never raises.

    Returns what the night needs to know: what it produced, what it spent, and
    whether it hit the account-wide wall (which stops every remaining
    supplier — see the module docstring).
    """
    stats = {
        "created": 0,
        "synced": 0,
        # A distributor's FIRST offer on a part we already hold. Counted apart
        # from `created` (no new part) and from `synced` (no refresh) because
        # it is neither, and on a comparison site it is the most valuable thing
        # an import produces — a second price beside an existing one. It went
        # uncounted here from the day `grow_catalog` started emitting it, so a
        # night that added hundreds of comparison rows logged `created=0
        # updated=0` and read as a night that did nothing.
        "listing_added": 0,
        "calls": 0,
        "fatal": False,
        "error": False,
        "skipped_locked": False,
    }
    provider = None
    try:
        # This job runs in the `feed-import` CONTAINER, so the api process's
        # in-memory run registry cannot see it and its 409 never fires here.
        # Without this claim an admin Import click during the sweep runs a
        # SECOND pass over the same supplier, and `_save_import_cursor` writes
        # the whole cursor map from a run-start snapshot — so whichever
        # finishes last silently throws away the other's paging depth.
        with supplier_feed_lock(db.get_bind(), target.supplier.id) as claimed:
            if not claimed:
                stats["skipped_locked"] = True
                logger.info(
                    "[feed-import] %s: another process holds this supplier's feed "
                    "lock — skipping tonight rather than double-sweeping",
                    target.name,
                )
                return stats
            provider = target.provider_cls.from_credential(target.api_key)
            for event in grow_catalog(db, provider, target.supplier, call_budget=call_budget):
                record_stream_event(db, target.supplier.id, event, IMPORT_EVENT_KINDS)
                action = event.get("action")
                if action == "created":
                    stats["created"] += 1
                elif action == "listing_added":
                    stats["listing_added"] += 1
                elif action in ("updated", "media_filled"):
                    stats["synced"] += 1
                elif event.get("kind") == "sync_error":
                    # `grow_catalog` only ever emits this for a FeedFatalError —
                    # it catches the exception, reports it, and returns normally.
                    # So the EVENT is the wall on this path; the except clause
                    # below covers the paths where the error can still escape.
                    stats["fatal"] = True
    except FeedFatalError as exc:
        db.rollback()
        stats["fatal"] = True
        # str(exc) carries no API key — mouser.py never puts one in a message.
        logger.warning("[feed-import] %s: feed unavailable — %s", target.name, exc)
    except Exception:  # noqa: BLE001
        # One supplier's problem, not the night's: a malformed row, a 500 from
        # the provider, a bug. Roll back the half-finished transaction (the
        # per-part commits inside the generator already survived it), say so
        # once, and let the caller move on.
        db.rollback()
        stats["error"] = True
        logger.warning("[feed-import] %s: import failed — continuing", target.name, exc_info=True)
    finally:
        # One provider (and its HTTP connection pool) per supplier, released
        # whether the run finished, aborted, or hit the wall.
        close = getattr(provider, "close", None)
        if callable(close):
            close()
    if provider is not None:
        stats["calls"] = int(getattr(provider, "calls_made", 0) or 0)
    return stats


def run_once(db: Session, now: datetime | None = None) -> dict:
    """One night's import. Sleep-free and side-effect-contained, so tests drive
    it directly and `main()` only has to decide WHEN.

    Returns a summary dict (also the shape of the closing log line).
    """
    now = now or datetime.now(UTC)
    stats = {
        "suppliers": 0,
        "created": 0,
        "synced": 0,
        "listing_added": 0,
        "calls": 0,
        "errors": 0,
        "skipped_locked": 0,
        "stopped_early": False,
    }
    try:
        targets = _eligible(db)
    except ProgrammingError as exc:
        # The table does not exist yet — `alembic upgrade head` runs in the api
        # container's entrypoint and nothing orders this loop after it. One
        # warning; the next pass is a day away and nothing is lost.
        db.rollback()
        if "does not exist" in str(exc.orig).lower():
            logger.warning("[feed-import] supplier_feeds is not migrated yet — skipping this pass")
            return stats
        raise
    if not targets:
        logger.info("[feed-import] no supplier has the nightly import enabled — nothing to do")
        return stats

    # PER PROVIDER, not one pooled number. Each distributor sells its own daily
    # allowance (~1,000 for both today), so a single shared budget both
    # under-used them — 425 each of one 850 — and let whichever ran first spend
    # the other's day. `registry.call_budget` reads FEED_IMPORT_CALL_BUDGETS
    # with the scalar as fallback, so a newly registered distributor still runs
    # without an ops change.
    budgets = {t.provider_slug: registry.call_budget(t.provider_slug) for t in targets}
    per_provider_count: dict[str, int] = {}
    for t in targets:
        per_provider_count[t.provider_slug] = per_provider_count.get(t.provider_slug, 0) + 1
    # An even slice within a provider, floor-divided, never zero: a slice of 0
    # starts a run that can only report it did nothing. The per-provider cap
    # below is what stops `max(1, ...)` overspending.
    per_supplier = {slug: max(1, budgets[slug] // n) for slug, n in per_provider_count.items()}
    spent: dict[str, int] = dict.fromkeys(budgets, 0)
    logger.info(
        "[feed-import] %d supplier(s) enabled across %d provider(s) · %s",
        len(targets),
        len(budgets),
        " · ".join(
            f"{slug} {budgets[slug]} calls / {per_supplier[slug]} each" for slug in sorted(budgets)
        ),
    )

    for target in targets:
        slug = target.provider_slug
        remaining = budgets[slug] - spent[slug]
        if remaining <= 0:
            logger.warning(
                "[feed-import] %s's call budget (%d) is spent — %s did not run tonight. "
                "Other providers are unaffected.",
                slug,
                budgets[slug],
                target.name,
            )
            stats["stopped_early"] = True
            continue
        result = _import_one(db, target, min(per_supplier[slug], remaining))
        spent[slug] += result.get("calls", 0)
        if result["skipped_locked"]:
            # Nothing ran and nothing was spent, so this supplier is NOT one of
            # tonight's. Crucially it must not be stamped either: `_stamp_run`
            # records "when did we last spend calls here", and claiming a run
            # that never happened is how a supplier silently stops being
            # imported. It stays visible in the summary instead.
            stats["skipped_locked"] += 1
            continue
        stats["suppliers"] += 1
        stats["created"] += result["created"]
        stats["synced"] += result["synced"]
        stats["listing_added"] += result["listing_added"]
        stats["calls"] += result["calls"]
        if result["error"] or result["fatal"]:
            stats["errors"] += 1
        _stamp_run(db, target.supplier.id, now)
        # Counts only — never a key, never a part title (an unbounded feed
        # string). The activity rows carry the detail.
        logger.info(
            "[feed-import] %s: created=%d listings_added=%d updated=%d calls=%d",
            target.name,
            result["created"],
            result["listing_added"],
            result["synced"],
            result["calls"],
        )
        if result["fatal"]:
            # The quota belongs to the KEY, not to this supplier: every
            # remaining run would spend requests to be refused identically.
            logger.warning(
                "[feed-import] feed quota/auth wall reached — stopping the night after %s",
                target.name,
            )
            stats["stopped_early"] = True
            break
    return stats


def _one_pass() -> None:
    db = SessionLocal()
    try:
        stats = run_once(db)
    except OperationalError:
        # The database is not accepting connections (a deploy, a restart).
        db.rollback()
        logger.warning("[feed-import] database unreachable — skipping this pass")
        return
    except Exception:  # noqa: BLE001
        # The pass is the unit of work: log it whole and let the next night
        # try again, rather than crash-looping a container that would spend
        # provider calls on every restart.
        db.rollback()
        logger.exception("[feed-import] pass failed")
        return
    finally:
        db.close()
    logger.info(
        "[feed-import] pass: suppliers=%(suppliers)d created=%(created)d "
        "listings_added=%(listing_added)d updated=%(synced)d calls=%(calls)d "
        "errors=%(errors)d",
        stats,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Nightly distributor-feed catalog import.")
    parser.add_argument(
        "--once", action="store_true", help="run a single pass now and exit (operator one-shot)"
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    if args.once:
        _one_pass()
        return 0
    while True:
        # SLEEP FIRST. A container restart must not spend the day's quota the
        # moment it comes up — a crash loop would otherwise import on every
        # boot, at any hour, until the key was exhausted.
        time.sleep(seconds_until_hour(settings.FEED_IMPORT_HOUR_UTC, datetime.now(UTC)))
        _one_pass()


if __name__ == "__main__":
    raise SystemExit(main())
