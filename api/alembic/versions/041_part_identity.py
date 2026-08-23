"""Part identity: merge duplicate parts, then make duplicates impossible.

A part is **(canonical manufacturer, case-folded MPN)**. Until now nothing in
the database said so, and nothing enforced it — `routes/parts.py` even claimed
its own 409 was "the ONLY duplicate protection". The write paths were
SELECT-then-INSERT, which is silent under concurrency: measured with 8 writers
inserting one MPN against real Postgres, that pattern produced **8 rows and
reported zero errors**. `bom_match` then picks among the copies by
`lifecycle_verified_at DESC`, so the price a buyer is shown depends on which
duplicate happened to sort first.

`services/part_identity.py` (shipped ahead of this migration) makes every write
path an upsert. This migration cleans up what the old paths left behind and
installs the constraints that make the rule real. **They must ship together**:
the constraint without the upsert turned 7 of those 8 concurrent writers into
IntegrityErrors; the upsert without the constraint is advisory.

**Measured against production, 2026-08-23** (175,065 parts, 212,187 listings):

* 6 duplicate groups, 12 rows, all case-only (5 Nordic nRF, 1 SiTime) — every
  one a genuine duplicate. Case-folding is the whole normalisation: also
  stripping punctuation collides on 97 groups, mostly DISTINCT products,
  because the decimal point is load-bearing (`1.5SMC6.8AHM3` is a 6.8V TVS
  diode, `1.5SMC68AHM3` is a 68V one).
* Both rows in every group already share a slug (it derives from the
  lowercased sku), so **the merge kills no URL** and needs no redirects — worth
  stating because ~12,000 prerendered documents canonicalise to part slugs.
* The two rows in each group sit in DIFFERENT categories: that is what created
  them (the catalog JSON lists one chip under two category files with
  inconsistent capitalisation, and the seed's dedupe probe was case-sensitive).
  Merging therefore removes the part from one of the two category pages. That
  is inherent — `parts.category_id` is single-valued and they are one part.
* 124 listings move, 21 of them are supplier collisions that must be DROPPED
  rather than repointed, or they would violate the new listing constraint the
  same migration adds. 505 price breaks are involved.
* Two groups carry their only product photo on the NEWER row (2026-08 feed
  imports with 1 listing) while the older row holds 10-12 listings. So the
  survivor is the oldest row but every field it lacks is filled from the loser,
  or the merge would silently destroy two photos.

**`manufacturer_id` stays nullable here, deliberately.** 3,229 production rows
are unlinked, because until `part_identity` the importer never set the column.
`SET NOT NULL` belongs in a later migration for two reasons: alembic runs
BEFORE the seed in the container entrypoint, so the column is still full of
NULLs at this moment and the ALTER would fail the boot into a 502 loop; and
resolving those names correctly requires `manufacturer_canon.canon()`, which
migrations cannot import (no migration in this repo imports app code, and
transcribing canon() into SQL would create a third mirrored home of a rule this
codebase has already been bitten by twice). The seed's `seed_manufacturers`
steps 2-5 already drain every unlinked row using the real canon() on the very
next container start, so 042 can simply assert the column is clean.

Excluding NULLs from the merge is a CORRECTNESS requirement, not tidiness:
Postgres GROUP BY treats NULLs as equal, so an unguarded merge would fold every
unlinked row sharing an MPN into one product — two different companies' parts
becoming one page.

Revision ID: 041
Revises: 040
"""

from alembic import op

revision = "041"
down_revision = "040"
branch_labels = None
depends_on = None


# Exposed as a module constant so the Postgres-backed harness in
# tests/test_migration_041_merge.py can re-run the merge to prove it is
# idempotent, without transcribing a second copy of the SQL that could drift.
MERGE_DUPLICATE_PARTS = """
DROP TABLE IF EXISTS _m041_survivor;
DROP TABLE IF EXISTS _m041_doomed_listing;

-- Every row in a duplicate group, mapped to the row that will represent it.
-- Survivor = oldest by created_at (the incumbent wins, as it does for sponsor
-- slots), id as a deterministic tie-break. manufacturer_id IS NOT NULL is
-- load-bearing: see the module docstring.
CREATE TEMP TABLE _m041_survivor ON COMMIT DROP AS
WITH grp AS (
    SELECT manufacturer_id,
           upper(sku) AS mpn,
           (array_agg(id ORDER BY created_at, id))[1] AS survivor_id
    FROM parts
    WHERE manufacturer_id IS NOT NULL
    GROUP BY manufacturer_id, upper(sku)
    HAVING count(*) > 1
)
SELECT p.id AS part_id,
       g.survivor_id,
       (p.id <> g.survivor_id) AS is_loser
FROM parts p
JOIN grp g
  ON p.manufacturer_id = g.manufacturer_id
 AND upper(p.sku) = g.mpn;

CREATE INDEX ON _m041_survivor (part_id);
CREATE INDEX ON _m041_survivor (survivor_id);

-- 1. Carry across every fact the survivor is missing. Oldest-wins picks the
--    listing-rich row, which in two production groups is the one WITHOUT the
--    product photo, so a plain delete loses data. COALESCE never overwrites a
--    value the survivor already has; the FILTER form takes the first non-null
--    loser value in a deterministic order (groups can hold >1 loser).
UPDATE parts s
SET description           = COALESCE(s.description, f.description),
    slug                  = COALESCE(s.slug, f.slug),
    category_id           = COALESCE(s.category_id, f.category_id),
    sub_slug              = COALESCE(s.sub_slug, f.sub_slug),
    datasheet_url         = COALESCE(s.datasheet_url, f.datasheet_url),
    image_url             = COALESCE(s.image_url, f.image_url),
    package               = COALESCE(s.package, f.package),
    lifecycle_verified_at = COALESCE(s.lifecycle_verified_at, f.lifecycle_verified_at),
    mount                 = COALESCE(s.mount, f.mount),
    rohs                  = COALESCE(s.rohs, f.rohs),
    lead_time_days        = COALESCE(s.lead_time_days, f.lead_time_days),
    updated_at            = now()
FROM (
    SELECT m.survivor_id,
           (array_agg(l.description ORDER BY l.created_at, l.id)
              FILTER (WHERE l.description IS NOT NULL))[1] AS description,
           (array_agg(l.slug ORDER BY l.created_at, l.id)
              FILTER (WHERE l.slug IS NOT NULL))[1] AS slug,
           (array_agg(l.category_id ORDER BY l.created_at, l.id)
              FILTER (WHERE l.category_id IS NOT NULL))[1] AS category_id,
           (array_agg(l.sub_slug ORDER BY l.created_at, l.id)
              FILTER (WHERE l.sub_slug IS NOT NULL))[1] AS sub_slug,
           (array_agg(l.datasheet_url ORDER BY l.created_at, l.id)
              FILTER (WHERE l.datasheet_url IS NOT NULL))[1] AS datasheet_url,
           (array_agg(l.image_url ORDER BY l.created_at, l.id)
              FILTER (WHERE l.image_url IS NOT NULL))[1] AS image_url,
           (array_agg(l.package ORDER BY l.created_at, l.id)
              FILTER (WHERE l.package IS NOT NULL))[1] AS package,
           (array_agg(l.lifecycle_verified_at ORDER BY l.created_at, l.id)
              FILTER (WHERE l.lifecycle_verified_at IS NOT NULL))[1] AS lifecycle_verified_at,
           (array_agg(l.mount ORDER BY l.created_at, l.id)
              FILTER (WHERE l.mount IS NOT NULL))[1] AS mount,
           (array_agg(l.rohs ORDER BY l.created_at, l.id)
              FILTER (WHERE l.rohs IS NOT NULL))[1] AS rohs,
           (array_agg(l.lead_time_days ORDER BY l.created_at, l.id)
              FILTER (WHERE l.lead_time_days IS NOT NULL))[1] AS lead_time_days
    FROM _m041_survivor m
    JOIN parts l ON l.id = m.part_id
    WHERE m.is_loser
    GROUP BY m.survivor_id
) f
WHERE s.id = f.survivor_id;

-- 2. One offer per distributor per part. Repointing every loser listing would
--    create 21 collisions on production, which the constraint added below
--    would then reject mid-migration. The freshest last_updated wins: a price
--    comparison site keeps the current price, not the first one imported.
CREATE TEMP TABLE _m041_doomed_listing ON COMMIT DROP AS
SELECT id FROM (
    SELECT l.id,
           row_number() OVER (
               PARTITION BY m.survivor_id, l.supplier_id
               ORDER BY l.last_updated DESC, l.id
           ) AS rn
    FROM part_listings l
    JOIN _m041_survivor m ON m.part_id = l.part_id
) ranked
WHERE rn > 1;

DELETE FROM price_breaks
WHERE listing_id IN (SELECT id FROM _m041_doomed_listing);

DELETE FROM part_listings
WHERE id IN (SELECT id FROM _m041_doomed_listing);

-- 3. Move the surviving offers onto the survivor, then drop the losers.
UPDATE part_listings l
SET part_id = m.survivor_id
FROM _m041_survivor m
WHERE m.part_id = l.part_id
  AND m.is_loser;

DELETE FROM parts p
USING _m041_survivor m
WHERE m.part_id = p.id
  AND m.is_loser;
"""


def upgrade() -> None:
    op.execute(MERGE_DUPLICATE_PARTS)

    # PART IDENTITY. An expression index, so it is created with raw SQL —
    # op.create_index() cannot express upper(sku), and SQLAlchemy cannot
    # reflect expression indexes afterwards either (assert behaviourally).
    op.execute(
        "CREATE UNIQUE INDEX uq_parts_manufacturer_sku_upper "
        "ON parts (manufacturer_id, upper(sku))"
    )

    # One row per distributor per part. Production has zero violations after
    # step 2 above, so this only ever acts as a backstop — but it is the first
    # thing in the database that has ever said so.
    op.create_unique_constraint(
        "uq_part_listings_part_supplier", "part_listings", ["part_id", "supplier_id"]
    )


def downgrade() -> None:
    # The constraints come off; the merge does not come back. Deleted duplicate
    # rows and the stale side of 21 supplier collisions are gone, and inventing
    # replacements would be worse than the honest asymmetry.
    op.drop_constraint("uq_part_listings_part_supplier", "part_listings", type_="unique")
    op.execute("DROP INDEX IF EXISTS uq_parts_manufacturer_sku_upper")
