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


class TestCategoryResponseExposesSiblings:
    """Bug 1B fix: subcategory response includes parent.children for chip nav."""

    def test_subcategory_response_includes_sibling_list(self, client, db):
        """GET /api/categories/<sub-slug> returns parent.children (siblings).

        Without this, the frontend SubcategoryChips component has no way to
        render sibling nav when the user lands on a subcategory page directly.
        """
        # Parent with 3 subcategories
        parent = Category(
            id=uuid.uuid4(), name="Power Mgmt", slug="power-mgmt",
            icon="⚡", sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub_a = Category(
            id=uuid.uuid4(), name="LDOs", slug="ldos",
            icon="🔋", parent_id=parent.id, sort_order=0,
        )
        sub_b = Category(
            id=uuid.uuid4(), name="DC-DC", slug="dc-dc",
            icon="🔌", parent_id=parent.id, sort_order=1,
        )
        sub_c = Category(
            id=uuid.uuid4(), name="BMS", slug="bms",
            icon="🔋", parent_id=parent.id, sort_order=2,
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
            id=uuid.uuid4(), name="Power Mgmt", slug="power-mgmt",
            icon="⚡", sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub = Category(
            id=uuid.uuid4(), name="BMS", slug="bms",
            icon="🔋", parent_id=parent.id, sort_order=0,
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
            id=uuid.uuid4(), name="Standalone", slug="standalone",
            icon="🔧", sort_order=0,
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
            id=uuid.uuid4(), name="Power Mgmt", slug="power-mgmt-2",
            icon="⚡", sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub = Category(
            id=uuid.uuid4(), name="LDOs", slug="ldos-2",
            icon="🔋", parent_id=parent.id, sort_order=0,
        )
        db.add(sub)
        db.flush()
        # Two parts, both on the subcategory (not parent)
        for sku, mfg in [("LM7805CT", "TI"), ("LT3045", "ADI")]:
            db.add(Part(
                id=uuid.uuid4(),
                sku=sku,
                manufacturer_name=mfg,
                category_id=sub.id,
                lifecycle_status="active",
            ))
        db.commit()

        # Subcategory endpoint surfaces both parts
        resp = client.get("/api/categories/ldos-2")
        assert resp.status_code == 200
        data = resp.json()
        skus = {p["sku"] for p in data["parts"]}
        assert skus == {"LM7805CT", "LT3045"}, (
            f"Subcategory endpoint missing parts; got {skus}"
        )

        # Parent endpoint: should NOT duplicate the subcat's parts
        # (parts are scoped to their owning category, not rolled up here —
        # the `parts` list at the parent reflects parts directly on the parent)
        resp = client.get("/api/categories/power-mgmt-2")
        assert resp.status_code == 200
        data = resp.json()
        parent_skus = {p["sku"] for p in data["parts"]}
        assert parent_skus == set(), (
            f"Parent endpoint shouldn't show subcat parts in `parts` list; got {parent_skus}"
        )


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
        assert "BQ24195" in bms_skus, (
            f"BQ24195 should be on BMS subcategory; BMS has: {bms_skus}"
        )

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
    """Parent category pages need a flat 'Popular Parts' rollup spanning all
    subcategories, ranked by aggregate stock (proxy for popularity until
    click-count metrics land). Without rollup, the parent page renders an
    empty parts section because every part now lives on a subcategory.
    """

    def _make_supplier(self, db):
        sup = Supplier(id=uuid.uuid4(), name=f"Sup-{uuid.uuid4().hex[:6]}")
        db.add(sup)
        db.flush()
        return sup

    def _make_part(self, db, *, sku, cat, stocks):
        """Create a Part on the given category with one listing per entry in `stocks`."""
        sup = self._make_supplier(db)
        part = Part(
            id=uuid.uuid4(),
            sku=sku,
            manufacturer_name="TI",
            category_id=cat.id,
            lifecycle_status="active",
        )
        db.add(part)
        db.flush()
        for stock in stocks:
            db.add(PartListing(
                id=uuid.uuid4(),
                part_id=part.id,
                supplier_id=sup.id,
                stock_quantity=stock,
                unit_price=Decimal("1.00"),
            ))
        db.flush()
        return part

    def test_parent_category_returns_popular_parts_across_children(self, client, db):
        """The parent endpoint surfaces parts from ALL its subcategories,
        sorted by total stock across listings (highest first).
        """
        parent = Category(
            id=uuid.uuid4(), name="Power Mgmt", slug="power-mgmt-3",
            icon="⚡", sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub_ldo = Category(
            id=uuid.uuid4(), name="LDOs", slug="ldos-3",
            icon="🔋", parent_id=parent.id, sort_order=0,
        )
        sub_bms = Category(
            id=uuid.uuid4(), name="BMS", slug="bms-3",
            icon="🔋", parent_id=parent.id, sort_order=1,
        )
        db.add_all([sub_ldo, sub_bms])
        db.flush()

        # Stock spread so we can verify the ORDER BY: LM7805 has highest total
        # (5000+3000=8000), BQ24195 second (4500), LT3045 third (2000).
        self._make_part(db, sku="LM7805CT", cat=sub_ldo, stocks=[5000, 3000])
        self._make_part(db, sku="LT3045", cat=sub_ldo, stocks=[2000])
        self._make_part(db, sku="BQ24195", cat=sub_bms, stocks=[4500])
        db.commit()

        resp = client.get("/api/categories/power-mgmt-3")
        assert resp.status_code == 200
        data = resp.json()

        assert "popular_parts" in data, (
            "Parent endpoint must expose popular_parts rollup for the "
            "Popular Parts section on the parent page"
        )
        popular = data["popular_parts"]
        # Pagination meta is part of the contract — frontend renders
        # Google-style numbered controls based on these fields.
        assert "items" in popular and "total" in popular and "page" in popular
        skus_ordered = [p["sku"] for p in popular["items"]]
        assert skus_ordered == ["LM7805CT", "BQ24195", "LT3045"], (
            f"Popular parts should be sorted by total stock DESC; got {skus_ordered}"
        )
        assert popular["total"] == 3
        assert popular["page"] == 1
        assert popular["pages"] == 1

    def test_popular_parts_pagination(self, client, db):
        """page/per_page query params slice the rollup correctly."""
        parent = Category(
            id=uuid.uuid4(), name="P", slug="p-pag", icon="⚡", sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub = Category(
            id=uuid.uuid4(), name="S", slug="s-pag", icon="🔋",
            parent_id=parent.id, sort_order=0,
        )
        db.add(sub)
        db.flush()
        # 5 parts so per_page=2 → 3 pages
        for i in range(5):
            self._make_part(db, sku=f"PART{i}", cat=sub, stocks=[1000 - i * 100])
        db.commit()

        resp = client.get("/api/categories/p-pag?popular_per_page=2&popular_page=2")
        assert resp.status_code == 200
        popular = resp.json()["popular_parts"]
        assert popular["total"] == 5
        assert popular["per_page"] == 2
        assert popular["page"] == 2
        assert popular["pages"] == 3
        # Items 3-4 (zero-indexed) on page 2 with per_page=2 = parts 2 & 3 in stock-order
        assert len(popular["items"]) == 2

    def test_leaf_category_popular_parts_empty(self, client, db):
        """popular_parts is only populated for parent categories; on a leaf
        page the existing `parts` field is the source of truth."""
        parent = Category(
            id=uuid.uuid4(), name="X", slug="x-3", icon="⚡", sort_order=0,
        )
        db.add(parent)
        db.flush()
        sub = Category(
            id=uuid.uuid4(), name="Y", slug="y-3", icon="🔋",
            parent_id=parent.id, sort_order=0,
        )
        db.add(sub)
        db.flush()
        self._make_part(db, sku="ABC", cat=sub, stocks=[100])
        db.commit()

        resp = client.get("/api/categories/y-3")
        assert resp.status_code == 200
        data = resp.json()
        # Leaf pages: popular_parts has the shape but empty items
        assert data["popular_parts"]["items"] == []
        assert data["popular_parts"]["total"] == 0
        # The existing `parts` field still works for leaves
        assert {p["sku"] for p in data["parts"]} == {"ABC"}
