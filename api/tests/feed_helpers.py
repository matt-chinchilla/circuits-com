"""Shared builders for suites that exercise the part-feed seam.

One FakeProvider / feed_part serves both test_part_feed and
test_supplier_sync_route — a field added to FeedPart gets updated HERE, once,
instead of leaving one suite green and the other stale (review-caught: the two
files had drifted into near-identical private copies).
"""

import math

from sqlalchemy import event

from app.services.part_feed.base import FeedPart, FeedPriceBreak


class StatementCounter:
    """Counts SQL issued on a session's bind while the block is open.

    Lives here rather than in one test module because both the SQLite
    write-budget suite and the Postgres write-behaviour suite need it, and the
    Postgres one specifically CANNOT use `db.dirty`/`db.deleted` to see the
    reconciler's work: it emits UPDATE and DELETE through Core `db.execute`,
    which never touches the unit of work, so those collections are empty
    whatever the code does.
    """

    def __init__(self, session):
        self.bind = session.get_bind()
        self.statements: list[str] = []

    def __enter__(self):
        event.listen(self.bind, "before_cursor_execute", self._record)
        return self

    def __exit__(self, *exc):
        event.remove(self.bind, "before_cursor_execute", self._record)

    def _record(self, conn, cursor, statement, params, context, executemany):
        self.statements.append(statement)

    def matching(self, fragment: str) -> list[str]:
        return [s for s in self.statements if fragment in s.lower()]

    def writes_to(self, table: str) -> list[str]:
        """Every INSERT/UPDATE/DELETE aimed at `table`.

        One home on purpose: two tests asserting "this wrote nothing" with
        their own copies of the predicate is how one of them quietly stops
        asserting when the definition of a write changes.
        """
        return [
            s
            for s in self.statements
            if table in s.lower() and s.strip().split()[0].lower() in ("insert", "update", "delete")
        ]


class FakeProvider:
    """A provider that answers from a dict — no network, no key, no sleep.

    Mirrors the real provider's call accounting: `calls_made` counts every
    search/lookup, which is what an import run's budget actually spends.
    """

    supplier_name = "Mouser Electronics"
    supplier_website = "mouser.com"
    records_per_call = 50

    def __init__(self, by_mpn=None, search_results=None, results_by_keyword=None, api_key=None):
        self.by_mpn = by_mpn or {}
        self.search_results = search_results or []
        # keyword -> results, for sweeps that must answer per category
        self.results_by_keyword = results_by_keyword or {}
        self.calls_made = 0
        # (keyword, limit, start_at) — the depth is part of the record, so a
        # cursor test can prove the second run asked a DIFFERENT page.
        self.search_calls: list[tuple[str, int, int]] = []
        self.last_raw_count = 0

    @classmethod
    def from_credential(cls, key):
        """Mirrors the Protocol, and PASSES THE KEY ON.

        The fake needs no credential itself, but subclasses record what they
        were handed — that is how `test_each_provider_is_called_with_ITS_OWN_key`
        proves a second distributor is never reachable on Mouser's key.
        Swallowing it here would make that test pass while asserting nothing.
        """
        return cls(api_key=key)

    def search(self, keyword, limit=50, start_at=0):
        # PAGE-aware, like MouserProvider: a search for more than one page
        # costs more than one call, so budget tests exercise the real ratio
        # instead of a flattering 1-per-category.
        self.calls_made += max(1, math.ceil(limit / self.records_per_call))
        self.search_calls.append((keyword, limit, start_at))
        results = self.results_by_keyword.get(keyword, self.search_results)
        page = results[start_at : start_at + limit]
        # Every fake row parses, so raw == returned here. The attribute exists
        # anyway because the import cursor advances by RAW rows: a provider
        # that dropped undecodable rows must not re-fetch them forever.
        self.last_raw_count = len(page)
        return page

    def lookup_mpn(self, mpn):
        self.calls_made += 1
        return self.by_mpn.get(mpn)


def feed_part(
    mpn: str = "FEED-001",
    manufacturer: str = "Feed Mfr",
    image: str | None = "https://img.example/p.jpg",
    breaks: bool = True,
    ladder: list[tuple[int, float]] | None = None,
) -> FeedPart:
    """`ladder` sets the price breaks explicitly as (min_quantity, price) pairs
    — the write-budget suite needs to move ONE rung and watch what the importer
    does with the others. Contradicting `breaks=False` raises rather than
    silently winning: a caller writing both means one of the two, and guessing
    hands them a priced FeedPart that takes the opposite branch of
    `_upsert_listing` from the one their test is about."""
    if ladder is not None and not breaks:
        raise ValueError("feed_part: pass a ladder or breaks=False, not both")
    return FeedPart(
        mpn=mpn,
        manufacturer=manufacturer,
        description="10uF 25V ceramic capacitor 0805",
        image_url=image,
        datasheet_url="https://docs.example/d.pdf",
        supplier_sku=f"621-{mpn}",
        stock_quantity=500,
        lead_time_days=7,
        price_breaks=_ladder_breaks(ladder, breaks),
    )


def _ladder_breaks(ladder, breaks) -> list[FeedPriceBreak]:
    """Explicit ladder, the default two-rung ladder, or none — in that order."""
    if ladder is not None:
        return [FeedPriceBreak(q, price) for q, price in ladder]
    if breaks:
        return [FeedPriceBreak(1, 0.10), FeedPriceBreak(100, 0.08)]
    return []
