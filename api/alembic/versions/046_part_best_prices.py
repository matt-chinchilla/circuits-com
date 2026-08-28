"""Denormalize the four best prices onto `parts`, and backfill them.

Revision ID: 046
Revises: 045

WHY THE COLUMNS EXIST. A category page fetches its parts in one request and
sorts them; until now "best price" was three GROUP BY queries over
`part_listings` and `price_breaks` computed per page of results, which is only
affordable while the page is small. It stopped being small: 27 of 28 top-level
categories and 127 of 189 leaf subcategories now hold more than the 500-row
ceiling the page fetched, so the list silently truncated (Connectors showed 500
of 39,353) and the header count lied. Sorting and paginating in the DATABASE is
the fix, and a database cannot ORDER BY an aggregate it would have to compute
for every candidate row.

    best_price        MIN(part_listings.unit_price) over the part's offers
    best_price_10     MIN(price_breaks.unit_price) over those offers' ladders
    best_price_100      at the rung where min_quantity = 10 / 100 / 1000
    best_price_1000

NULL is a real value here — a part with no listing, or a ladder that never
quotes 1000 — and the sort sinks NULLs in both directions rather than treating
absence as free.

*** NO INDEXES, DELIBERATELY. ***

This is the same discipline the price-break reconciler follows, and it is the
decision most likely to be "fixed" by someone later. `parts` already carries
eight indexes. An UPDATE that touches only UNINDEXED columns is eligible for a
HOT update: Postgres writes the new row version in the same page and skips
every index entry. Add an index on `best_price` and every reprice the nightly
feed sweep performs — up to 130,728 parts for Mouser alone — stops being HOT
and rewrites that index too, forever, which is precisely the churn the
price-break work removed (846,167 live rows against 4.84M row-ops).

Nothing is bought by paying it. These columns are sorted AFTER the query has
already been narrowed to one category: at most ~40k rows, sorted in memory in
milliseconds. An index would serve a global ORDER BY price nobody asks for.

THE BACKFILL is set-based and exposed as module constants so a test can run the
real statements rather than a second transcription of them. Two statements,
one per column family, each a full recompute: the subquery aggregates from
`parts` outward through a LEFT JOIN, so a part with no listings is computed as
NULL rather than skipped. That is what makes re-running safe in the strong
sense — the second run converges to the same state instead of leaving a stale
value behind — and the `IS DISTINCT FROM` guard means the second run writes
ZERO rows.
"""

import sqlalchemy as sa
from alembic import op

revision = "046"
down_revision = "045"
branch_labels = None
depends_on = None


BACKFILL_BEST_PRICE = """
UPDATE parts AS p
   SET best_price = agg.best_price
  FROM (
        SELECT src.id AS part_id,
               MIN(l.unit_price) AS best_price
          FROM parts AS src
          LEFT JOIN part_listings AS l ON l.part_id = src.id
         GROUP BY src.id
       ) AS agg
 WHERE p.id = agg.part_id
   AND p.best_price IS DISTINCT FROM agg.best_price
"""

BACKFILL_BEST_PRICE_TIERS = """
UPDATE parts AS p
   SET best_price_10 = agg.q10,
       best_price_100 = agg.q100,
       best_price_1000 = agg.q1000
  FROM (
        SELECT src.id AS part_id,
               MIN(CASE WHEN b.min_quantity = 10   THEN b.unit_price END) AS q10,
               MIN(CASE WHEN b.min_quantity = 100  THEN b.unit_price END) AS q100,
               MIN(CASE WHEN b.min_quantity = 1000 THEN b.unit_price END) AS q1000
          FROM parts AS src
          LEFT JOIN part_listings AS l ON l.part_id = src.id
          LEFT JOIN price_breaks AS b ON b.listing_id = l.id
         GROUP BY src.id
       ) AS agg
 WHERE p.id = agg.part_id
   AND (p.best_price_10   IS DISTINCT FROM agg.q10
     OR p.best_price_100  IS DISTINCT FROM agg.q100
     OR p.best_price_1000 IS DISTINCT FROM agg.q1000)
"""

BACKFILL_STATEMENTS = (BACKFILL_BEST_PRICE, BACKFILL_BEST_PRICE_TIERS)

NEW_COLUMNS = ("best_price", "best_price_10", "best_price_100", "best_price_1000")


def upgrade() -> None:
    for name in NEW_COLUMNS:
        # Numeric(10, 4) — the SAME type as part_listings.unit_price and
        # price_breaks.unit_price. A narrower scale would make every refresh
        # see a difference it cannot store and rewrite the row on every pass.
        op.add_column("parts", sa.Column(name, sa.Numeric(10, 4), nullable=True))

    for statement in BACKFILL_STATEMENTS:
        op.execute(sa.text(statement))


def downgrade() -> None:
    for name in reversed(NEW_COLUMNS):
        op.drop_column("parts", name)
