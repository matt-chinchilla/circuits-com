"""The public site totals — the four figures the About page's stat strip shows.

They used to be four string literals inside the React page: `13.8` M parts,
`189` subcategories, and a `23` Years Online that was never true at all. That
is how a marketing number turns into a lie — nobody edits a constant when the
catalog grows, and no test can fail on a claim that has no data behind it. This
module is the one place those figures are derived from now.

Cheap by construction, because a marketing strip must never cost a table scan
per visitor:

  * ``parts``        parts a distributor actually lists (a semi-join, ~94ms).
  * ``distributors`` suppliers holding at least one listing, expressed as an
                     EXISTS probe PER SUPPLIER (59 index lookups on
                     ``ix_part_listings_supplier_id``, 0.2ms) rather than
                     ``count(DISTINCT supplier_id)``, which reads every one of
                     the ~418k listing rows (38ms) to answer a question about
                     59 of them.
  * ``categories`` / ``subcategories`` two counts over a 217-row table.

Then cached in process for ten minutes on the same clock seam the catalog
caches use, and dropped by ``invalidate_catalog_caches()`` so an import or an
admin edit reaches the page immediately instead of up to a TTL later.

ONE RULE, APPLIED TO BOTH SIDES OF ``part_listings``. A distributor is a
supplier with at least one listing (55 of 59 rows), and a "Distributor Part" is
a part with at least one listing (310,500 of 314,253 — MEASURED 2026-08-31:
3,753 parts are stocked by nobody). Counting either side's orphans would
overstate the figure in exactly the way the hardcoded numbers did, and applying
the rule to only one side would let the two tiles contradict each other.
"""

import time

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Category, Part, PartListing, Supplier

_CACHE_TTL_SECONDS = 600.0
_stats_cache: tuple[float, dict[str, int]] | None = None


def _now() -> float:
    """Clock seam — tests monkeypatch this to expire the cache."""
    return time.monotonic()


def _compute(db: Session) -> dict[str, int]:
    """The four counts, straight from the tables. No cache, no rounding —
    presentation (314253 -> "314.3K") belongs to the client."""
    # NOT a bare count over `parts`: the tile says "Distributor Parts", and a
    # part no supplier lists is not one. Same EXISTS rule as `distributors`
    # below, applied to the other side of the join.
    parts = (
        db.query(func.count(Part.id))
        .filter(select(PartListing.id).where(PartListing.part_id == Part.id).exists())
        .scalar()
        or 0
    )
    top_level = db.query(func.count(Category.id)).filter(Category.parent_id.is_(None)).scalar() or 0
    children = (
        db.query(func.count(Category.id)).filter(Category.parent_id.isnot(None)).scalar() or 0
    )
    # EXISTS per supplier, so the planner probes the listing index 59 times
    # instead of aggregating the whole listing table. `.correlate` is implicit
    # here: the subquery references the outer Supplier.id.
    distributors = (
        db.query(func.count(Supplier.id))
        .filter(select(PartListing.id).where(PartListing.supplier_id == Supplier.id).exists())
        .scalar()
        or 0
    )
    return {
        "parts": int(parts),
        "distributors": int(distributors),
        "categories": int(top_level),
        "subcategories": int(children),
    }


def get_site_stats(db: Session) -> dict[str, int]:
    """The public totals, cached in-process for 600s.

    An ALL-ZERO result is computed and returned but never STORED. The cache is
    per-process and only this process's mutations drop it, so a
    ``./deploy.sh --reseed`` — which truncates the catalog out from under a
    running api container — could otherwise pin "0 Distributor Parts" on the
    public About page for the rest of the TTL. Recomputing an empty catalog
    costs nothing (there is nothing to scan), so there is no reason to hold it.
    """
    global _stats_cache
    cached = _stats_cache
    if cached is None or _now() - cached[0] >= _CACHE_TTL_SECONDS:
        fresh = _compute(db)
        if not any(fresh.values()):
            return fresh
        cached = (_now(), fresh)
        _stats_cache = cached
    return cached[1]


def invalidate_site_stats_cache() -> None:
    """Drop the cache. Called from ``invalidate_catalog_caches()`` (every
    catalog mutation, plus the autouse test fixture) — not wired separately,
    so there stays exactly one seam for "the catalog changed"."""
    global _stats_cache
    _stats_cache = None
