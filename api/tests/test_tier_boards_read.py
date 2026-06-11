"""Read seams for the sponsor tier boards (2026-06-11).

Two existing endpoints are reshaped:
- ``GET /api/categories/{top}/partners`` → single visible **Platinum** sponsor as
  ``platinum: SponsorResponse | None`` (was a `partners` supplier list).
- ``GET /api/categories/{child}`` → ``sponsor`` = this child's newest visible
  **Gold**; ``silver`` = this child's visible **Silver** suppliers.

Uses the opt-in ``tier_boards`` fixture (parent2/child2 + platinum + 2 silver),
so the exact-count assertions over the base ``seeded_db`` fixture stay green.
"""


def _auth(client):
    token = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


# --- /partners → single platinum ------------------------------------------


def test_partners_returns_single_platinum(client, tier_boards):
    parent2 = tier_boards["parent2"]
    r = client.get(f"/api/categories/{parent2.slug}/partners")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["slug"] == parent2.slug
    assert body["name"] == parent2.name
    assert "partners" not in body
    plat = body["platinum"]
    assert plat is not None
    # Platinum company = supplier1 (Avnet) per the fixture.
    assert plat["supplier_name"] == "Avnet"
    assert plat["tier"].lower() == "platinum"


def test_partners_platinum_carries_board_fields(client, tier_boards):
    parent2 = tier_boards["parent2"]
    plat = client.get(f"/api/categories/{parent2.slug}/partners").json()["platinum"]
    # Every SponsorResponse field present (joined off the supplier).
    for key in (
        "id",
        "supplier_name",
        "image_url",
        "description",
        "tier",
        "website",
        "phone",
        "email",
        "contact_name",
        "logo_url",
        "contact_role",
        "coverage_hours",
        "brand_primary",
        "brand_secondary",
    ):
        assert key in plat, f"platinum missing {key}"
    # Supplier-sourced fields resolve (conftest sets these on supplier1).
    assert plat["website"] == "avnet.com"
    assert plat["contact_role"] is not None
    assert plat["coverage_hours"] is not None
    assert plat["brand_primary"] is not None


def test_partners_child_resolves_to_parent_platinum(client, tier_boards):
    parent2, child2 = tier_boards["parent2"], tier_boards["child2"]
    body = client.get(f"/api/categories/{child2.slug}/partners").json()
    # A child slug resolves to the top-level identity + its Platinum board.
    assert body["slug"] == parent2.slug
    assert body["platinum"] is not None
    assert body["platinum"]["supplier_name"] == "Avnet"


def test_partners_none_when_no_platinum(client, seeded_db):
    # `parent` (integrated-circuits) has no Platinum sponsor in the base fixture.
    parent = seeded_db["parent"]
    body = client.get(f"/api/categories/{parent.slug}/partners").json()
    assert body["platinum"] is None


# --- /{slug} → gold sponsor + silver list ----------------------------------


def test_detail_silver_lists_child_silver_suppliers(client, tier_boards):
    child2 = tier_boards["child2"]
    body = client.get(f"/api/categories/{child2.slug}").json()
    silver = body["silver"]
    assert isinstance(silver, list)
    names = {s["name"] for s in silver}
    # Both Silver sponsors coexist (multi-occupant directory).
    assert names == {"Avnet", "Kennedy Electronics"}, names
    # Silver suppliers carry the board contact_role field.
    assert all("contact_role" in s for s in silver)


def test_detail_silver_empty_when_no_silver(client, tier_boards):
    # parent2 (top-level) has a Platinum sponsor but no Silver → silver == [].
    parent2 = tier_boards["parent2"]
    body = client.get(f"/api/categories/{parent2.slug}").json()
    assert body["silver"] == []


def test_detail_sponsor_is_gold_only(client, seeded_db):
    """`sponsor` is now GOLD-filtered. The seeded child's Kennedy sponsor is Gold
    → it surfaces. A Silver sponsor on the same child must NOT surface as the
    Gold `sponsor` slot."""
    headers = _auth(client)
    child, avnet = seeded_db["child"], seeded_db["supplier1"]
    # Add a NEWER Silver sponsor on the same child. Newest overall, but Silver →
    # not the Gold slot. The older Gold (Kennedy) must still be `sponsor`.
    r = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(avnet.id),
            "category_id": str(child.id),
            "tier": "Silver",
            "status": "Active",
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    sponsor = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert sponsor is not None
    assert sponsor["supplier_name"] == "Kennedy Electronics"
    assert sponsor["tier"].lower() == "gold"


def test_detail_sponsor_none_when_only_silver(client, tier_boards):
    # child2 has only Silver sponsors → the Gold `sponsor` slot is empty.
    child2 = tier_boards["child2"]
    body = client.get(f"/api/categories/{child2.slug}").json()
    assert body["sponsor"] is None
