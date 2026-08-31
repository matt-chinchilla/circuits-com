"""The public totals behind the About page's stat strip.

The strip used to be four literals in the React page — 13.8M parts, 23 Years
Online — which nothing could contradict and nothing kept honest. These tests
exist to make the figures falsifiable: they pin what each one counts, that a
supplier with no listings is not a distributor, and that a catalog mutation
reaches the page instead of hiding behind the TTL.
"""

import pathlib
import re
import uuid
from decimal import Decimal

from app.models import Category, Part, PartListing, Supplier
from app.services import site_stats
from app.services.search_service import invalidate_catalog_caches

# The About page reads the payload by key. A rename here renders four em-dashes
# there with no error anywhere, so the contract is pinned rather than implied.
EXPECTED_KEYS = {"parts", "distributors", "categories", "subcategories"}


def _get(client):
    r = client.get("/api/stats/")
    assert r.status_code == 200
    return r.json()


def _add_stocked_part(db, seeded_db, sku: str = "NE555P"):
    """A part WITH a listing — the only kind the `parts` figure counts."""
    part = Part(
        id=uuid.uuid4(),
        sku=sku,
        description="Precision timer",
        manufacturer_name="Texas Instruments",
        category_id=seeded_db["child"].id,
    )
    db.add(part)
    db.flush()
    db.add(
        PartListing(
            id=uuid.uuid4(),
            part_id=part.id,
            supplier_id=seeded_db["supplier1"].id,
            sku=f"AVN-{sku}",
            stock_quantity=100,
            unit_price=Decimal("0.3300"),
        )
    )
    db.commit()
    return part


class TestTheTotalsComeFromTheTables:
    def test_the_payload_is_exactly_the_four_figures_the_strip_shows(self, client, seeded_db):
        assert set(_get(client)) == EXPECTED_KEYS

    def test_each_figure_matches_the_seeded_catalog(self, client, seeded_db):
        # seeded_db holds 2 parts, but BOTH its listings are on part1 — so
        # part2 is stocked by nobody and is not a "Distributor Part". 2
        # suppliers, both listing. 1 top-level category, 1 child.
        assert _get(client) == {
            "parts": 1,
            "distributors": 2,
            "categories": 1,
            "subcategories": 1,
        }

    def test_categories_and_subcategories_split_on_parent_id(self, client, db, seeded_db):
        # A second child must land in `subcategories`, never in `categories` —
        # the two tiles are separate claims and one must not absorb the other.
        db.add(
            Category(
                id=uuid.uuid4(),
                name="Voltage References",
                slug="voltage-references",
                icon="gauge",
                parent_id=seeded_db["parent"].id,
                sort_order=1,
            )
        )
        db.commit()
        invalidate_catalog_caches()
        body = _get(client)
        assert body["categories"] == 1
        assert body["subcategories"] == 2


class TestOneRuleForBothSidesOfTheJoin:
    """A distributor is a supplier with a listing; a "Distributor Part" is a
    part with a listing. Applying the rule to only one side would let the two
    tiles contradict each other — 3,753 of production's 314,253 parts are
    stocked by nobody."""

    def test_a_part_no_supplier_lists_is_not_a_distributor_part(self, client, db, seeded_db):
        db.add(
            Part(
                id=uuid.uuid4(),
                sku="ORPHAN-1",
                description="Listed by nobody",
                manufacturer_name="Nobody",
                category_id=seeded_db["child"].id,
            )
        )
        db.commit()
        invalidate_catalog_caches()

        assert db.query(Part).count() == 3
        assert _get(client)["parts"] == 1

    def test_a_part_gains_the_count_the_moment_it_is_stocked(self, client, db, seeded_db):
        assert _get(client)["parts"] == 1
        _add_stocked_part(db, seeded_db, sku="STOCKED-1")
        invalidate_catalog_caches()
        assert _get(client)["parts"] == 2

    def test_a_part_on_many_listings_still_counts_once(self, client, db, seeded_db):
        # part1 already carries TWO listings in the fixture, which is why the
        # baseline is 1 rather than 2.
        assert db.query(PartListing).filter_by(part_id=seeded_db["part1"].id).count() == 2
        assert _get(client)["parts"] == 1


class TestWhatCountsAsADistributor:
    def test_a_supplier_with_no_listings_is_not_counted(self, client, db, seeded_db):
        """The tile sits under "Distributor Parts" and promises distributors
        whose stock is on the site. A directory row carrying no listing
        contributes no parts, so counting it would overstate the figure in
        exactly the way the hardcoded number did."""
        db.add(Supplier(id=uuid.uuid4(), name="Paper Only Ltd", website="paper-only.example"))
        db.commit()
        invalidate_catalog_caches()

        assert db.query(Supplier).count() == 3
        assert _get(client)["distributors"] == 2

    def test_one_listing_is_enough_to_be_counted(self, client, db, seeded_db):
        supplier = Supplier(id=uuid.uuid4(), name="Newark", website="newark.com")
        db.add(supplier)
        db.flush()
        db.add(
            PartListing(
                id=uuid.uuid4(),
                part_id=seeded_db["part1"].id,
                supplier_id=supplier.id,
                sku="NWK-LM7805CT",
                stock_quantity=12,
                unit_price=Decimal("0.6100"),
            )
        )
        db.commit()
        invalidate_catalog_caches()

        assert _get(client)["distributors"] == 3

    def test_a_distributor_holding_many_listings_still_counts_once(self, client, db, seeded_db):
        # count(DISTINCT ...) semantics, expressed as EXISTS — a busy supplier
        # must not inflate the tile.
        db.add(
            PartListing(
                id=uuid.uuid4(),
                part_id=seeded_db["part2"].id,
                supplier_id=seeded_db["supplier1"].id,
                sku="AVN-STM32F407VGT6",
                stock_quantity=40,
                unit_price=Decimal("9.1000"),
            )
        )
        db.commit()
        invalidate_catalog_caches()

        assert _get(client)["distributors"] == 2


class TestFreshness:
    def test_a_second_read_is_served_from_the_cache(self, client, db, seeded_db):
        assert _get(client)["parts"] == 1
        _add_stocked_part(db, seeded_db)
        # Deliberately stale: the strip is not a live counter, and paying a
        # semi-join over the parts table per visitor is what the cache prevents.
        assert _get(client)["parts"] == 1

    def test_the_catalog_seam_drops_it(self, client, db, seeded_db):
        """Every catalog mutation already calls invalidate_catalog_caches();
        the totals hang off that one seam rather than a second one every future
        write site would have to remember."""
        assert _get(client)["parts"] == 1
        _add_stocked_part(db, seeded_db)
        invalidate_catalog_caches()

        assert _get(client)["parts"] == 2

    def test_the_ttl_expires_on_its_own(self, client, db, seeded_db, monkeypatch):
        clock = [1_000.0]
        monkeypatch.setattr(site_stats, "_now", lambda: clock[0])

        assert _get(client)["parts"] == 1
        _add_stocked_part(db, seeded_db)

        clock[0] += site_stats._CACHE_TTL_SECONDS - 1
        assert _get(client)["parts"] == 1, "must not expire early"
        clock[0] += 2
        assert _get(client)["parts"] == 2


class TestTheRouteIsPublic:
    def test_no_auth_is_required(self, client, seeded_db):
        # The About page is unauthenticated; a 401 here would render the strip
        # as four em-dashes for every visitor.
        assert client.get("/api/stats/").status_code == 200

    def test_it_carries_a_ttl_so_the_strip_costs_one_request_per_window(self, client, seeded_db):
        cc = client.get("/api/stats/").headers["cache-control"].lower()
        assert "max-age=600" in cc, cc
        assert "no-store" not in cc, cc

    def test_it_leaks_nothing_beyond_the_counts(self, client, seeded_db):
        # Public route: totals only. Never a supplier name, an id, or anything
        # a competitor could not already count by walking the sitemap.
        body = _get(client)
        assert all(isinstance(v, int) for v in body.values()), body


class TestAnEmptyCatalog:
    def test_the_figures_are_zero_rather_than_null(self, client, db):
        # A fresh environment (migrations run, seed not yet) must render "0",
        # not crash the strip on a null.
        assert _get(client) == {
            "parts": 0,
            "distributors": 0,
            "categories": 0,
            "subcategories": 0,
        }

    def test_an_all_zero_snapshot_is_never_stored(self, db, monkeypatch):
        """`./deploy.sh --reseed` truncates the catalog out from under a
        RUNNING api container, and this cache is per-process — nothing in that
        path can call the invalidation seam. Caching the empty moment would pin
        "0 Distributor Parts" on the public page for the rest of the TTL.

        Driven at the service rather than through the fixture: emptying the
        seeded catalog by hand means fighting five FK chains to prove one
        branch."""
        clock = [1_000.0]
        monkeypatch.setattr(site_stats, "_now", lambda: clock[0])
        empty = {"parts": 0, "distributors": 0, "categories": 0, "subcategories": 0}
        full = {"parts": 7, "distributors": 3, "categories": 2, "subcategories": 5}

        snapshots = [empty, empty, full]
        monkeypatch.setattr(site_stats, "_compute", lambda _db: snapshots.pop(0))

        assert site_stats.get_site_stats(db) == empty
        assert site_stats._stats_cache is None, "an empty catalog must not be cached"
        assert site_stats.get_site_stats(db) == empty  # recomputed, still empty
        # Reseed lands. Same TTL window, no seam call — and the page recovers.
        clock[0] += 1
        assert site_stats.get_site_stats(db) == full

    def test_a_real_snapshot_is_still_cached(self, db, monkeypatch):
        # The zero carve-out must not accidentally disable caching outright.
        monkeypatch.setattr(
            site_stats,
            "_compute",
            lambda _db: {"parts": 7, "distributors": 3, "categories": 2, "subcategories": 5},
        )
        site_stats.get_site_stats(db)
        assert site_stats._stats_cache is not None


class TestTheContractHoldsAcrossLanguages:
    """The About page keys off these FIELD NAMES (`STAT_TILES[].key`, typed
    `keyof SiteStats`). TypeScript checks the tiles against its own interface,
    but nothing checks that interface against this route — a rename here would
    type-check on both sides and render four em dashes in production."""

    TS_TYPE = (
        pathlib.Path(__file__).resolve().parents[2]
        / "frontend/src/public/types/stats.ts"
    )

    def test_the_typescript_interface_names_exactly_these_fields(self, client, seeded_db):
        source = self.TS_TYPE.read_text()
        declared = set(re.findall(r"^\s{2}(\w+):\s*number;", source, re.MULTILINE))
        assert declared == EXPECTED_KEYS, (
            "frontend/src/public/types/stats.ts disagrees with GET /api/stats/: "
            f"{declared ^ EXPECTED_KEYS}"
        )

    def test_the_route_sends_what_the_interface_declares(self, client, seeded_db):
        assert set(_get(client)) == EXPECTED_KEYS
