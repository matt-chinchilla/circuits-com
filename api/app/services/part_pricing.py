"""The four denormalized best-price columns on `parts`, and their upkeep.

`parts.best_price`, `best_price_10`, `best_price_100` and `best_price_1000`
(migration 046) hold what three GROUP BY queries over `part_listings` and
`price_breaks` used to compute per request:

    best_price        MIN(part_listings.unit_price) over the part's offers
    best_price_<N>    MIN(price_breaks.unit_price) over those offers' ladders,
                      restricted to the rung where min_quantity = N

They are stored so a category page can ORDER BY price in the database instead
of fetching 500 rows and sorting them in the browser — the truncation that made
Connectors show 500 parts of 39,353.

THIS MODULE IS THE SINGLE HOME FOR KEEPING THEM TRUE. Every path that can move
a part's prices calls `refresh_best_prices` with the affected ids: the feed
importer, the admin part/listing routes, the supplier-delete cascade, the seed
and the catalog loader. A denormalization with several private update rules is
a denormalization that drifts.

WRITE-WASTE DISCIPLINE, inherited from the price-break reconciler
(`part_feed/importer._sync_price_breaks`). `pg_stat_user_tables` on
`price_breaks` read 846,167 live rows against 2,760,938 inserts and 2,080,759
deletes with `n_tup_upd = 0` — the fingerprint of a write path that replaced
instead of reconciling. The same mistake here would be worse: `parts` is a
wider row carrying eight indexes, and the nightly Mouser sweep touches upwards
of 130,000 of them. So `refresh_best_prices` reads the four stored values,
compares them against the recomputed ones, and writes ONLY the rows that
actually moved. A confirming pass writes nothing at all.

The comparison goes through `storable_price` on BOTH sides. That is the part
that is easy to leave out and impossible to notice afterwards: real DigiKey
payloads quote five decimals (0.03909) into a `Numeric(10, 4)` that stores
0.0391, so comparing feed precision against a stored value differs on every
pass and the row is rewritten forever while looking perfectly correct.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models import Part, PartListing, PriceBreak

# The quantity rungs the public parts table shows beside the unit price. Kept
# as data rather than three hand-written queries so the backfill in migration
# 046, the refresh below and the tests all name the same set.
BEST_PRICE_TIERS: tuple[int, ...] = (10, 100, 1000)

TIER_COLUMNS: dict[int, str] = {
    10: "best_price_10",
    100: "best_price_100",
    1000: "best_price_1000",
}

BEST_PRICE_COLUMNS: tuple[str, ...] = ("best_price", *TIER_COLUMNS.values())

# ── Rounding: ONE home, shared with the feed importer ───────────────────────
# This used to live in `part_feed/importer.py` and is imported from here by it,
# rather than copied, for the reason the module docstring gives: two
# implementations of "what the database will actually hold" is how a phantom
# diff comes back on one of the two paths only, and neither path's tests would
# see it.
#
# The scale is read from the schema rather than hardcoded, but note the ONE
# constant is applied to `price_breaks.unit_price`, `part_listings.unit_price`
# AND the four `parts.best_price*` columns. All six are `Numeric(10, 4)` and a
# test asserts they stay that way (`TestEveryPriceColumnSharesOneScale`), which
# is the right place for it: a divergence should fail the suite, not refuse to
# boot the container. A column declared as bare `Numeric` has scale None and
# falls back rather than raising a TypeError at import time.
_declared_scale = PriceBreak.__table__.c.unit_price.type.scale
_PRICE_QUANTUM = Decimal(1).scaleb(-(4 if _declared_scale is None else _declared_scale))


def storable_price(value) -> Decimal:
    """The price as the database will actually hold it."""
    return Decimal(str(value)).quantize(_PRICE_QUANTUM, rounding=ROUND_HALF_UP)


def _storable_or_none(value) -> Decimal | None:
    """`storable_price`, but NULL survives as NULL.

    A missing price is not zero and must not be rounded into one: a part with
    no listing, and a ladder that never quotes 1000, are both ordinary. The
    category sort sinks NULLs to the bottom in both directions precisely
    because they mean "no price", not "free".
    """
    return None if value is None else storable_price(value)


def _as_uuid(value) -> uuid.UUID | None:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def refresh_best_prices(
    db: Session,
    part_ids: Iterable,
    *,
    chunk_size: int = 500,
) -> int:
    """Recompute the four columns for `part_ids`; write only what moved.

    Returns the number of part ROWS written — zero when every value the feed
    or the admin just confirmed was already what the database held. Callers
    that report counts to an operator can use it directly; callers that do not
    can ignore it, but the number is what the tests assert on, because "wrote
    nothing" is the guarantee that is invisible in an outcome-only assertion.

    Batched: the supplier-delete cascade legitimately hands this every part a
    distributor carried (130,728 for Mouser on production), and a single
    `IN (...)` of that width is a query no planner should be asked to hold.

    The caller owns the transaction. Nothing here commits, so the feed
    importer's per-part commit ordering is unchanged — the price columns land
    in the SAME commit as the listing that moved them, and a run that dies
    mid-sweep leaves no part quoting a price its listings do not support.
    """
    ids: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for raw in part_ids:
        pid = _as_uuid(raw)
        if pid is None or pid in seen:
            continue
        seen.add(pid)
        ids.append(pid)
    if not ids:
        return 0

    # Sessions run autoflush=False, so a listing or price break the caller has
    # only STAGED is invisible to the SELECTs below — the feed importer adds
    # new rungs with `db.add` and does not flush them, so without this the
    # refresh would read the ladder as it was BEFORE the pass that triggered
    # it and cheerfully store a stale minimum.
    db.flush()

    moved = 0
    for start in range(0, len(ids), chunk_size):
        moved += _refresh_chunk(db, ids[start : start + chunk_size])
    return moved


def _refresh_chunk(db: Session, ids: list[uuid.UUID]) -> int:
    wanted: dict[uuid.UUID, dict[str, Decimal | None]] = {
        # Absence IS the answer for a part with no priced source: it starts at
        # all-NULL and only the aggregates below lift it off that, so a part
        # whose last listing was just deleted is CLEARED rather than left
        # quoting a price nothing backs.
        pid: dict.fromkeys(BEST_PRICE_COLUMNS)
        for pid in ids
    }

    for part_id, low in db.execute(
        select(PartListing.part_id, func.min(PartListing.unit_price))
        .where(PartListing.part_id.in_(ids))
        .group_by(PartListing.part_id)
    ):
        row = wanted.get(_as_uuid(part_id))
        if row is not None:
            row["best_price"] = _storable_or_none(low)

    # ONE query for all three rungs, grouped by (part, quantity). Three
    # separate queries is what the per-request version did, and this runs on
    # the write path where the feed importer calls it per part.
    #
    # `part_id` leads the select list deliberately: tests/test_feed_query_budget
    # counts statements whose text begins "select price_breaks" to prove the
    # importer reads a listing's ladder exactly once, and this read must not be
    # mistaken for that one.
    for part_id, qty, low in db.execute(
        select(
            PartListing.part_id,
            PriceBreak.min_quantity,
            func.min(PriceBreak.unit_price),
        )
        .join(PriceBreak, PriceBreak.listing_id == PartListing.id)
        .where(
            PartListing.part_id.in_(ids),
            PriceBreak.min_quantity.in_(BEST_PRICE_TIERS),
        )
        .group_by(PartListing.part_id, PriceBreak.min_quantity)
    ):
        row = wanted.get(_as_uuid(part_id))
        if row is not None:
            row[TIER_COLUMNS[qty]] = _storable_or_none(low)

    stored = db.execute(
        select(
            Part.id,
            Part.best_price,
            Part.best_price_10,
            Part.best_price_100,
            Part.best_price_1000,
        ).where(Part.id.in_(ids))
    ).all()

    changed: list[dict] = []
    for row in stored:
        pid = _as_uuid(row[0])
        want = wanted.get(pid)
        if want is None:
            continue
        # Both sides rounded to the column's own scale.
        #
        # HONEST NOTE: today this is a guard, not a load-bearing step. Both
        # sides arrive through SQLAlchemy's `Numeric` result processor, which
        # already quantizes to the declared scale on BOTH engines (measured:
        # SQLite physically stores 0.039091234 as a float and still hands back
        # Decimal('0.0391')), so removing it changes nothing and no test can
        # currently prove otherwise. It stays because the obvious next
        # optimization is to stop asking the database and compare against the
        # price the feed already has in hand — raw payload precision, five
        # decimals against a four-decimal column — and that is the version of
        # this function that rewrites every row on every pass forever. Keeping
        # the rounding on the comparison means that change is safe when someone
        # makes it. `TestARefreshThatChangesNothingWritesNothing` is where it
        # would be caught.
        current = {
            column: _storable_or_none(row[offset])
            for offset, column in enumerate(BEST_PRICE_COLUMNS, start=1)
        }
        if current != want:
            changed.append({"id": pid, **want})

    if changed:
        # ORM bulk UPDATE by primary key: no explicit WHERE, so SQLAlchemy
        # derives the criteria from `id` and still synchronizes the session.
        # Spelling it as `update(...).where(id == bindparam(...))` instead
        # raises InvalidRequestError on the executemany path (the same trap
        # `_sync_price_breaks` documents).
        #
        # Every changed row is written whole — all four columns — because one
        # row version costs the same whichever subset moved, and none of the
        # four is indexed, so the UPDATE stays HOT-eligible either way.
        db.execute(update(Part), changed)
    return len(changed)
