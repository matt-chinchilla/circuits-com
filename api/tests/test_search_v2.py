"""Search v2 — GET /api/search/?q=&suggest= (spec §1.3/§1.5).

Absorbs and replaces the old test_search.py: the v1 response shape (and its
`listings_count` field) is gone. Covers the response contract, the batched
derived part fields (dist_count is COUNT(DISTINCT supplier_id)), the
category-card rollup + matched-children ordering, supplier tier
normalization, the manufacturers section, and the fuzzy zero-result recovery
(did-you-mean + closest parts) with its suggest=0 off-switch.
"""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import Category, Part, PartListing, Sponsor, Supplier
from app.services.search_suggest import (
    char_trigrams,
    closest_score,
    did_you_mean,
    levenshtein,
)

RESPONSE_KEYS = {
    "parts",
    "categories",
    "suppliers",
    "manufacturers",
    "total",
    "took_ms",
    "suggestions",
    "closest_parts",
}

SEARCH_PART_KEYS = {
    "id",
    "sku",
    "slug",
    "description",
    "manufacturer_name",
    "package",
    "mount",
    "rohs",
    "lead_time_days",
    "moq",
    "dist_count",
    "best_price",
    "stock",
    "lifecycle_status",
    "category_icon",
    "category_slug",
    "parent_category_slug",
}


def _search(client, q, **params):
    resp = client.get("/api/search/", params={"q": q, **params})
    assert resp.status_code == 200
    return resp.json()


# ── Pure fuzzy scoring (search_suggest) ─────────────────────────────────────


class TestLevenshtein:
    def test_basics(self):
        assert levenshtein("", "abc") == 3
        assert levenshtein("abc", "") == 3
        assert levenshtein("abc", "abc") == 0
        assert levenshtein("mauser", "mouser") == 1
        assert levenshtein("kitten", "sitting") == 3


class TestDidYouMean:
    def test_mauser_reaches_mouser_electronics(self):
        vocab = [
            ("Mouser Electronics", "distributor", None),
            ("Kennedy Electronics", "distributor", None),
            ("Integrated Circuits", "category", "cpu"),
        ]
        out = did_you_mean("Mauser", vocab)
        assert out
        assert out[0] == {"term": "Mouser Electronics", "kind": "distributor", "icon": None}

    def test_token_containment_is_cumulative(self):
        vocab = [("Clock and Timing", "category", "clock")]
        # both ≥3-char tokens contained → +3 each, well past the floor
        out = did_you_mean("clock timing", vocab)
        assert [s["term"] for s in out] == ["Clock and Timing"]
        assert out[0]["icon"] == "clock"

    def test_garbage_scores_zero_chips(self):
        vocab = [
            ("Mouser Electronics", "distributor", None),
            ("Integrated Circuits", "category", "cpu"),
            ("Texas Instruments", "manufacturer", None),
        ]
        assert did_you_mean("xzqv9", vocab) == []

    def test_cap_four(self):
        vocab = [
            (f"Timer {n}", "distributor", None) for n in ("One", "Two", "Three", "Four", "Five")
        ]
        assert len(did_you_mean("timerz", vocab)) == 4

    def test_non_category_outranks_category_at_equal_distance(self):
        # same term can only appear once in real vocab; use two near-identical
        terms = [("Sensora", "category", "gauge"), ("Sensorb", "distributor", None)]
        out = did_you_mean("sensor", terms)
        assert out[0]["kind"] == "distributor"

    def test_category_kind_carries_icon_others_null(self):
        vocab = [
            ("Oscillators", "category", "wave-sine"),
            ("Oscillator Corp", "distributor", None),
        ]
        out = did_you_mean("oscilator", vocab)
        kinds = {s["term"]: s["icon"] for s in out}
        assert kinds.get("Oscillators") == "wave-sine"
        assert kinds.get("Oscillator Corp") is None


class TestClosestScore:
    def test_trigrams(self):
        assert char_trigrams("LM7805") == {"lm7", "m78", "780", "805"}
        assert char_trigrams("ab") == set()

    def test_overlap_and_prefix(self):
        # identical sku: every trigram overlaps ×2 plus the full prefix
        s = closest_score("LM7805", "LM7805", "LM7805 regulator")
        assert s >= 2 * 4 + 6
        # unrelated: nothing
        assert closest_score("LM7805", "XC9536", "XC9536 CPLD") < 2


# ── Response contract ───────────────────────────────────────────────────────


class TestResponseShape:
    def test_top_level_keys(self, client, seeded_db):
        data = _search(client, "LM7805")
        assert set(data.keys()) == RESPONSE_KEYS
        assert isinstance(data["took_ms"], float)
        assert data["took_ms"] >= 0

    def test_part_hit_shape_and_no_v1_fields(self, client, seeded_db):
        data = _search(client, "LM7805")
        part = data["parts"][0]
        assert set(part.keys()) == SEARCH_PART_KEYS
        assert "listings_count" not in part

    def test_total_is_sum_of_sections(self, client, seeded_db):
        data = _search(client, "Clock")
        assert data["total"] == (
            len(data["parts"])
            + len(data["categories"])
            + len(data["suppliers"])
            + len(data["manufacturers"])
        )

    def test_empty_results(self, client, seeded_db):
        data = _search(client, "zzzznothing", suggest=0)
        assert data["parts"] == []
        assert data["categories"] == []
        assert data["suppliers"] == []
        assert data["manufacturers"] == []
        assert data["total"] == 0


# ── Parts: matching + batched derived fields ────────────────────────────────


class TestParts:
    def test_search_by_sku(self, client, seeded_db):
        data = _search(client, "LM7805")
        assert len(data["parts"]) == 1
        part = data["parts"][0]
        assert part["sku"] == "LM7805CT"
        assert part["manufacturer_name"] == "Texas Instruments"
        assert part["best_price"] == pytest.approx(0.48, abs=0.01)

    def test_search_by_description(self, client, seeded_db):
        data = _search(client, "Cortex")
        assert [p["sku"] for p in data["parts"]] == ["STM32F407VGT6"]

    def test_search_by_manufacturer(self, client, seeded_db):
        data = _search(client, "STMicroelectronics")
        assert "STM32F407VGT6" in [p["sku"] for p in data["parts"]]

    def test_derived_fields(self, client, seeded_db):
        part = _search(client, "LM7805")["parts"][0]
        assert part["dist_count"] == 2  # two listings, two suppliers
        assert part["stock"] == 23000
        assert part["moq"] == 10  # smallest PriceBreak.min_quantity
        assert part["category_slug"] == "clock-and-timing"
        assert part["parent_category_slug"] == "integrated-circuits"
        assert part["category_icon"] == "⏰"

    def test_a_supplier_cannot_be_listed_twice_for_one_part(self, db, seeded_db):
        """This used to be possible, and dist_count used COUNT(DISTINCT) to
        cope. The schema now prevents it outright.

        The defence moved from the query to the constraint: a raw listing
        count double-counted a supplier, so the aggregate defended itself.
        uq_part_listings_part_supplier makes the bad row unstorable instead,
        which is the stronger place for the rule to live. The COUNT(DISTINCT)
        stays as belt-and-braces; it is simply no longer reachable.
        """
        db.add(
            PartListing(
                id=uuid.uuid4(),
                part_id=seeded_db["part1"].id,
                supplier_id=seeded_db["supplier1"].id,
                sku="AVN-LM7805CT-REEL",
                stock_quantity=1000,
                unit_price=Decimal("0.5100"),
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()

    def test_dist_count_counts_each_distributor_once(self, client, db, seeded_db):
        """Two DIFFERENT suppliers on one part read as two distributors."""
        other = Supplier(id=uuid.uuid4(), name="Avnet Test", website="avnet.test",
                         email="s@avnet.test")
        db.add(other)
        db.flush()
        db.add(
            PartListing(
                id=uuid.uuid4(),
                part_id=seeded_db["part1"].id,
                supplier_id=other.id,
                sku="AVN-LM7805CT-REEL",
                stock_quantity=1000,
                unit_price=Decimal("0.5100"),
            )
        )
        db.commit()
        part = _search(client, "LM7805")["parts"][0]
        # seeded_db already gives part1 two distributors; this adds a third.
        assert part["dist_count"] == 3
        assert part["stock"] == 24000

    def test_listingless_part_has_null_derived(self, client, seeded_db):
        part = _search(client, "STM32F407")["parts"][0]
        assert part["dist_count"] == 0
        assert part["stock"] == 0
        assert part["moq"] is None
        assert part["best_price"] is None


# ── Categories: parent cards, rollup, matched-children ordering ─────────────


class TestCategories:
    def test_child_match_surfaces_parent_card(self, client, seeded_db):
        data = _search(client, "Clock")
        assert len(data["categories"]) == 1
        card = data["categories"][0]
        assert card["name"] == "Integrated Circuits"
        assert card["parent_slug"] is None
        children = card["children"]
        assert {"name": "Clock and Timing", "slug": "clock-and-timing", "matched": True} in children

    def test_parts_count_rolls_up_children(self, client, seeded_db):
        card = _search(client, "Integrated")["categories"][0]
        # both seeded parts live on the CHILD; the parent rolls them up
        assert card["parts_count"] == 2

    def test_matched_children_ordered_first(self, client, db, seeded_db):
        db.add(
            Category(
                id=uuid.uuid4(),
                name="Oscillators",
                slug="oscillators",
                icon="wave-sine",
                parent_id=seeded_db["parent"].id,
                sort_order=5,
            )
        )
        db.commit()
        card = _search(client, "Oscillators")["categories"][0]
        assert card["name"] == "Integrated Circuits"
        assert card["children"][0] == {
            "name": "Oscillators",
            "slug": "oscillators",
            "matched": True,
        }
        assert card["children"][1]["matched"] is False


# ── Suppliers: normalized active tier ───────────────────────────────────────


class TestSuppliers:
    def test_supplier_hit_shape(self, client, seeded_db):
        data = _search(client, "Avnet")
        assert len(data["suppliers"]) == 1
        hit = data["suppliers"][0]
        assert set(hit.keys()) == {"id", "name", "website", "logo_url", "description", "tier"}
        assert hit["name"] == "Avnet"

    def test_null_status_sponsor_counts_as_active(self, client, seeded_db):
        # seeded Kennedy sponsor: tier="gold", status=None → still active
        hit = _search(client, "Kennedy")["suppliers"][0]
        assert hit["tier"] == "gold"

    def test_lowercase_platinum_still_badges(self, client, db, seeded_db):
        db.add(
            Sponsor(
                id=uuid.uuid4(),
                supplier_id=seeded_db["supplier1"].id,
                category_id=seeded_db["parent"].id,
                tier="platinum",
                status="Active",
            )
        )
        db.commit()
        assert _search(client, "Avnet")["suppliers"][0]["tier"] == "platinum"

    def test_titlecase_tier_normalized_lowercase(self, client, db, seeded_db):
        db.add(
            Sponsor(
                id=uuid.uuid4(),
                supplier_id=seeded_db["supplier1"].id,
                category_id=seeded_db["parent"].id,
                tier="Platinum",
                status="Active",
            )
        )
        db.commit()
        assert _search(client, "Avnet")["suppliers"][0]["tier"] == "platinum"

    def test_expired_sponsorship_is_no_tier(self, client, db, seeded_db):
        db.add(
            Sponsor(
                id=uuid.uuid4(),
                supplier_id=seeded_db["supplier1"].id,
                category_id=seeded_db["parent"].id,
                tier="Platinum",
                status="Expired",
            )
        )
        db.commit()
        assert _search(client, "Avnet")["suppliers"][0]["tier"] is None

    def test_public_suppliers_listing_carries_same_tier(self, client, seeded_db):
        """§1.4a: GET /api/suppliers/ rows share the normalized-tier helper."""
        rows = client.get("/api/suppliers/").json()
        by_name = {r["name"]: r for r in rows}
        assert by_name["Kennedy Electronics"]["tier"] == "gold"
        assert by_name["Avnet"]["tier"] is None
        # existing fields survive untouched
        assert "phone" in by_name["Avnet"]


# ── Manufacturers section ───────────────────────────────────────────────────


class TestManufacturers:
    def test_manufacturer_section(self, client, seeded_db):
        data = _search(client, "STMicroelectronics")
        assert {"name": "STMicroelectronics", "parts_count": 1} in data["manufacturers"]

    def test_substring_match(self, client, seeded_db):
        data = _search(client, "instruments")
        assert {"name": "Texas Instruments", "parts_count": 1} in data["manufacturers"]


# ── Fuzzy recovery gate ─────────────────────────────────────────────────────


class TestFuzzyRecovery:
    def test_null_on_hits(self, client, seeded_db):
        data = _search(client, "Avnet")
        assert data["suggestions"] is None
        assert data["closest_parts"] is None

    def test_null_when_suggest_zero(self, client, seeded_db):
        data = _search(client, "Mauser", suggest=0)
        assert data["total"] == 0
        assert data["suggestions"] is None
        assert data["closest_parts"] is None

    def test_mauser_suggests_mouser_electronics(self, client, db, seeded_db):
        db.add(Supplier(id=uuid.uuid4(), name="Mouser Electronics", website="mouser.com"))
        db.commit()
        data = _search(client, "Mauser")
        assert data["total"] == 0
        assert {"term": "Mouser Electronics", "kind": "distributor", "icon": None} in data[
            "suggestions"
        ]

    def test_garbage_yields_zero_chips_but_not_null(self, client, seeded_db):
        data = _search(client, "xzqv9w")
        assert data["total"] == 0
        assert data["suggestions"] == []
        assert data["closest_parts"] is not None

    def test_closest_parts_backfills_popular_by_stock(self, client, seeded_db):
        data = _search(client, "zzzznothing")
        skus = [p["sku"] for p in data["closest_parts"]]
        # nothing scores — both catalog parts backfill, stock-ordered
        assert skus == ["LM7805CT", "STM32F407VGT6"]
        assert set(data["closest_parts"][0].keys()) == SEARCH_PART_KEYS

    def test_closest_parts_prefix_match_ranks_first(self, client, db, seeded_db):
        data = _search(client, "LM780599")  # near-miss of a real SKU
        assert data["total"] == 0
        assert data["closest_parts"][0]["sku"] == "LM7805CT"

    def test_closest_parts_cap_15(self, client, db, seeded_db):
        for i in range(20):
            db.add(
                Part(
                    id=uuid.uuid4(),
                    sku=f"FILLER-{i:03d}",
                    manufacturer_name="Filler Corp",
                    category_id=seeded_db["child"].id,
                )
            )
        db.commit()
        data = _search(client, "zzzznothing")
        assert len(data["closest_parts"]) == 15

    def test_suggestions_cap_four(self, client, db, seeded_db):
        for name in ("Timer One", "Timer Two", "Timer Three", "Timer Four", "Timer Five"):
            db.add(Supplier(id=uuid.uuid4(), name=name))
        db.commit()
        data = _search(client, "timerz")
        assert data["total"] == 0
        assert len(data["suggestions"]) == 4

    def test_suggestion_vocab_has_no_part_skus(self, client, seeded_db):
        """Deliberate divergence from the kit: 132k SKUs are not vocabulary."""
        data = _search(client, "LM7805C7")  # 1 edit from LM7805CT, total 0
        assert data["total"] == 0
        for s in data["suggestions"] or []:
            assert s["kind"] in ("distributor", "manufacturer", "category")
            assert s["term"] != "LM7805CT"


# ── suggest param plumbing ──────────────────────────────────────────────────


class TestSuggestParam:
    def test_accepts_zero_and_one(self, client, seeded_db):
        assert client.get("/api/search/", params={"q": "x", "suggest": "0"}).status_code == 200
        assert client.get("/api/search/", params={"q": "x", "suggest": "1"}).status_code == 200

    def test_defaults_on(self, client, seeded_db):
        data = _search(client, "zzzznothing")
        assert data["suggestions"] is not None
        assert data["closest_parts"] is not None


# ── compact=1 dropdown trim ─────────────────────────────────────────────────


def _seed_trim_catalog(db, seeded_db):
    """More matches than the compact caps in every section for query 'Trim'."""
    for i in range(8):
        db.add(
            Part(
                id=uuid.uuid4(),
                sku=f"TRIM-{i:03d}",
                manufacturer_name="Trim Corp",
                category_id=seeded_db["child"].id,
            )
        )
    for i in range(5):
        db.add(Supplier(id=uuid.uuid4(), name=f"Trim Supply {i}"))
    for i, letter in enumerate("ABCD"):
        db.add(
            Category(
                id=uuid.uuid4(),
                name=f"Trim Boards {letter}",
                slug=f"trim-boards-{letter.lower()}",
                sort_order=90 + i,
            )
        )
    db.commit()


class TestCompactParam:
    def test_accepts_zero_and_one(self, client, seeded_db):
        assert client.get("/api/search/", params={"q": "x", "compact": "0"}).status_code == 200
        assert client.get("/api/search/", params={"q": "x", "compact": "1"}).status_code == 200
        assert client.get("/api/search/", params={"q": "x", "compact": "2"}).status_code == 422

    def test_caps_each_section(self, client, db, seeded_db):
        _seed_trim_catalog(db, seeded_db)
        data = _search(client, "Trim", compact=1)
        assert len(data["parts"]) == 5
        assert len(data["categories"]) == 3
        assert len(data["suppliers"]) == 3
        assert data["manufacturers"] == []

    def test_shape_identical_and_total_sums_returned(self, client, db, seeded_db):
        _seed_trim_catalog(db, seeded_db)
        data = _search(client, "Trim", compact=1)
        assert set(data.keys()) == RESPONSE_KEYS
        assert set(data["parts"][0].keys()) == SEARCH_PART_KEYS
        assert data["total"] == (
            len(data["parts"])
            + len(data["categories"])
            + len(data["suppliers"])
            + len(data["manufacturers"])
        )

    def test_default_stays_full(self, client, db, seeded_db):
        _seed_trim_catalog(db, seeded_db)
        data = _search(client, "Trim")
        assert len(data["parts"]) == 8
        assert len(data["categories"]) == 4
        assert len(data["suppliers"]) == 5
        assert {"name": "Trim Corp", "parts_count": 8} in data["manufacturers"]


# ── Selectin-cascade guard (review-caught) ──────────────────────────────────
# Part.listings and PartListing.price_breaks are lazy="selectin", so a bare
# db.query(Part) hydrates the whole listings→breaks chain for every loaded
# row — the seed-probe lesson, replayed per keystroke. The search queries
# carry raiseload(Part.listings); these tests are the tripwire that keeps it.


class TestNoSelectinCascade:
    @pytest.fixture
    def captured_sql(self):
        """Every statement the engine executes while the test body runs."""
        from sqlalchemy import event

        from tests.conftest import engine

        statements: list[str] = []

        def _capture(conn, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", _capture)
        yield statements
        event.remove(engine, "before_cursor_execute", _capture)

    def test_search_never_selectin_loads_listings(self, client, db, seeded_db, captured_sql):
        db.expire_all()
        captured_sql.clear()
        _search(client, "LM7805")
        # The selectin signatures: listings keyed by part_id with no grouping,
        # breaks keyed by listing_id. The legit batched aggregates GROUP BY.
        for stmt in captured_sql:
            if "FROM part_listings" in stmt and "GROUP BY" not in stmt:
                raise AssertionError(f"listings selectin cascade fired:\n{stmt}")
            assert "price_breaks.listing_id IN" not in stmt, (
                f"price_breaks selectin cascade fired:\n{stmt}"
            )

    def test_zero_result_recovery_never_selectin_loads(self, client, db, seeded_db, captured_sql):
        """The expensive shape: a zero-result suggest=1 search pools up to 400
        candidate parts — none of them may drag their listings along."""
        db.expire_all()
        captured_sql.clear()
        _search(client, "LM780599")  # near-miss → recovery path incl. backfill
        for stmt in captured_sql:
            if "FROM part_listings" in stmt and "GROUP BY" not in stmt:
                raise AssertionError(f"listings selectin cascade fired:\n{stmt}")
            assert "price_breaks.listing_id IN" not in stmt

    def test_loaded_parts_have_listings_unloaded(self, db, seeded_db):
        """State-level proof: after a service call, no Part instance the
        search loaded has its listings relationship populated."""
        from sqlalchemy import inspect as sa_inspect

        from app.services.search_service import search as service_search

        db.expire_all()
        service_search(db, "LM7805")
        loaded = [obj for obj in db.identity_map.values() if isinstance(obj, Part)]
        assert loaded, "search should have loaded Part rows"
        for part in loaded:
            assert "listings" in sa_inspect(part).unloaded


# ── Query-length bound (DoS) ────────────────────────────────────────────────


class TestQueryLengthBound:
    """`q` is unauthenticated and the fuzzy recovery is superlinear in its
    length (measured on the 6.3k-part dev catalog: 100 chars 1.7s, 400 chars
    5.4s, 1600 chars 20.9s), so an unbounded query is a CPU DoS. The route
    rejects; the service truncates so no other caller can bypass the route."""

    def test_max_length_is_a_real_bound(self):
        from app.services.search_service import MAX_QUERY_LENGTH

        # Sane: long enough for any SKU or part name, short enough that the
        # fuzzy pipeline stays cheap.
        assert 32 <= MAX_QUERY_LENGTH <= 256

    def test_at_the_bound_is_accepted(self, client, seeded_db):
        from app.services.search_service import MAX_QUERY_LENGTH

        resp = client.get("/api/search/", params={"q": "z" * MAX_QUERY_LENGTH})
        assert resp.status_code == 200

    def test_over_the_bound_is_422_not_work(self, client, seeded_db):
        from app.services.search_service import MAX_QUERY_LENGTH

        resp = client.get("/api/search/", params={"q": "z" * (MAX_QUERY_LENGTH + 1)})
        assert resp.status_code == 422

    def test_pathological_query_is_rejected_fast(self, client, seeded_db):
        """The reported shape: a long junk query that reaches the zero-result
        fuzzy path. Rejection must cost validation, not the pipeline."""
        import time as _time

        t0 = _time.perf_counter()
        resp = client.get("/api/search/", params={"q": "zx" * 800})
        elapsed = _time.perf_counter() - t0
        assert resp.status_code == 422
        assert elapsed < 1.0, f"422 took {elapsed:.3f}s — the query was still processed"

    def test_service_truncates_for_non_route_callers(self, db, seeded_db, monkeypatch):
        """search() is importable; the bound cannot live only at the route."""
        from app.services import search_service
        from app.services.search_service import MAX_QUERY_LENGTH

        seen: list[str] = []
        real = search_service.did_you_mean

        def spy(query, vocab):
            seen.append(query)
            return real(query, vocab)

        monkeypatch.setattr(search_service, "did_you_mean", spy)
        search_service.search(db, "q" * (MAX_QUERY_LENGTH * 4))
        assert seen, "the zero-result recovery should have run"
        assert all(len(q) <= MAX_QUERY_LENGTH for q in seen)

    def test_truncation_does_not_change_ordinary_queries(self, db, seeded_db):
        from app.services.search_service import search as service_search

        short = service_search(db, "LM7805")
        assert short["total"] > 0


# ── Catalog-mutation cache invalidation ─────────────────────────────────────


class TestCatalogCacheInvalidation:
    """The three TTL caches (manufacturers / did-you-mean vocab / backfill
    pool) carry a 600s TTL, so without an explicit bust an admin's edit took
    up to ten minutes to show up in search."""

    def _mfr_names(self, db):
        from app.services.search_service import get_public_manufacturers

        return {m["name"] for m in get_public_manufacturers(db)}

    def test_invalidate_clears_all_three(self, db, seeded_db):
        from app.services import search_service

        # Warm all three.
        search_service.search(db, "zzzznothing")
        assert search_service._manufacturers_cache is not None
        assert search_service._vocab_cache is not None
        assert search_service._backfill_ids_cache is not None

        search_service.invalidate_catalog_caches()
        assert search_service._manufacturers_cache is None
        assert search_service._vocab_cache is None
        assert search_service._backfill_ids_cache is None

    def test_create_part_busts_the_manufacturers_cache(self, client, db, seeded_db, auth_header):
        assert "Cache Bust Devices" not in self._mfr_names(db)  # warms the cache
        resp = client.post(
            "/api/parts/",
            json={"sku": "CACHEBUST-1", "manufacturer_name": "Cache Bust Devices"},
            headers=auth_header(),
        )
        assert resp.status_code in (200, 201), resp.text
        # No TTL wait, no clock monkeypatch: the mutation itself busts.
        assert "Cache Bust Devices" in self._mfr_names(db)

    def test_delete_part_busts_the_manufacturers_cache(self, client, db, seeded_db, auth_header):
        auth = auth_header()
        created = client.post(
            "/api/parts/",
            json={"sku": "CACHEBUST-2", "manufacturer_name": "Doomed Devices"},
            headers=auth,
        ).json()
        assert "Doomed Devices" in self._mfr_names(db)
        assert client.delete(f"/api/parts/{created['id']}", headers=auth).status_code == 200
        assert "Doomed Devices" not in self._mfr_names(db)

    def test_batch_import_busts_the_manufacturers_cache(self, client, db, seeded_db, auth_header):
        supplier_id = str(seeded_db["supplier1"].id)
        assert "Batch Bust Corp" not in self._mfr_names(db)
        resp = client.post(
            "/api/parts/batch",
            json={
                "supplier_id": supplier_id,
                "parts": [{"sku": "BATCHBUST-1", "manufacturer_name": "Batch Bust Corp"}],
            },
            headers=auth_header(),
        )
        assert resp.json()["created"] == 1, resp.text
        assert "Batch Bust Corp" in self._mfr_names(db)

    def test_create_supplier_busts_the_suggestion_vocab(self, client, db, seeded_db, auth_header):
        from app.services.search_service import _suggestion_vocab

        def vocab_terms():
            return {term for term, _kind, _icon in _suggestion_vocab(db)}

        assert "Vocab Bust Distribution" not in vocab_terms()  # warms the cache
        resp = client.post(
            "/api/suppliers/",
            json={"name": "Vocab Bust Distribution"},
            headers=auth_header(),
        )
        assert resp.status_code in (200, 201), resp.text
        assert "Vocab Bust Distribution" in vocab_terms()

    def test_backfill_pool_tolerates_deleted_ids(self, db, seeded_db):
        """The pool is a cached SNAPSHOT of ids. A part deleted after the
        refresh must cost a BACKFILL SLOT, not a result row — and must never
        surface as a phantom (an id with no row behind it)."""
        from app.models import Part
        from app.services import search_service
        from app.services.search_service import CLOSEST_LIMIT

        # A catalog comfortably larger than the pool so refill has somewhere
        # to go (pool = 2 x CLOSEST_LIMIT).
        for i in range(CLOSEST_LIMIT * 3):
            db.add(
                Part(
                    id=uuid.uuid4(),
                    sku=f"POOL-{i:03d}",
                    manufacturer_name="Pool Corp",
                    category_id=seeded_db["child"].id,
                )
            )
        db.commit()

        # Warm the pool, then delete its head WITHOUT busting (the exact
        # window a stale snapshot lives in) — cascading exactly as
        # DELETE /api/parts/{id} does.
        from app.models import PartListing, PriceBreak

        pool = list(search_service._popular_backfill_ids(db))
        assert len(pool) >= CLOSEST_LIMIT
        doomed = set(pool[:3])
        listing_ids = [
            row[0] for row in db.query(PartListing.id).filter(PartListing.part_id.in_(doomed)).all()
        ]
        if listing_ids:
            db.query(PriceBreak).filter(PriceBreak.listing_id.in_(listing_ids)).delete(
                synchronize_session=False
            )
        db.query(PartListing).filter(PartListing.part_id.in_(doomed)).delete(
            synchronize_session=False
        )
        db.query(Part).filter(Part.id.in_(doomed)).delete(synchronize_session=False)
        db.commit()
        assert search_service._backfill_ids_cache is not None, "pool must still be the stale one"

        data = search_service.search(db, "zzzznothingmatches")
        closest = data["closest_parts"]
        assert len(closest) == CLOSEST_LIMIT, "deleted ids must be refilled, not dropped"
        returned = {row["id"] for row in closest}
        assert not (returned & {str(pid) for pid in doomed}), "deleted id surfaced as a phantom"
        # Every row is a real, fully-built part, not a hole.
        assert all(row["sku"] for row in closest)
