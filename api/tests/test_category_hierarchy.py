"""Regression tests for the 2026-05-16 category/subcategory bug batch.

Two related bugs:

1. **Subcategory pages had no parts** — seed.py attached every part to the
   top-level (parent) category. Frontend `/category/<sub-slug>` querying
   `Part.category_id == <sub-id>` returned zero parts.
2. **Part response missed parent category** — `part_to_dict()` returned only
   one `category_name`, so the PartPage breadcrumb rendered "Home / SubCat / SKU"
   when the part lived on a subcategory, missing the parent link.

A third related need: the Category API needs to expose `parent.children`
(sibling subcategories) so the frontend can render intra-category chips
on subcategory pages with the current one marked active.

These tests pin all three behaviors so the bugs can't reintroduce.
"""

import uuid
from decimal import Decimal

from app.models import Category, Part, PartListing, Supplier
from app.services.part_pricing import refresh_best_prices


class TestCategoryResponseExposesSiblings:
    """Bug 1B fix: subcategory response includes parent.children for chip nav."""

    def test_subcategory_response_includes_sibling_list(self, client, db):
        """GET /api/categories/<sub-slug> returns parent.children (siblings).

        Without this, the frontend SubcategoryChips component has no way to
        render sibling nav when the user lands on a subcategory page directly.
        """
        # Parent with 3 subcategories
        parent = Category(
            id=uuid.uuid4(),
            name="Power Mgmt",
            slug="power-mgmt",
            icon="⚡",
            sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub_a = Category(
            id=uuid.uuid4(),
            name="LDOs",
            slug="ldos",
            icon="🔋",
            parent_id=parent.id,
            sort_order=0,
        )
        sub_b = Category(
            id=uuid.uuid4(),
            name="DC-DC",
            slug="dc-dc",
            icon="🔌",
            parent_id=parent.id,
            sort_order=1,
        )
        sub_c = Category(
            id=uuid.uuid4(),
            name="BMS",
            slug="bms",
            icon="🔋",
            parent_id=parent.id,
            sort_order=2,
        )
        db.add_all([sub_a, sub_b, sub_c])
        db.commit()

        resp = client.get("/api/categories/ldos")
        assert resp.status_code == 200
        data = resp.json()

        assert data["slug"] == "ldos"
        assert data["parent"] is not None
        assert data["parent"]["slug"] == "power-mgmt"

        # The fix: response must surface sibling list under parent.children
        assert "children" in data["parent"], (
            "parent.children missing from subcategory response — "
            "frontend cannot render sibling chips without this"
        )
        sibling_slugs = {c["slug"] for c in data["parent"]["children"]}
        assert sibling_slugs == {"ldos", "dc-dc", "bms"}, (
            f"Expected all 3 siblings, got: {sibling_slugs}"
        )


class TestPartResponseIncludesParentCategory:
    """Bug 2B fix: part_to_dict surfaces parent category for the breadcrumb."""

    def test_get_part_on_subcategory_returns_parent_info(self, client, db):
        """GET /api/parts/<id> returns parent_category_{name,slug} for subcategory parts.

        Without parent info, PartPage breadcrumb can only render
        "Home / SubCat / SKU" — missing the middle "Home / Parent / SubCat / SKU"
        that user requested.
        """
        parent = Category(
            id=uuid.uuid4(),
            name="Power Mgmt",
            slug="power-mgmt",
            icon="⚡",
            sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub = Category(
            id=uuid.uuid4(),
            name="BMS",
            slug="bms",
            icon="🔋",
            parent_id=parent.id,
            sort_order=0,
        )
        db.add(sub)
        db.flush()
        part = Part(
            id=uuid.uuid4(),
            sku="BQ24195",
            description="Battery charger IC",
            manufacturer_name="TI",
            category_id=sub.id,
            lifecycle_status="active",
        )
        db.add(part)
        db.commit()

        resp = client.get(f"/api/parts/{part.id}")
        assert resp.status_code == 200
        data = resp.json()

        # Existing behavior (preserved):
        assert data["category_name"] == "BMS"

        # New behavior the fix delivers:
        assert "category_slug" in data, "category_slug missing — breadcrumb link target needs it"
        assert data["category_slug"] == "bms"
        assert "parent_category_name" in data, (
            "parent_category_name missing — breadcrumb missing middle level"
        )
        assert data["parent_category_name"] == "Power Mgmt"
        assert "parent_category_slug" in data
        assert data["parent_category_slug"] == "power-mgmt"

    def test_get_part_on_toplevel_has_no_parent_fields(self, client, db):
        """Part on top-level category: parent_category_* fields are null.

        Edge case: not every part is on a subcategory. The breadcrumb still
        needs to render correctly for admin-created parts that live on the
        parent directly.
        """
        top = Category(
            id=uuid.uuid4(),
            name="Standalone",
            slug="standalone",
            icon="🔧",
            sort_order=0,
        )
        db.add(top)
        db.flush()
        part = Part(
            id=uuid.uuid4(),
            sku="X1",
            manufacturer_name="TI",
            category_id=top.id,
            lifecycle_status="active",
        )
        db.add(part)
        db.commit()

        resp = client.get(f"/api/parts/{part.id}")
        assert resp.status_code == 200
        data = resp.json()

        assert data["category_name"] == "Standalone"
        assert data["parent_category_name"] is None
        assert data["parent_category_slug"] is None


class TestSubcategoryGetsItsOwnParts:
    """Bug 2A: parts on a subcategory show up at that subcategory's slug.

    This is an end-to-end pin: the API logic already filters by category_id;
    the bug was in the data layer (seed attaching to top-level only).
    The test creates parts assigned to a subcategory and confirms the
    subcategory endpoint exposes them.
    """

    def test_subcategory_endpoint_returns_its_parts(self, client, db):
        parent = Category(
            id=uuid.uuid4(),
            name="Power Mgmt",
            slug="power-mgmt-2",
            icon="⚡",
            sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub = Category(
            id=uuid.uuid4(),
            name="LDOs",
            slug="ldos-2",
            icon="🔋",
            parent_id=parent.id,
            sort_order=0,
        )
        db.add(sub)
        db.flush()
        # Two parts, both on the subcategory (not parent)
        for sku, mfg in [("LM7805CT", "TI"), ("LT3045", "ADI")]:
            db.add(
                Part(
                    id=uuid.uuid4(),
                    sku=sku,
                    manufacturer_name=mfg,
                    category_id=sub.id,
                    lifecycle_status="active",
                )
            )
        db.commit()

        # Subcategory endpoint surfaces both parts
        resp = client.get("/api/categories/ldos-2")
        assert resp.status_code == 200
        data = resp.json()
        skus = {p["sku"] for p in data["parts"]["items"]}
        assert skus == {"LM7805CT", "LT3045"}, f"Subcategory endpoint missing parts; got {skus}"

        # Parent endpoint: the `parts` block IS the rollup now.
        #
        # DELIBERATE CONTRACT CHANGE (2026-08-27), the same one recorded on
        # test_categories.test_get_category_parent_rolls_up_child_parts — this
        # is that pin's twin, and it had to move with it. It used to assert the
        # parent's `parts` list was empty, because parts live on subcategories
        # and the page compensated by fetching the separate `popular_parts`
        # rollup at per_page=500 and paging it in the browser. That truncated
        # 27 of 28 top-level categories once the catalog passed 200k parts. The
        # block is scope-aware now: leaf = own parts, parent = self + children.
        resp = client.get("/api/categories/power-mgmt-2")
        assert resp.status_code == 200
        data = resp.json()
        parent_skus = {p["sku"] for p in data["parts"]["items"]}
        assert parent_skus == {"LM7805CT", "LT3045"}, (
            f"Parent endpoint should roll its subcats' parts up; got {parent_skus}"
        )
        assert data["parts"]["total"] == 2


class TestSeedAssignsPartsToSubcategories:
    """Bug 2A regression: confirm prod seed places parts on subcategories.

    After re-shaping `_PART_CATALOG`, parts must end up on specific
    subcategories — not on parent. Without this guard, a future refactor
    could silently revert to parent-only placement and break sub-pages.
    """

    def test_seed_attaches_parts_to_subcategories(self, db):
        from app.db.seed import seed

        seed(db)

        # Pick a known subcategory and assert it has parts directly attached.
        # Slug is canonical with ui_kits/website/data.js — see CATEGORY_DATA.
        bms = db.query(Category).filter(Category.slug == "battery-management").first()
        assert bms is not None, "Subcategory 'Battery Management ICs (BMS)' missing from seed"
        assert bms.parent_id is not None, "BMS should be a subcategory, not top-level"

        bms_parts = db.query(Part).filter(Part.category_id == bms.id).all()
        assert len(bms_parts) >= 1, (
            f"BMS subcategory has no parts (got {len(bms_parts)}). "
            "Seed must place battery-management parts on this subcategory, "
            "not on the parent PMICs category."
        )
        bms_skus = {p.sku for p in bms_parts}
        assert "BQ24195" in bms_skus, f"BQ24195 should be on BMS subcategory; BMS has: {bms_skus}"

    def test_seed_does_not_attach_parts_to_pmics_toplevel(self, db):
        """All PMIC-category parts go to subcategories, not the top-level."""
        from app.db.seed import seed

        seed(db)

        pmics = db.query(Category).filter(Category.slug == "power-management-ics-pmics").first()
        assert pmics is not None
        assert pmics.parent_id is None, "PMICs should be top-level"

        direct_parts = db.query(Part).filter(Part.category_id == pmics.id).all()
        assert len(direct_parts) == 0, (
            f"Top-level PMICs should have no direct parts (all go to subcats); "
            f"found {len(direct_parts)} parts: {[p.sku for p in direct_parts]}"
        )


class TestPopularPartsRollupOnParent:
    """Parent category pages serve a flat rollup spanning all subcategories,
    ranked by aggregate stock (proxy for popularity until click-count metrics
    land). Since 2026-08-27 that rollup IS the `parts` block (sort=popular);
    the separate `popular_parts` block is retired (2026-09-11) and empty.
    """

    def _make_supplier(self, db):
        sup = Supplier(id=uuid.uuid4(), name=f"Sup-{uuid.uuid4().hex[:6]}")
        db.add(sup)
        db.flush()
        return sup

    def _make_part(self, db, *, sku, cat, stocks):
        """Create a Part on the given category with one listing per entry in `stocks`."""
        part = Part(
            id=uuid.uuid4(),
            sku=sku,
            manufacturer_name="TI",
            category_id=cat.id,
            lifecycle_status="active",
        )
        db.add(part)
        db.flush()
        # One supplier PER listing: the rollup sums stock across DISTRIBUTORS,
        # and uq_part_listings_part_supplier now makes two rows for the same
        # (part, supplier) impossible — which is the point of the constraint,
        # so the fixture models real shape instead of the old duplicate.
        for stock in stocks:
            db.add(
                PartListing(
                    id=uuid.uuid4(),
                    part_id=part.id,
                    supplier_id=self._make_supplier(db).id,
                    stock_quantity=stock,
                    unit_price=Decimal("1.00"),
                )
            )
        db.flush()
        # Every real write path ends here; the popular ordering reads the
        # column this stamps, not the listings.
        refresh_best_prices(db, [part.id])
        return part

    def test_parent_page_orders_its_rollup_by_total_stock(self, client, db):
        """The parent endpoint's `parts` block spans ALL its subcategories,
        most-stocked first — `parts.total_stock` (migration 053), which
        `refresh_best_prices` keeps exact on every write path.
        """
        parent = Category(
            id=uuid.uuid4(),
            name="Power Mgmt",
            slug="power-mgmt-3",
            icon="⚡",
            sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub_ldo = Category(
            id=uuid.uuid4(),
            name="LDOs",
            slug="ldos-3",
            icon="🔋",
            parent_id=parent.id,
            sort_order=0,
        )
        sub_bms = Category(
            id=uuid.uuid4(),
            name="BMS",
            slug="bms-3",
            icon="🔋",
            parent_id=parent.id,
            sort_order=1,
        )
        db.add_all([sub_ldo, sub_bms])
        db.flush()

        self._make_part(db, sku="LM7805CT", cat=sub_ldo, stocks=[5000, 3000])
        self._make_part(db, sku="LT3045", cat=sub_ldo, stocks=[2000])
        self._make_part(db, sku="BQ24195", cat=sub_bms, stocks=[4500])
        db.commit()

        resp = client.get("/api/categories/power-mgmt-3")
        assert resp.status_code == 200
        data = resp.json()
        assert [p["sku"] for p in data["parts"]["items"]] == ["LM7805CT", "BQ24195", "LT3045"]
        assert data["parts"]["total"] == 3
        # The children's chips carry their own counts from the same GROUP BY.
        assert {c["slug"]: c["parts_count"] for c in data["children"]} == {"ldos-3": 2, "bms-3": 1}
        # RETIRED 2026-09-11: the legacy rollup is an empty block whatever the
        # page asks for — building it was 1.3s per request on the connectors
        # page and the client had ignored it since 2026-08-27.
        assert data["popular_parts"] == {
            "items": [],
            "total": 0,
            "page": 1,
            "pages": 1,
            "per_page": 20,
        }

    def test_the_rollup_pages_through_parts_page(self, client, db):
        """parts_page/parts_per_page slice the rollup in stock order."""
        parent = Category(
            id=uuid.uuid4(),
            name="P",
            slug="p-pag",
            icon="⚡",
            sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub = Category(
            id=uuid.uuid4(),
            name="S",
            slug="s-pag",
            icon="🔋",
            parent_id=parent.id,
            sort_order=0,
        )
        db.add(sub)
        db.flush()
        for i in range(5):
            self._make_part(db, sku=f"PART{i}", cat=sub, stocks=[1000 - i * 100])
        db.commit()

        resp = client.get("/api/categories/p-pag?parts_per_page=2&parts_page=2")
        assert resp.status_code == 200
        parts = resp.json()["parts"]
        assert parts["total"] == 5
        assert parts["per_page"] == 2
        assert parts["page"] == 2
        assert parts["pages"] == 3
        assert [p["sku"] for p in parts["items"]] == ["PART2", "PART3"]
        # The legacy params are accepted (a tab on the previous bundle sends
        # them) and change nothing but the echoed per_page.
        legacy = client.get("/api/categories/p-pag?popular_per_page=2&popular_page=2").json()
        assert legacy["popular_parts"]["items"] == []
        assert legacy["popular_parts"]["per_page"] == 2

    def test_a_leaf_serves_its_own_parts_and_the_same_empty_legacy_block(self, client, db):
        parent = Category(
            id=uuid.uuid4(),
            name="X",
            slug="x-3",
            icon="⚡",
            sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub = Category(
            id=uuid.uuid4(),
            name="Y",
            slug="y-3",
            icon="🔋",
            parent_id=parent.id,
            sort_order=0,
        )
        db.add(sub)
        db.flush()
        self._make_part(db, sku="ABC", cat=sub, stocks=[100])
        db.commit()

        resp = client.get("/api/categories/y-3")
        assert resp.status_code == 200
        data = resp.json()
        assert [p["sku"] for p in data["parts"]["items"]] == ["ABC"]
        assert data["popular_parts"]["items"] == []
        assert data["popular_parts"]["total"] == 0
        assert {p["sku"] for p in data["parts"]["items"]} == {"ABC"}
