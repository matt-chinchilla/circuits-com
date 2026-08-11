"""Cost sync — pulls real spend into `expenses` so the P&L stops guessing.

Runs as the `cost-sync` compose service (see docker-compose.yml). Structure
mirrors app/jobs/send_reminders.py: a pure ``run_sync_pass(db)`` that tests
drive directly, and a ``main()`` that owns the schedule and the session.

Three properties shape it:

**1. AWS runs once per day, at midnight — gated by the DATABASE, not a
timer.** Every GetCostAndUsage request costs $0.01, so an hourly loop that
called it every pass would spend $7/mo to measure a $37 bill. The gate asks
the table: has any source='aws' row been written TODAY (America/New_York — the
dashboard's own bucketing timezone)? The loop's ticks are aligned to the top
of the hour, so the first pass of a new ET day lands at 00:00, which is where
the daily report was asked to happen. Storing "last synced" in memory would
reset on every container restart — and `restart: unless-stopped` plus a crash
loop is exactly the case that would quietly bill for it.

Operators can force a fresh pull regardless of the gate:

    docker compose run --rm cost-sync python -m app.jobs.sync_costs --once --force-aws

``--once`` runs a single pass and exits; ``--force-aws`` spends the $0.01 even
when today's sync already happened.

**2. Stripe runs every pass because it is free.** Balance transactions cost
nothing to list, so there is no reason to serve stale fees.

**3. A source that is down is not an error.** ``CostSourceUnavailable`` is one
warning line and a continued pass — never a traceback, and never a partial
write: the existing rows (including the seeded estimate) stay exactly as they
are until real numbers can be fetched. An hourly job that logs tracebacks
trains everyone to ignore this container's logs, which is where a real
failure would appear.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import SessionLocal
from app.models.expense import Expense
from app.services.cost_sources import (
    AWS_SOURCE,
    CostSourceUnavailable,
    fetch_anthropic_cost_lines,
    fetch_aws_cost_lines,
    fetch_stripe_fee_lines,
    upsert_synced_costs,
)

logger = logging.getLogger(__name__)

# One pass an hour, ticks ALIGNED to the top of the hour (main() sleeps to the
# boundary, not for a fixed duration) — that alignment is what makes "daily at
# midnight" mean 00:0x rather than "sometime in the midnight hour, depending on
# when the container happened to start".
SYNC_INTERVAL_SECONDS = 3600

# The operational day for "once per day, at midnight" — the same timezone the
# dashboard buckets by. ET midnight is 04:00/05:00 UTC, both hour boundaries,
# so the aligned tick lands exactly on it.
SYNC_TIMEZONE = ZoneInfo("America/New_York")

# Routine window: this month and last. Last month can still move for a few days
# after it ends as usage records settle, so re-reading it is not waste.
AWS_MONTHS_ROUTINE = 2

# First sync ever: a year plus the current month. Months before the
# `Application` cost-allocation tag was activated report entirely untagged and
# land as 'AWS - Other' — that is the honest shape of the data, not a bug to
# paper over. Costs one $0.01 call, once.
AWS_MONTHS_BACKFILL = 13


def _as_utc(stamp: datetime | None) -> datetime | None:
    """Naive timestamps read back from SQLite are UTC by construction here."""
    if stamp is None:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=UTC)


def aws_last_synced(db: Session) -> datetime | None:
    """When the newest AWS row was last written, or None if there are none.

    Reads both columns and compares in Python rather than asking SQL for
    ``max(coalesce(updated_at, created_at))``: `expenses` holds tens of rows,
    and mixing an aware and a naive timestamp inside the database's own
    comparison is a dialect-dependent way to get a wrong answer to a question
    that decides whether money is spent.
    """
    rows = db.query(Expense.updated_at, Expense.created_at).filter(Expense.source == AWS_SOURCE)
    stamps = [_as_utc(updated or created) for updated, created in rows]
    real = [s for s in stamps if s is not None]
    return max(real) if real else None


def aws_months_to_fetch(
    db: Session, *, now: datetime | None = None, force: bool = False
) -> int | None:
    """How many months to ask Cost Explorer for, or None to skip this pass.

    The gate is calendar-day-based in SYNC_TIMEZONE: one sync per ET day,
    taken by the first pass of the day — which the aligned loop makes the
    midnight tick. ``force`` bypasses the gate (the operator's fresh-report
    lever), never the backfill sizing.
    """
    has_rows = db.query(Expense.id).filter(Expense.source == AWS_SOURCE).first() is not None
    if not has_rows:
        return AWS_MONTHS_BACKFILL
    if force:
        return AWS_MONTHS_ROUTINE

    last = aws_last_synced(db)
    if last is None:
        # Rows exist but carry no usable timestamp (hand-inserted, or written
        # before this column). Treat as stale: a routine window is cheap and
        # leaves the table in a state the gate can read next time.
        return AWS_MONTHS_ROUTINE

    moment = now or datetime.now(UTC)
    if last.astimezone(SYNC_TIMEZONE).date() >= moment.astimezone(SYNC_TIMEZONE).date():
        return None  # already synced today (ET)
    return AWS_MONTHS_ROUTINE


def _record(stats: dict[str, int], written: dict[str, int]) -> None:
    for key, value in written.items():
        stats[key] = stats.get(key, 0) + value


def _sync_stripe(db: Session, stats: dict[str, int]) -> None:
    if not settings.STRIPE_SECRET_KEY:
        logger.debug("[cost-sync] STRIPE_SECRET_KEY unset — no fee sync")
        return
    try:
        lines = fetch_stripe_fee_lines(settings.STRIPE_SECRET_KEY)
    except CostSourceUnavailable as exc:
        # One line, no traceback. See property 3 in the module docstring.
        logger.warning("[cost-sync] stripe: %s", exc)
        stats["unavailable"] += 1
        return
    # reconcile: a month whose fees net to zero after reversals must lose its
    # stale row, not keep it forever (the zero-ratchet).
    _record(stats, upsert_synced_costs(db, lines, reconcile_source="stripe"))
    stats["synced_stripe"] = 1


def _sync_aws(
    db: Session,
    stats: dict[str, int],
    *,
    now: datetime | None = None,
    force: bool = False,
    months_override: int | None = None,
) -> None:
    months = months_override or aws_months_to_fetch(db, now=now, force=force)
    if months is None:
        stats["aws_skipped_fresh"] = 1
        logger.debug("[cost-sync] AWS actuals are fresh — no Cost Explorer call")
        return
    try:
        lines = fetch_aws_cost_lines(months)
    except CostSourceUnavailable as exc:
        logger.warning("[cost-sync] aws: %s", exc)
        stats["unavailable"] += 1
        return
    _record(stats, upsert_synced_costs(db, lines, reconcile_source="aws"))
    stats["synced_aws"] = 1
    stats["aws_months"] = months


def _sync_anthropic(db: Session, stats: dict[str, int]) -> None:
    # A stub today (services/cost_sources/anthropic.py) — wired in anyway so
    # the seam has a caller. A job that nothing calls is how the calendar
    # reminders shipped inert.
    try:
        lines = fetch_anthropic_cost_lines(settings.ANTHROPIC_ADMIN_KEY)
    except CostSourceUnavailable as exc:
        logger.warning("[cost-sync] anthropic: %s", exc)
        stats["unavailable"] += 1
        return
    if lines:
        _record(stats, upsert_synced_costs(db, lines))
        stats["synced_anthropic"] = 1


def _is_missing_schema(exc: Exception) -> bool:
    """Does this error mean "migration 026 has not run here yet"?

    Postgres says `relation/column … does not exist`; SQLite says `no such
    table/column`. Both are the same situation: the api container's entrypoint
    runs `alembic upgrade head` and nothing orders this loop after it.
    """
    text = str(getattr(exc, "orig", exc)).lower()
    return "does not exist" in text or "no such table" in text or "no such column" in text


def run_sync_pass(
    db: Session,
    *,
    now: datetime | None = None,
    force_aws: bool = False,
    aws_months: int | None = None,
) -> dict[str, int]:
    """One pass over every source. Returns counters for the log line and tests."""
    stats: dict[str, int] = {"created": 0, "updated": 0, "superseded": 0, "unavailable": 0}
    try:
        _sync_stripe(db, stats)
        _sync_aws(db, stats, now=now, force=force_aws, months_override=aws_months)
        _sync_anthropic(db, stats)
    except (ProgrammingError, OperationalError) as exc:
        db.rollback()
        if _is_missing_schema(exc):
            # Waiting quietly is right: the next pass is an hour away, the
            # work is idempotent, and nothing is lost by missing one. Same
            # reasoning as app/jobs/send_reminders.py.
            logger.warning(
                "[cost-sync] expenses schema is not migrated yet (026) — skipping this pass"
            )
            stats["schema_missing"] = 1
            return stats
        raise
    return stats


def _one_pass(*, force_aws: bool = False, aws_months: int | None = None) -> None:
    db = SessionLocal()
    try:
        stats = run_sync_pass(db, force_aws=force_aws, aws_months=aws_months)
    except OperationalError:
        # The database is not accepting connections yet. This loop starts
        # alongside everything else and Postgres is routinely still coming up.
        db.rollback()
        logger.warning("[cost-sync] database unreachable — skipping this pass")
        return
    except Exception:
        # Never let one bad pass kill the loop: the container would restart,
        # and a restart with an empty expenses table spends another $0.01 on
        # the backfill window every time.
        db.rollback()
        logger.exception("[cost-sync] pass failed")
        return
    finally:
        db.close()
    logger.info(
        "[cost-sync] pass: created=%(created)d updated=%(updated)d "
        "superseded=%(superseded)d unavailable=%(unavailable)d",
        stats,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync real spend into the expenses table.")
    parser.add_argument(
        "--once", action="store_true", help="run a single pass and exit (operator one-shot)"
    )
    parser.add_argument(
        "--force-aws",
        action="store_true",
        help="spend the $0.01 Cost Explorer call even if today's sync already ran",
    )
    parser.add_argument(
        "--months",
        type=int,
        default=None,
        metavar="N",
        help="re-read N months of AWS history (implies the call happens) — the "
        "post-tag-backfill refresh lever, e.g. --once --months 13",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    if args.once:
        _one_pass(force_aws=args.force_aws, aws_months=args.months)
        return 0
    while True:
        _one_pass(force_aws=args.force_aws, aws_months=args.months)
        # Sleep to the next hour BOUNDARY, not for a fixed hour: the tick
        # phase is what puts the daily AWS sync at 00:00 ET instead of
        # "whenever the container started, plus N hours".
        time.sleep(SYNC_INTERVAL_SECONDS - (time.time() % SYNC_INTERVAL_SECONDS))


if __name__ == "__main__":
    raise SystemExit(main())
