"""Tests for /api/categories endpoints."""


def test_list_categories(client, seeded_db):
    """GET /api/categories returns list with parent category (children are nested)."""
    response = client.get("/api/categories/")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    # Only top-level (parent) categories should be returned
    assert len(data) == 1
    parent = data[0]
    assert parent["name"] == "Integrated Circuits"
    assert parent["slug"] == "integrated-circuits"
    # Children are nested inside parent, not at the top level
    assert "children" in parent
    assert len(parent["children"]) == 1
    assert parent["children"][0]["slug"] == "clock-and-timing"


def test_list_categories_includes_featured_supplier_name(client, seeded_db):
    """Powers the admin Categories tree's ★ Featured Supplier banner.
    conftest gives Kennedy Electronics a Gold sponsor on clock-and-timing (the
    `sponsors` table is the source as of 2026-06-03 — not CategorySupplier).
    The parent (integrated-circuits) has no sponsor of its own → surfaces null.
    """
    response = client.get("/api/categories/")
    data = response.json()
    parent = data[0]
    # No featured CategorySupplier rows on the parent — must be explicitly null
    # (not absent — the frontend keys off the property)
    assert "featured_supplier_name" in parent
    assert parent["featured_supplier_name"] is None
    # Child has is_featured=True for Kennedy Electronics
    child = parent["children"][0]
    assert child["featured_supplier_name"] == "Kennedy Electronics"


def test_get_category_by_slug(client, seeded_db):
    """GET /api/categories/clock-and-timing returns detail with sponsor (banner
    moved to /partners as of 2026-06-04 — `suppliers` is gone from this payload)."""
    response = client.get("/api/categories/clock-and-timing")
    assert response.status_code == 200
    data = response.json()
    assert data["slug"] == "clock-and-timing"
    assert data["name"] == "Clock and Timing"

    # `suppliers` no longer exists on the detail payload — the banner is a
    # top-level artifact served by /api/categories/{slug}/partners.
    assert "suppliers" not in data

    # SponsorBlock's single sponsor (Kennedy Gold on this child) stays.
    assert data["sponsor"] is not None
    assert data["sponsor"]["supplier_name"] == "Kennedy Electronics"
    assert data["sponsor"]["tier"] == "gold"
    assert data["sponsor"]["image_url"] == "/test.jpg"


def test_parent_category_does_not_roll_up_child_sponsor(client, seeded_db):
    """The Platinum board shows a TOP-LEVEL category's OWN Platinum sponsor —
    never a child's Gold sponsor rolled up. conftest sponsors Kennedy (Gold) on
    the CHILD only and nothing on the parent, so the parent's /partners platinum
    is null, and the child's /partners (resolving to the parent) is null too."""
    parent = client.get("/api/categories/integrated-circuits/partners")
    assert parent.status_code == 200
    assert parent.json()["platinum"] is None, "no child→parent rollup onto the board"

    # Child resolves to the parent for the board → also null (no own Platinum).
    child = client.get("/api/categories/clock-and-timing/partners")
    assert child.status_code == 200
    assert child.json()["slug"] == "integrated-circuits"
    assert child.json()["platinum"] is None


def test_get_category_includes_parts(client, seeded_db):
    """GET /api/categories/clock-and-timing returns parts for that category."""
    response = client.get("/api/categories/clock-and-timing")
    assert response.status_code == 200
    data = response.json()

    assert "parts" in data
    parts_page = data["parts"]
    assert parts_page["total"] == 2
    assert parts_page["page"] == 1
    assert parts_page["pages"] == 1
    part_skus = {p["sku"] for p in parts_page["items"]}
    assert "LM7805CT" in part_skus
    assert "STM32F407VGT6" in part_skus

    lm7805 = [p for p in parts_page["items"] if p["sku"] == "LM7805CT"][0]
    assert lm7805["manufacturer_name"] == "Texas Instruments"
    assert lm7805["lifecycle_status"] == "active"
    assert lm7805["listings_count"] == 2
    assert lm7805["best_price"] is not None


def test_get_category_parent_has_no_parts(client, seeded_db):
    """GET /api/categories/integrated-circuits returns empty parts for parent (parts are on child)."""
    response = client.get("/api/categories/integrated-circuits")
    assert response.status_code == 200
    data = response.json()

    assert "parts" in data
    assert data["parts"]["items"] == []
    assert data["parts"]["total"] == 0


def test_get_category_not_found(client, seeded_db):
    """GET /api/categories/nonexistent returns 404."""
    response = client.get("/api/categories/nonexistent")
    assert response.status_code == 404


def test_category_icon_column_holds_phosphor_name_length():
    """Regression guard for alembic 005: Category.icon column must be ≥24 chars.

    The original String(10) column silently truncated Phosphor names like
    'arrows-counter-clockwise' (24 chars) in Postgres. SQLite (used by the
    test suite) ignores VARCHAR length constraints — so an end-to-end
    round-trip test wouldn't catch a future shrink. We assert on the
    column's declared metadata length directly, which is dialect-agnostic
    and pins the schema regardless of DB engine.
    """
    from app.models.category import Category

    longest_real_name = "arrows-counter-clockwise"  # 24 chars
    declared_length = Category.__table__.c.icon.type.length
    assert declared_length is not None, "Category.icon must declare an explicit length"
    assert declared_length >= len(longest_real_name), (
        f"Category.icon column is String({declared_length}), needs ≥{len(longest_real_name)} "
        f"to hold the longest real Phosphor name {longest_real_name!r}. "
        "Postgres would silently truncate. Update the model + add an alembic widen."
    )


def test_seed_category_slugs_match_canonical_data_js():
    """Regression: seed slugs match the canonical website data.js taxonomy.

    Slugify(name) would produce 'motor-motion-control-ics' and
    'security-authentication-ics' — but the website expects the shorter
    'motor-motion-ics' / 'security-auth-ics'. Subcategory slugs also
    diverge from slugify (e.g. 'ldo-regulators' not 'voltage-regulators-ldos',
    '8bit-mcus' not '8-bit-microcontrollers'). The seed must use the
    explicit per-row slug from CATEGORY_DATA, not auto-slugify(name).
    """
    from app.db.seed import CATEGORY_DATA

    # Build {top_slug: {sub_slug, ...}} map for assertions
    top_slugs: dict[str, set[str]] = {}
    for _name, slug, _icon, subs in CATEGORY_DATA:
        top_slugs[slug] = {sub_slug for _sn, sub_slug, _si in subs}

    # Top-level overrides that don't match auto-slugify
    assert "motor-motion-ics" in top_slugs, "Motor & Motion top-level must use canonical slug"
    assert "security-auth-ics" in top_slugs, "Security & Auth top-level must use canonical slug"
    assert "motor-motion-control-ics" not in top_slugs, "Old auto-slugify slug must not exist"
    assert "security-authentication-ics" not in top_slugs, "Old auto-slugify slug must not exist"

    # Selected subcategory overrides
    pmic_subs = top_slugs["power-management-ics-pmics"]
    assert "ldo-regulators" in pmic_subs
    assert "dc-dc-converters" in pmic_subs
    assert "battery-management" in pmic_subs
    assert "voltage-regulators-ldos" not in pmic_subs, "Old auto-slugify sub must not exist"

    mcu_subs = top_slugs["microcontrollers-processors"]
    assert "8bit-mcus" in mcu_subs
    assert "32bit-mcus" in mcu_subs
    assert "8-bit-microcontrollers" not in mcu_subs

    sensor_subs = top_slugs["sensor-ics"]
    assert "pressure-sensors" in sensor_subs
    assert "accelerometers" in sensor_subs
    assert "proximity-light" in sensor_subs

    # Sanity: every category has exactly 5 subs (matches data.js)
    for slug, subs in top_slugs.items():
        assert len(subs) == 5, f"Category {slug!r} has {len(subs)} subs, expected 5"

    # Sanity: 15 top-level categories total
    assert len(top_slugs) == 15, f"Expected 15 top-level categories, got {len(top_slugs)}"
