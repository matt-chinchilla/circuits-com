"""recommend() — table-driven. MIRROR NOTICE: the case names here are shared
with frontend/src/public/pages/bom/lib/priceBreaks.test.ts. Editing the rule
means editing BOTH tables in the same change, exactly like the password
policy's two homes."""

from app.services.bom_match import SPONSOR_BAND, Offer, price_at, recommend


def offer(supplier_id, price, stock=100, breaks=(), stale=False):
    return Offer(
        supplier_id=supplier_id,
        stock_quantity=stock,
        unit_price=price,
        breaks=tuple(breaks),
        price_stale=stale,
    )


PLATINUM = {"sp-plat": (0, "2026-01-01")}
GOLD = {"sp-gold": (1, "2026-01-01")}


class TestPriceAt:
    def test_below_smallest_min_uses_base_price(self):
        o = offer("s1", 0.50, breaks=[(10, 0.40), (100, 0.30)])
        assert price_at(o, 1) == 0.50

    def test_largest_min_at_or_below_qty_wins(self):
        o = offer("s1", 0.50, breaks=[(10, 0.40), (100, 0.30)])
        assert price_at(o, 10) == 0.40
        assert price_at(o, 99) == 0.40
        assert price_at(o, 100) == 0.30
        assert price_at(o, 5000) == 0.30


class TestRecommend:
    def test_case_sponsor_within_band_wins(self):
        offers = [offer("cheap", 1.00), offer("sp-plat", 1.19)]
        assert recommend(offers, 1, PLATINUM) == "sp-plat"

    def test_case_sponsor_at_exact_band_edge_wins(self):
        offers = [offer("cheap", 1.00), offer("sp-plat", 1.20)]
        assert recommend(offers, 1, PLATINUM) == "sp-plat"

    def test_case_sponsor_outside_band_loses_to_cheapest(self):
        offers = [offer("cheap", 1.00), offer("sp-plat", 1.21)]
        assert recommend(offers, 1, PLATINUM) == "cheap"

    def test_case_highest_tier_sponsor_is_the_one_band_tested(self):
        # Platinum outside the band does NOT fall through to gold-in-band:
        # the spec band-tests only the top sponsor, then falls to cheapest.
        offers = [offer("cheap", 1.00), offer("sp-plat", 1.50), offer("sp-gold", 1.10)]
        rank = {**PLATINUM, **GOLD}
        assert recommend(offers, 1, rank) == "cheap"

    def test_case_tier_tie_goes_to_oldest_sponsorship(self):
        offers = [offer("sp-old", 1.10), offer("sp-new", 1.05)]
        rank = {"sp-old": (1, "2025-01-01"), "sp-new": (1, "2026-06-01")}
        assert recommend(offers, 1, rank) == "sp-old"

    def test_case_no_sponsor_cheapest_wins(self):
        offers = [offer("a", 2.00), offer("b", 1.00)]
        assert recommend(offers, 1, {}) == "b"

    def test_case_out_of_stock_is_never_recommended(self):
        offers = [offer("sp-plat", 1.00, stock=0), offer("b", 5.00)]
        assert recommend(offers, 1, PLATINUM) == "b"

    def test_case_all_out_of_stock_returns_none(self):
        offers = [offer("a", 1.00, stock=0)]
        assert recommend(offers, 1, {}) is None

    def test_case_price_tie_prefers_sponsor_then_stock(self):
        offers = [offer("plain", 1.00, stock=50), offer("sp-gold", 1.00, stock=10)]
        assert recommend(offers, 1, GOLD) == "sp-gold"
        no_rank = [offer("small", 1.00, stock=10), offer("big", 1.00, stock=500)]
        assert recommend(no_rank, 1, {}) == "big"

    def test_case_band_compares_at_the_line_qty_break(self):
        # At qty 100 the sponsor's break brings it inside the band even though
        # its base price is far outside.
        offers = [
            offer("cheap", 1.00, breaks=[(100, 1.00)]),
            offer("sp-plat", 2.00, breaks=[(100, 1.15)]),
        ]
        assert recommend(offers, 100, PLATINUM) == "sp-plat"
        assert recommend(offers, 1, PLATINUM) == "cheap"

    def test_case_stale_price_still_recommendable(self):
        # price_stale is a DISPLAY flag (hatched right rail); it does not
        # change the pick — honesty is rendered, not silently re-ranked.
        offers = [offer("stale", 1.00, stale=True), offer("fresh", 1.50)]
        assert recommend(offers, 1, {}) == "stale"

    def test_band_constant_is_the_documented_twenty_percent(self):
        assert SPONSOR_BAND == 1.20


class TestLoadTierRank:
    def test_active_or_null_and_tier_casing(self, db, seeded_db):
        # seeded_db carries legacy lowercase tiers and NULL statuses — the
        # rank loader must treat NULL as active and lower() every tier
        # (the standing tier-casing gotcha).
        from app.models import Sponsor
        from app.services.bom_match import load_tier_rank

        rows = db.query(Sponsor).all()
        supplier_ids = {str(r.supplier_id) for r in rows}
        rank = load_tier_rank(db, supplier_ids)
        assert rank, "seeded sponsors must produce at least one ranked supplier"
        assert all(r[0] in (0, 1, 2) for r in rank.values())
