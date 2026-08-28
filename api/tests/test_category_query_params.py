"""The category page's server-side query contract.

GET /api/categories/{slug}/ used to answer one shape: up to 500 rows, which the
browser then searched, filtered, sorted and paged. At 200k+ parts that model
truncated 27 of 28 top-level categories, so the work moved to the database and
the request grew params for it:

    parts_page / parts_per_page   paging, ceiling 100
    q                             free text over sku OR description
    mfg (repeated)                manufacturer_name IN (...)
    sub (repeated)                sub_slug IN (...), SLUGS not names, parents only
    sort / dir                    sku|desc|mfg|sub|qty1|qty10|qty100|qty1k|popular

Everything here is written so that DELETING the behaviour it names turns it
red: a filter test asserts both what survived and what a working filter had to
remove (and that the removed row is really in the unfiltered response); every
sort has a distinct expected order, so a sort silently falling back to another
one fails rather than passing on a coincidence.
"""

import uuid
from decimal import Decimal

import pytest

from app.models import Category, Part, PartListing, PriceBreak, Supplier
from app.services.part_pricing import refresh_best_prices

PARENT = "passives-qp"
RESISTORS = "resistors-qp"
CAPACITORS = "capacitors-qp"

# (sku, description, manufacturer, sub, stock, prices) where prices is
# (unit, 10, 100, 1000) or None for a part with no priced source at all.
#
# The tier prices are deliberately NOT a uniform ladder: each rung has a
# DIFFERENT cheapest part, so `sort=qty10` cannot pass by accidentally
# behaving like `sort=qty1`.
CATALOG = [
    ("CAP-100", "Ceramic capacitor 100nF", "Murata", CAPACITORS, 50, (0.50, 0.45, 0.40, 0.35)),
    ("CAP-200", "Electrolytic capacitor 220uF", "Yageo", CAPACITORS, 10, (3.00, 0.10, 2.50, 2.00)),
    ("RES-100", "Thick film resistor 100 ohm", "Vishay", RESISTORS, 100, (1.00, 0.90, 0.80, 0.05)),
    ("RES-200", "Precision resistor 200 ohm", "Yageo", RESISTORS, 500, (2.00, 1.80, 0.30, 1.20)),
    ("RES-300", "Chip resistor 300 ohm", "Vishay", RESISTORS, 0, None),
]


@pytest.fixture
def catalog(db):
    """A parent with two subcategories and five parts, priced and stocked.

    Prices land in `parts.best_price*` through `refresh_best_prices` — the same
    single home every write path calls — rather than being written by hand, so
    these tests exercise the real relationship between a listing's ladder and
    the columns the sort reads.
    """
    parent = Category(id=uuid.uuid4(), name="Passives", slug=PARENT, icon="circuitry", sort_order=0)
    db.add(parent)
    db.flush()
    subs = {}
    for order, (slug, name, icon) in enumerate(
        [(RESISTORS, "Resistors", "resistor"), (CAPACITORS, "Capacitors", "capacitor")]
    ):
        child = Category(
            id=uuid.uuid4(),
            name=name,
            slug=slug,
            icon=icon,
            parent_id=parent.id,
            sort_order=order,
        )
        db.add(child)
        subs[slug] = child
    db.flush()

    supplier = Supplier(id=uuid.uuid4(), name="Mouser QP")
    db.add(supplier)
    db.flush()

    part_ids = []
    for sku, description, mfg, sub, stock, prices in CATALOG:
        part = Part(
            id=uuid.uuid4(),
            sku=sku,
            description=description,
            manufacturer_name=mfg,
            category_id=subs[sub].id,
            sub_slug=sub,
            lifecycle_status="active",
        )
        db.add(part)
        db.flush()
        part_ids.append(part.id)
        if prices is None:
            continue
        listing = PartListing(
            id=uuid.uuid4(),
            part_id=part.id,
            supplier_id=supplier.id,
            stock_quantity=stock,
            unit_price=Decimal(str(prices[0])),
        )
        db.add(listing)
        db.flush()
        for qty, price in zip((10, 100, 1000), prices[1:], strict=True):
            db.add(
                PriceBreak(
                    id=uuid.uuid4(),
                    listing_id=listing.id,
                    min_quantity=qty,
                    unit_price=Decimal(str(price)),
                )
            )
    refresh_best_prices(db, part_ids)
    db.commit()
    return {"parent": parent, **subs}


def _body(client, slug: str, query: str = "") -> dict:
    response = client.get(f"/api/categories/{slug}{'?' + query if query else ''}")
    assert response.status_code == 200, response.text
    return response.json()


def _parts(client, slug: str, query: str = "") -> dict:
    return _body(client, slug, query)["parts"]


def _facets(client, slug: str, query: str = "") -> dict:
    """`facets` is a SIBLING of `parts` on the response, not a field inside it."""
    return _body(client, slug, query)["facets"]


def _skus(client, slug: str, query: str = "") -> list[str]:
    return [p["sku"] for p in _parts(client, slug, query)["items"]]


# ── Scope ───────────────────────────────────────────────────────────────────


class TestScope:
    def test_parent_rolls_up_its_children(self, client, catalog):
        """The parent's single parts block spans self + immediate children."""
        parts = _parts(client, PARENT)
        assert parts["total"] == 5
        assert set(p["sku"] for p in parts["items"]) == {sku for sku, *_ in CATALOG}
        # Each row still says which subcategory it came from.
        by_sku = {p["sku"]: p for p in parts["items"]}
        assert by_sku["CAP-100"]["sub_slug"] == CAPACITORS
        assert by_sku["RES-100"]["sub_slug"] == RESISTORS
        # ...and carries that subcategory's own icon, not the parent's.
        assert by_sku["CAP-100"]["category_icon"] == "capacitor"
        assert by_sku["RES-100"]["category_icon"] == "resistor"

    def test_leaf_serves_only_its_own(self, client, catalog):
        assert set(_skus(client, RESISTORS)) == {"RES-100", "RES-200", "RES-300"}
        assert set(_skus(client, CAPACITORS)) == {"CAP-100", "CAP-200"}

    def test_display_prices_come_off_the_part_row(self, client, catalog):
        """The four price columns are read straight off `parts`, which is what
        makes sorting by them possible; the per-page aggregate queries they
        replaced are gone. `listings_count` is still batched — it is not a
        price and has no denormalized column."""
        row = next(p for p in _parts(client, RESISTORS)["items"] if p["sku"] == "RES-100")
        assert (row["best_price"], row["best_price_10"]) == (1.00, 0.90)
        assert (row["best_price_100"], row["best_price_1000"]) == (0.80, 0.05)
        assert row["listings_count"] == 1
        unpriced = next(p for p in _parts(client, RESISTORS)["items"] if p["sku"] == "RES-300")
        assert unpriced["best_price"] is None
        assert unpriced["listings_count"] == 0


# ── Defaults ────────────────────────────────────────────────────────────────


class TestDefaults:
    def test_leaf_defaults_to_sku_ascending(self, client, catalog):
        assert _skus(client, RESISTORS) == ["RES-100", "RES-200", "RES-300"]

    def test_parent_defaults_to_popular(self, client, catalog):
        """Total stock DESC — the ordering the rollup was designed around, and
        which the old client-side re-sort threw away on arrival. Note it is NOT
        sku order and NOT price order: RES-200 leads on 500 units."""
        assert _skus(client, PARENT) == ["RES-200", "RES-100", "CAP-100", "CAP-200", "RES-300"]

    def test_default_page_size_is_25(self, client, catalog):
        assert _parts(client, PARENT)["per_page"] == 25


# ── Filters ─────────────────────────────────────────────────────────────────


class TestSearchFilter:
    def test_q_matches_the_description(self, client, catalog):
        """'Electrolytic' appears in one DESCRIPTION and in no sku — a
        sku-only search returns nothing here."""
        assert _skus(client, PARENT, "q=Electrolytic") == ["CAP-200"]

    def test_q_matches_the_sku(self, client, catalog):
        """'RES-2' appears in one SKU and in no description — the mirror of the
        test above, so dropping either half of the OR fails one of them."""
        assert _skus(client, PARENT, "q=RES-2") == ["RES-200"]

    def test_q_is_case_insensitive(self, client, catalog):
        assert _skus(client, PARENT, "q=ceramic") == ["CAP-100"]

    def test_q_narrows_the_page_and_the_total(self, client, catalog):
        parts = _parts(client, PARENT, "q=resistor")
        assert set(p["sku"] for p in parts["items"]) == {"RES-100", "RES-200", "RES-300"}
        assert parts["total"] == 3, "total is the FILTERED total"
        assert _facets(client, PARENT, "q=resistor")["total_unfiltered"] == 5, "category holds 5"

    def test_wildcards_in_q_are_escaped(self, client, catalog):
        """A literal % must match a literal %, not everything. Unescaped, this
        query returns the whole category."""
        assert _skus(client, PARENT, "q=%25") == []
        assert _skus(client, PARENT, "q=_") == []


class TestManufacturerFilter:
    def test_absent_is_unfiltered(self, client, catalog):
        assert len(_skus(client, PARENT)) == 5

    def test_single_value(self, client, catalog):
        assert set(_skus(client, PARENT, "mfg=Vishay")) == {"RES-100", "RES-300"}

    def test_repeated_values_are_an_IN_list(self, client, catalog):
        assert set(_skus(client, PARENT, "mfg=Vishay&mfg=Murata")) == {
            "RES-100",
            "RES-300",
            "CAP-100",
        }
        # Murata's part is present with the filter and absent without one of
        # its values — the filter is doing the choosing, not the fixture.
        assert "CAP-100" not in _skus(client, PARENT, "mfg=Vishay")


class TestSubcategoryFilter:
    def test_filters_by_slug(self, client, catalog):
        assert set(_skus(client, PARENT, f"sub={CAPACITORS}")) == {"CAP-100", "CAP-200"}

    def test_takes_slugs_not_names(self, client, catalog):
        """The facet hands back slugs and the filter takes slugs. A display
        name must not quietly work, or the two halves drift apart."""
        assert _skus(client, PARENT, "sub=Capacitors") == []

    def test_repeated_values_are_an_IN_list(self, client, catalog):
        assert len(_skus(client, PARENT, f"sub={CAPACITORS}&sub={RESISTORS}")) == 5

    def test_ignored_on_a_leaf(self, client, catalog):
        """A leaf offers no subcategory facet, so a `sub` it cannot advertise
        must not be able to empty its page either."""
        assert set(_skus(client, RESISTORS, f"sub={CAPACITORS}")) == {
            "RES-100",
            "RES-200",
            "RES-300",
        }


class TestFiltersCompose:
    def test_q_and_mfg_and_sub_together(self, client, catalog):
        assert set(_skus(client, PARENT, "q=resistor&mfg=Vishay")) == {"RES-100", "RES-300"}
        assert _skus(client, PARENT, f"q=resistor&mfg=Vishay&sub={RESISTORS}&sort=sku") == [
            "RES-100",
            "RES-300",
        ]
        # Each clause is load-bearing: relax any one and the set grows.
        assert len(_skus(client, PARENT, "q=resistor")) == 3
        assert len(_skus(client, PARENT, "mfg=Vishay")) == 2

    def test_a_composition_that_matches_nothing(self, client, catalog):
        parts = _parts(client, PARENT, f"mfg=Murata&sub={RESISTORS}")
        assert parts["items"] == []
        assert parts["total"] == 0
        assert parts["pages"] == 1
        assert _facets(client, PARENT, f"mfg=Murata&sub={RESISTORS}")["total_unfiltered"] == 5


# ── Sorts ───────────────────────────────────────────────────────────────────


class TestSorts:
    def test_sku(self, client, catalog):
        assert _skus(client, PARENT, "sort=sku") == [
            "CAP-100",
            "CAP-200",
            "RES-100",
            "RES-200",
            "RES-300",
        ]
        assert _skus(client, PARENT, "sort=sku&dir=desc") == [
            "RES-300",
            "RES-200",
            "RES-100",
            "CAP-200",
            "CAP-100",
        ]

    def test_description(self, client, catalog):
        # Ceramic, Chip, Electrolytic, Precision, Thick film.
        assert _skus(client, PARENT, "sort=desc") == [
            "CAP-100",
            "RES-300",
            "CAP-200",
            "RES-200",
            "RES-100",
        ]

    def test_manufacturer_with_sku_tiebreak(self, client, catalog):
        """Murata, Vishay×2, Yageo×2 — the pairs tie, so the sku tiebreak is
        what makes the order deterministic instead of whatever the planner
        returns."""
        assert _skus(client, PARENT, "sort=mfg") == [
            "CAP-100",
            "RES-100",
            "RES-300",
            "CAP-200",
            "RES-200",
        ]

    def test_subcategory(self, client, catalog):
        assert _skus(client, PARENT, "sort=sub") == [
            "CAP-100",
            "CAP-200",
            "RES-100",
            "RES-200",
            "RES-300",
        ]

    def test_popular_is_total_stock(self, client, catalog):
        assert _skus(client, PARENT, "sort=popular") == [
            "RES-200",
            "RES-100",
            "CAP-100",
            "CAP-200",
            "RES-300",
        ]
        assert _skus(client, PARENT, "sort=popular&dir=desc")[0] == "RES-200"
        assert _skus(client, PARENT, "sort=popular&dir=asc")[0] == "RES-300"

    @pytest.mark.parametrize(
        "token,expected",
        [
            ("qty1", ["CAP-100", "RES-100", "RES-200", "CAP-200"]),
            ("qty10", ["CAP-200", "CAP-100", "RES-100", "RES-200"]),
            ("qty100", ["RES-200", "CAP-100", "RES-100", "CAP-200"]),
            ("qty1k", ["RES-100", "CAP-100", "RES-200", "CAP-200"]),
        ],
    )
    def test_each_price_rung_sorts_on_its_own_column(self, client, catalog, token, expected):
        """Four DIFFERENT expected orders, one per denormalized column. A sort
        that read the wrong column — or fell back to the unit price for all
        four — fails three of these four cases."""
        assert _skus(client, PARENT, f"sort={token}")[:4] == expected


class TestPricelessPartsSink:
    """NULLS LAST in BOTH directions.

    A deliberate, documented improvement on what the browser did: JS sorted
    `undefined` FIRST on an ascending sort, so "cheapest first" opened on a
    wall of parts carrying no price at all. A missing price is not a price of
    zero and is never the answer to "show me the cheapest".
    """

    @pytest.mark.parametrize("token", ["qty1", "qty10", "qty100", "qty1k"])
    @pytest.mark.parametrize("direction", ["asc", "desc"])
    def test_the_unpriced_part_is_last(self, client, catalog, token, direction):
        assert _skus(client, PARENT, f"sort={token}&dir={direction}")[-1] == "RES-300"

    def test_it_is_last_on_the_last_page_too(self, client, catalog):
        """Paged, the sink has to hold across the page boundary or the part
        reappears in the middle of the list."""
        assert _skus(client, PARENT, "sort=qty1&parts_per_page=2&parts_page=1") == [
            "CAP-100",
            "RES-100",
        ]
        assert _skus(client, PARENT, "sort=qty1&parts_per_page=2&parts_page=3") == ["RES-300"]


class TestTheSortReadsTheStoredColumn:
    """The price sorts read `parts.best_price*`, not the listings underneath.

    That is the whole point of migration 046 — an ORDER BY over three GROUP BY
    aggregates is not a thing a category page can afford — and it is invisible
    in an ordinary test, because the column and the listing agree. So this one
    makes them DISAGREE and asserts the response follows the column. Keeping
    the two in agreement is `part_pricing.refresh_best_prices`'s job, and every
    write path that can move a price calls it.
    """

    def test_the_column_is_what_orders_and_what_is_displayed(self, client, catalog, db):
        cheap, dear = (
            db.query(Part).filter(Part.sku.in_(["CAP-100", "CAP-200"])).order_by(Part.sku).all()
        )
        assert (float(cheap.best_price), float(dear.best_price)) == (0.50, 3.00)
        # Invert the stored columns; the listings are untouched.
        cheap.best_price = Decimal("9.9900")
        dear.best_price = Decimal("0.0100")
        db.commit()

        assert _skus(client, CAPACITORS, "sort=qty1") == ["CAP-200", "CAP-100"]
        displayed = {p["sku"]: p["best_price"] for p in _parts(client, CAPACITORS)["items"]}
        assert displayed == {"CAP-200": 0.01, "CAP-100": 9.99}


# ── Facets ──────────────────────────────────────────────────────────────────


class TestFacets:
    def test_unfiltered_lists_everything_in_scope(self, client, catalog):
        facets = _facets(client, PARENT)
        assert facets["total_unfiltered"] == 5
        # Count DESC, name ASC.
        assert facets["manufacturers"] == [
            {"name": "Vishay", "count": 2},
            {"name": "Yageo", "count": 2},
            {"name": "Murata", "count": 1},
        ]
        assert facets["subs"] == [
            {"slug": RESISTORS, "name": "Resistors", "count": 3},
            {"slug": CAPACITORS, "name": "Capacitors", "count": 2},
        ]

    def test_a_leaf_has_no_subcategory_facet(self, client, catalog):
        facets = _facets(client, RESISTORS)
        assert facets["subs"] == []
        assert facets["manufacturers"] == [
            {"name": "Vishay", "count": 2},
            {"name": "Yageo", "count": 1},
        ]
        assert facets["total_unfiltered"] == 3, "scoped to the leaf, not the parent"

    def test_a_manufacturer_filter_does_not_shrink_the_manufacturer_facet(self, client, catalog):
        """Faceted-search semantics: each list is computed with every filter
        EXCEPT its own. Collapse this one and the control shows only the option
        already chosen, with no way back to the others."""
        facets = _facets(client, PARENT, "mfg=Yageo")
        assert facets["manufacturers"] == [
            {"name": "Vishay", "count": 2},
            {"name": "Yageo", "count": 2},
            {"name": "Murata", "count": 1},
        ]

    def test_a_manufacturer_filter_DOES_shrink_the_subcategory_facet(self, client, catalog):
        """The other half of the rule, and the half that fails if 'except its
        own' is implemented as 'no filters at all'."""
        facets = _facets(client, PARENT, "mfg=Yageo")
        assert facets["subs"] == [
            {"slug": CAPACITORS, "name": "Capacitors", "count": 1},
            {"slug": RESISTORS, "name": "Resistors", "count": 1},
        ]

    def test_a_sub_filter_does_not_shrink_the_sub_facet_but_shrinks_manufacturers(
        self, client, catalog
    ):
        facets = _facets(client, PARENT, f"sub={CAPACITORS}")
        assert facets["subs"] == [
            {"slug": RESISTORS, "name": "Resistors", "count": 3},
            {"slug": CAPACITORS, "name": "Capacitors", "count": 2},
        ]
        assert facets["manufacturers"] == [
            {"name": "Murata", "count": 1},
            {"name": "Yageo", "count": 1},
        ]

    def test_the_search_box_narrows_both_lists(self, client, catalog):
        """`q` is nobody's own filter, so it applies to every facet."""
        facets = _facets(client, PARENT, "q=capacitor")
        assert facets["manufacturers"] == [
            {"name": "Murata", "count": 1},
            {"name": "Yageo", "count": 1},
        ]
        assert facets["subs"] == [{"slug": CAPACITORS, "name": "Capacitors", "count": 2}]
        assert facets["total_unfiltered"] == 5, "unfiltered means unfiltered"


# ── Paging ──────────────────────────────────────────────────────────────────


class TestPaging:
    def test_pages_and_totals(self, client, catalog):
        parts = _parts(client, PARENT, "sort=sku&parts_per_page=2&parts_page=2")
        assert [p["sku"] for p in parts["items"]] == ["RES-100", "RES-200"]
        assert (parts["page"], parts["pages"], parts["total"], parts["per_page"]) == (2, 3, 5, 2)

    def test_a_filtered_page_count_follows_the_filter(self, client, catalog):
        parts = _parts(client, PARENT, "q=resistor&parts_per_page=2")
        assert parts["total"] == 3
        assert parts["pages"] == 2, "pages count the FILTERED rows"

    def test_the_ceiling_is_100(self, client, catalog):
        # 500 was the fetch-everything page size every call site sent — the
        # route still ACCEPTS up to it and the service CLAMPS to 100, so a tab
        # running the pre-deploy bundle keeps working instead of 422ing on
        # every category navigation (see test_category_size_tripwire).
        assert _parts(client, PARENT, "parts_per_page=500")["per_page"] == 100
        assert _parts(client, PARENT, "parts_per_page=101")["per_page"] == 100
        assert _parts(client, PARENT, "parts_per_page=100")["per_page"] == 100
        # Past the legacy ceiling the route still refuses loudly.
        assert client.get(f"/api/categories/{PARENT}?parts_per_page=501").status_code == 422


# ── Rejections ──────────────────────────────────────────────────────────────


class TestUnknownSort:
    def test_a_typo_is_422(self, client, catalog):
        response = client.get(f"/api/categories/{PARENT}?sort=price")
        assert response.status_code == 422
        assert response.json() == {"detail": "unknown_sort"}

    @pytest.mark.parametrize("token", ["popular", "sub"])
    def test_rollup_sorts_are_422_on_a_leaf(self, client, catalog, token):
        """A leaf has nothing to roll up. Answering with a silent fallback
        would leave the page's sort control claiming a state the server never
        entered."""
        response = client.get(f"/api/categories/{RESISTORS}?sort={token}")
        assert response.status_code == 422
        assert response.json() == {"detail": "unknown_sort"}
        # ...and both are perfectly valid one level up.
        assert client.get(f"/api/categories/{PARENT}?sort={token}").status_code == 200

    def test_an_unknown_direction_is_its_own_422(self, client, catalog):
        response = client.get(f"/api/categories/{PARENT}?sort=sku&dir=sideways")
        assert response.status_code == 422
        assert response.json() == {"detail": "unknown_dir"}

    def test_an_unknown_slug_is_still_a_404(self, client, catalog):
        """Whatever else the query string says. The category has to resolve
        before a sort can be judged against it — 'popular' is legal on a parent
        and illegal on a leaf, and a slug that names neither is a 404."""
        assert client.get("/api/categories/nope?sort=popular").status_code == 404
        assert client.get("/api/categories/nope?sort=bogus").status_code == 404


class TestChildCountsAreStamped:
    """children[].parts_count on THIS endpoint — the chip/SubcatSheet numbers.

    Only get_all_categories stamped these before 2026-08-27; the detail
    response served the schema default 0 for every child, which was invisible
    while the page derived counts from 500 loaded rows and became a missing
    badge on every leaf page once counts went server-side (leaf facet sub
    lists are empty by design — a leaf has no sub filter).
    """

    def test_a_parent_page_carries_its_childrens_counts(self, client, catalog):
        body = _body(client, PARENT)
        counts = {c["slug"]: c["parts_count"] for c in body["children"]}
        assert counts == {RESISTORS: 3, CAPACITORS: 2}

    def test_a_leaf_page_carries_its_siblings_counts(self, client, catalog):
        body = _body(client, RESISTORS)
        siblings = {c["slug"]: c["parts_count"] for c in body["parent"]["children"]}
        assert siblings == {RESISTORS: 3, CAPACITORS: 2}
