"""The shape every cost source returns, and the one function that writes it.

A source's whole job is to produce ``SyncedCost`` values; nothing in
``aws.py`` / ``stripe_fees.py`` / ``anthropic.py`` touches the database. That
split is what lets each source be tested against a canned API response with no
session at all, and it means the write rules below live in exactly one place
rather than being re-derived per provider.

Three rules, and each is a way this could silently corrupt the P&L:

**1. A sync never modifies a row a person wrote.** Every match is scoped to
``source == line.source``, and 'manual' is not a value any source emits (the
admin CRUD cannot set the column, so a hand-typed row is always 'manual').
Without that scope a re-sync would happily overwrite the amount someone
transcribed from a real invoice.

**2. The natural key is (source, vendor, period_start).** Not the id — the
sources are stateless and re-derive their lines from scratch every pass, so a
month already written must be UPDATED rather than appended. Matching on vendor
too, because one source emits several vendors per month (AWS is split by
Application tag) and they are different rows, not revisions of one.

**3. An actual SUPERSEDES the estimate for its month.** ``db/seed.py`` plants a
list-price AWS figure as source='estimate'; leaving it in place once Cost
Explorer reports the real number would show the same bill twice and inflate
infrastructure spend by roughly 2x. The estimate is deleted for that month
only — earlier months with no actual yet keep theirs, which is the point of
having a fallback.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.orm import Session

from app.models.expense import ESTIMATE_SOURCE, MANUAL_SOURCE, Expense

CENTS = Decimal("0.01")

# `Expense.source` values written by this package. Single home so the job, the
# sources and the supersede rule cannot disagree about a string.
AWS_SOURCE = "aws"
STRIPE_SOURCE = "stripe"
ANTHROPIC_SOURCE = "anthropic"


class CostSourceUnavailable(Exception):
    """A provider could not be reached or refused us.

    Raised by the sources, never by the writer. It is deliberately NOT an
    error the job dies on: a missing credential, an expired role or a
    provider outage means "no fresh numbers this hour", and the existing rows
    (including the estimate) stay exactly as they are. The job logs one line
    and moves on — see app/jobs/sync_costs.py.
    """


@dataclass(frozen=True)
class SyncedCost:
    """One provider-reported cost for one calendar month.

    Frozen because these are values, not records: a source builds them, the
    writer reads them, and nothing in between should be able to edit one.
    """

    source: str
    category: str
    vendor: str
    amount: Decimal
    period_start: date
    period_end: date


def to_cents(amount: Decimal | float | str) -> Decimal:
    """Quantize to money. Providers report full float precision (Cost Explorer
    returns strings like '12.3456789'); the column is Numeric(10, 2), so round
    HERE where it is visible rather than letting the database truncate."""
    return Decimal(str(amount)).quantize(CENTS, rounding=ROUND_HALF_UP)


def upsert_synced_costs(
    db: Session, lines: list[SyncedCost], *, reconcile_source: str | None = None
) -> dict[str, int]:
    """Write provider lines into `expenses`.

    Returns {created, updated, superseded, reconciled}.

    ``reconcile_source`` closes the zero-ratchet: without it a row, once
    written, could go UP on every re-read but never come back DOWN to zero —
    a month fully wiped by a credit or fee reversal re-reads as "no line",
    and "no line" used to mean "leave the stale number standing forever".
    When set, same-source rows inside the fetched window (bounded below by
    the oldest month this snapshot covers) that the snapshot no longer
    reports are DELETED. Only that source's own rows: manual and estimate
    rows are never reconciliation candidates. Skipped entirely when the
    snapshot is empty — an empty response is indistinguishable from a broken
    one, and deleting a whole window on it would be the costlier mistake.

    Commits once at the end: a pass that fails halfway should leave the table
    as it was rather than half-updated, and every line comes from a single
    provider snapshot.
    """
    stats = {"created": 0, "updated": 0, "superseded": 0, "reconciled": 0}
    if not lines:
        return stats

    now = datetime.now(UTC)
    supersede_keys: set[tuple[str, date]] = set()

    for line in lines:
        if line.source == MANUAL_SOURCE:
            # A programming error, not a data condition: 'manual' means "a
            # human owns this row", so a source claiming it would make the
            # ownership rule unenforceable. Loud beats a silent overwrite.
            raise ValueError(
                "a cost source may not write source='manual' — that label is "
                "reserved for rows a person entered by hand"
            )

        existing = (
            db.query(Expense)
            .filter(
                Expense.source == line.source,
                Expense.source != MANUAL_SOURCE,
                Expense.vendor == line.vendor,
                Expense.period_start == line.period_start,
            )
            .first()
        )

        if existing is not None:
            existing.amount = line.amount
            existing.period_end = line.period_end
            # The source's category mapping is authoritative (2026-08-11: the
            # mail server's AWS spend moved from 'infrastructure' to 'email').
            # Without this line a remapped vendor keeps its old category on
            # every row that already exists, forever.
            existing.category = line.category
            # Stamped EXPLICITLY, not left to the column's `onupdate`: a
            # re-sync that writes the identical amount is not a change, so
            # SQLAlchemy emits no UPDATE and `onupdate` never fires. The job's
            # staleness gate reads this timestamp to decide whether to spend
            # another $0.01 Cost Explorer call — an un-advanced clock there
            # means calling every hour instead of once a day.
            existing.updated_at = now
            stats["updated"] += 1
        else:
            db.add(
                Expense(
                    category=line.category,
                    vendor=line.vendor,
                    amount=line.amount,
                    description=f"Synced from {line.source} on {now:%Y-%m-%d}.",
                    period_start=line.period_start,
                    period_end=line.period_end,
                    source=line.source,
                    created_at=now,
                    updated_at=now,
                )
            )
            stats["created"] += 1

        if line.source != ESTIMATE_SOURCE:
            # Any REAL source supersedes the seeded estimates in its own
            # category+month — AWS actuals replace the infrastructure
            # estimate, synced Stripe fees replace the payment placeholder.
            # Estimate lines (the mail carve-out) supersede nothing: an
            # allocation is not a better measurement of another estimate.
            #
            # Collected rather than deleted inline because AWS emits SEVERAL
            # vendors for one month (one per Application tag) — deleting per
            # line would re-run the same query two or three times and, with
            # autoflush off, count the same estimate as superseded twice.
            supersede_keys.add((line.category, line.period_start))

    stats["superseded"] = _drop_superseded_estimates(db, supersede_keys)

    if reconcile_source is not None:
        stats["reconciled"] = _reconcile_missing_rows(db, reconcile_source, lines)

    db.commit()
    return stats


def _reconcile_missing_rows(db: Session, source: str, lines: list[SyncedCost]) -> int:
    """Delete `source`'s rows the current snapshot stopped reporting.

    Window = everything from the oldest month this snapshot covers. A month
    outside the window was not re-read, so its absence says nothing.
    """
    window_start = min(line.period_start for line in lines)
    reported = {(line.vendor, line.period_start) for line in lines}
    stale = (
        db.query(Expense)
        .filter(Expense.source == source, Expense.period_start >= window_start)
        .all()
    )
    dropped = 0
    for row in stale:
        if (row.vendor, row.period_start) not in reported:
            db.delete(row)
            dropped += 1
    return dropped


def _drop_superseded_estimates(db: Session, keys: set[tuple[str, date]]) -> int:
    """Delete the seeded estimates that this pass's actuals replace."""
    dropped = 0
    for category, period_start in keys:
        rows = (
            db.query(Expense)
            .filter(
                Expense.source == ESTIMATE_SOURCE,
                Expense.category == category,
                Expense.period_start == period_start,
            )
            .all()
        )
        for row in rows:
            db.delete(row)
        dropped += len(rows)
    return dropped
