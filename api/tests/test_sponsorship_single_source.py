"""Single-source-of-truth sponsorship model (2026-06-11 tier-boards matrix).

The `sponsors` table is the ONLY source for the category page's sponsor boards
(CategorySupplier.is_featured was dropped). DB uniqueness + the tier↔placement
rule keep it ACID-consistent:
  - one sponsorship per (company, category) and per (company, keyword);
  - Platinum ⟺ top-level category (single-slot, BLOCK peers),
    Gold ⟺ child (single-slot, BLOCK peers) or Silver ⟺ child (directory, many),
    keyword ⟺ Silver/Gold (many).

Single-slot (Platinum-top / Gold-child) is BLOCK, not supersede (2026-06-22): a
second active sponsor for an occupied slot is rejected 409 — the incumbent keeps
it. Re-selling a slot means expiring/removing the current sponsor first.

Uniqueness is enforced by model UniqueConstraints (so it holds on SQLite too);
tier↔placement by the app validator here (the Postgres trigger is the DB-level
backstop, skipped under SQLite like the XOR CheckConstraint).
"""


def _auth(client):
    token = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _post(client, headers, **body):
    return client.post("/api/admin/sponsors/", json=body, headers=headers)


# --- Uniqueness: no duplicate placements (no "Kennedy twice") --------------


def test_duplicate_category_sponsorship_rejected(client, seeded_db):
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]  # top-level → Platinum
    r1 = _post(
        client,
        headers,
        supplier_id=str(sup.id),
        category_id=str(parent.id),
        tier="Platinum",
        status="Active",
    )
    assert r1.status_code == 200, r1.text
    r2 = _post(
        client,
        headers,
        supplier_id=str(sup.id),
        category_id=str(parent.id),
        tier="Platinum",
        status="Active",
    )
    assert r2.status_code == 409, r2.text


def test_duplicate_keyword_sponsorship_rejected(client, seeded_db):
    headers = _auth(client)
    sup = seeded_db["supplier1"]
    r1 = _post(
        client,
        headers,
        supplier_id=str(sup.id),
        keyword="capacitors",
        tier="Silver",
        status="Active",
    )
    assert r1.status_code == 200, r1.text
    r2 = _post(
        client, headers, supplier_id=str(sup.id), keyword="capacitors", tier="Gold", status="Active"
    )
    assert r2.status_code == 409, r2.text


def test_company_may_hold_many_keyword_sponsorships(client, seeded_db):
    """∞ keyword sponsorships per company (distinct keywords) — NULL category_id
    is SQL-distinct, so the (supplier, category) unique never blocks them."""
    headers = _auth(client)
    sup = seeded_db["supplier1"]
    for kw in ("resistors", "capacitors", "inductors", "diodes"):
        r = _post(
            client, headers, supplier_id=str(sup.id), keyword=kw, tier="Silver", status="Active"
        )
        assert r.status_code == 200, f"{kw}: {r.text}"


def test_company_may_sponsor_many_categories(client, seeded_db):
    """A company sponsors many DIFFERENT categories (one each). Free the child's
    single Gold slot first (the seeded Kennedy holds it) so the same company can
    take it — the single-slot block is per-category, not per-company."""
    headers = _auth(client)
    sup, parent, child = seeded_db["supplier1"], seeded_db["parent"], seeded_db["child"]
    client.delete(f"/api/admin/sponsors/{seeded_db['sponsor'].id}", headers=headers)
    assert (
        _post(
            client,
            headers,
            supplier_id=str(sup.id),
            category_id=str(parent.id),
            tier="Platinum",
            status="Active",
        ).status_code
        == 200
    )
    assert (
        _post(
            client,
            headers,
            supplier_id=str(sup.id),
            category_id=str(child.id),
            tier="Gold",
            status="Active",
        ).status_code
        == 200
    )


# --- Tier ↔ placement matrix (422) -----------------------------------------


def test_featured_rejected_on_child(client, seeded_db):
    headers = _auth(client)
    r = _post(
        client,
        headers,
        supplier_id=str(seeded_db["supplier1"].id),
        category_id=str(seeded_db["child"].id),
        tier="Featured",
        status="Active",
    )
    assert r.status_code == 422


def test_featured_rejected_on_keyword(client, seeded_db):
    headers = _auth(client)
    r = _post(
        client,
        headers,
        supplier_id=str(seeded_db["supplier1"].id),
        keyword="memory",
        tier="Featured",
        status="Active",
    )
    assert r.status_code == 422


def test_top_level_requires_platinum(client, seeded_db):
    headers = _auth(client)
    r = _post(
        client,
        headers,
        supplier_id=str(seeded_db["supplier1"].id),
        category_id=str(seeded_db["parent"].id),
        tier="Gold",
        status="Active",
    )
    assert r.status_code == 422


def test_subcategory_accepts_silver(client, seeded_db):
    """Silver is now a valid child tier (the directory) — was keyword-only."""
    headers = _auth(client)
    r = _post(
        client,
        headers,
        supplier_id=str(seeded_db["supplier1"].id),
        category_id=str(seeded_db["child"].id),
        tier="Silver",
        status="Active",
    )
    assert r.status_code == 200, r.text


def test_subcategory_accepts_gold(client, seeded_db):
    """Gold is a valid child tier. Free the child's single Gold slot first (the
    seeded Kennedy holds it) so this asserts tier-acceptance, not occupancy."""
    headers = _auth(client)
    client.delete(f"/api/admin/sponsors/{seeded_db['sponsor'].id}", headers=headers)
    r = _post(
        client,
        headers,
        supplier_id=str(seeded_db["supplier1"].id),
        category_id=str(seeded_db["child"].id),
        tier="Gold",
        status="Active",
    )
    assert r.status_code == 200, r.text


def test_keyword_accepts_silver_gold(client, seeded_db):
    headers = _auth(client)
    for tier, kw in (("Silver", "kw-a"), ("Gold", "kw-b")):
        r = _post(
            client,
            headers,
            supplier_id=str(seeded_db["supplier1"].id),
            keyword=kw,
            tier=tier,
            status="Active",
        )
        assert r.status_code == 200, f"{tier}: {r.text}"


def test_keyword_rejects_platinum(client, seeded_db):
    """Platinum is top-level-category-only now — rejected on a keyword."""
    headers = _auth(client)
    r = _post(
        client,
        headers,
        supplier_id=str(seeded_db["supplier1"].id),
        keyword="kw-platinum",
        tier="Platinum",
        status="Active",
    )
    assert r.status_code == 422


# --- Banner = sponsors (1:1; delete removes) -------------------------------


def test_banner_reflects_sponsor_create_then_delete(client, seeded_db):
    """A Platinum sponsor on a top-level category shows in that category's
    suppliers (banner); deleting it removes it. The banner reads the `sponsors`
    table directly, so there is no drift vs /admin/sponsors — and the
    2026-06-02 "deleted sponsor still shows" bug is now structurally impossible.
    """
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]  # Avnet, integrated-circuits

    def banner_name():
        # The Platinum board is single-slot — `platinum` is one sponsor | null.
        plat = client.get(f"/api/categories/{parent.slug}/partners").json()["platinum"]
        return plat["supplier_name"] if plat else None

    assert banner_name() != "Avnet"  # not a sponsor yet

    r = _post(
        client,
        headers,
        supplier_id=str(sup.id),
        category_id=str(parent.id),
        tier="Platinum",
        status="Active",
    )
    assert r.status_code == 200, r.text
    assert banner_name() == "Avnet"

    d = client.delete(f"/api/admin/sponsors/{r.json()['id']}", headers=headers)
    assert d.status_code == 204
    assert banner_name() != "Avnet"


# --- PATCH re-validates the matrix + uniqueness ----------------------------
# The POST guards above are re-asserted on the mutation path: an update must
# not be able to drive a row into a state create would have rejected. The PATCH
# handler re-validates against the POST-UPDATE state (admin_sponsors.py); these
# lock that in so a future refactor of update_sponsor can't silently drop it.


def test_patch_tier_to_invalid_for_placement_rejected(client, seeded_db):
    """PATCH-ing a top-level Platinum sponsor down to Gold breaks the matrix
    (top-level requires Platinum) → 422. Exercises the tier-only PATCH branch."""
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]
    created = _post(
        client,
        headers,
        supplier_id=str(sup.id),
        category_id=str(parent.id),
        tier="Platinum",
        status="Active",
    )
    assert created.status_code == 200, created.text
    r = client.patch(
        f"/api/admin/sponsors/{created.json()['id']}", json={"tier": "Gold"}, headers=headers
    )
    assert r.status_code == 422, r.text


def test_patch_category_to_top_level_without_platinum_rejected(client, seeded_db):
    """Re-targeting the seeded Gold child sponsor onto a top-level category
    (tier stays Gold) breaks the matrix → 422. Validation must precede the
    single-slot block check, so the prior slot is left untouched."""
    headers = _auth(client)
    sid, parent = str(seeded_db["sponsor"].id), seeded_db["parent"]
    r = client.patch(
        f"/api/admin/sponsors/{sid}", json={"category_id": str(parent.id)}, headers=headers
    )
    assert r.status_code == 422, r.text


def test_patch_collision_returns_409(client, seeded_db):
    """A PATCH that re-points a sponsor onto a (company, keyword) the company
    already holds hits UNIQUE(supplier_id, keyword) → 409. The PATCH
    IntegrityError handler is separate from the POST one — cover it directly."""
    headers = _auth(client)
    sup = seeded_db["supplier1"]
    a = _post(
        client, headers, supplier_id=str(sup.id), keyword="alpha", tier="Silver", status="Active"
    )
    b = _post(
        client, headers, supplier_id=str(sup.id), keyword="beta", tier="Silver", status="Active"
    )
    assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)
    r = client.patch(
        f"/api/admin/sponsors/{a.json()['id']}", json={"keyword": "beta"}, headers=headers
    )
    assert r.status_code == 409, r.text


def test_patch_to_xor_violation_rejected(client, seeded_db):
    """Adding a keyword to a category sponsor (without clearing category_id)
    sets BOTH → XOR violation → 422 on the PATCH path."""
    headers = _auth(client)
    sid = str(seeded_db["sponsor"].id)  # seeded = category sponsor (child)
    r = client.patch(f"/api/admin/sponsors/{sid}", json={"keyword": "oops"}, headers=headers)
    assert r.status_code == 422, r.text


# --- Single-slot BLOCK: incumbent keeps the slot (2026-06-22) ---------------
# Single-occupant tiers (Platinum on a top-level category, Gold on a child) now
# REJECT a second active sponsor with 409 — the incumbent (oldest/existing) keeps
# the slot (was: supersede, where the newest auto-expired the prior one). To
# re-sell a slot the admin expires/removes the current sponsor first.


def test_second_gold_on_child_blocked_incumbent_kept(client, seeded_db):
    """The child Gold slot is SINGLE-occupant: a 2nd Gold sponsor on a child that
    already has one (seeded Kennedy, NULL status = active) is REJECTED 409, and
    the incumbent keeps the SponsorBlock slot. NULL-as-active is the trap this
    guards — a naive `status != 'Expired'` would skip the legacy row and wrongly
    allow the second."""
    headers = _auth(client)
    avnet, child = seeded_db["supplier1"], seeded_db["child"]
    # Kennedy (supplier2) already sponsors `child` (Gold, status NULL) via fixture.
    r = _post(
        client,
        headers,
        supplier_id=str(avnet.id),
        category_id=str(child.id),
        tier="Gold",
        status="Active",
    )
    assert r.status_code == 409, r.text
    sponsor = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert sponsor is not None and sponsor["supplier_name"] == "Kennedy Electronics", sponsor


def test_second_platinum_top_level_blocked_incumbent_kept(client, seeded_db):
    """Platinum is a SINGLE-slot Category Sponsor board: a 2nd Platinum company on
    the SAME top-level category is REJECTED 409 — the first/incumbent keeps the
    board (was: superseded by the newest). The `/partners` board keeps carrying
    the incumbent as `platinum`."""
    headers = _auth(client)
    a, b, parent = seeded_db["supplier1"], seeded_db["supplier2"], seeded_db["parent"]
    assert (
        _post(
            client,
            headers,
            supplier_id=str(a.id),
            category_id=str(parent.id),
            tier="Platinum",
            status="Active",
        ).status_code
        == 200
    )
    r2 = _post(
        client,
        headers,
        supplier_id=str(b.id),
        category_id=str(parent.id),
        tier="Platinum",
        status="Active",
    )
    assert r2.status_code == 409, r2.text
    plat = client.get(f"/api/categories/{parent.slug}/partners").json()["platinum"]
    assert plat is not None and plat["supplier_name"] == "Avnet", plat
    # Exactly one active sponsor remains on the category — the incumbent (a).
    active = [
        s
        for s in client.get("/api/admin/sponsors/", headers=headers).json()
        if s["category_id"] == str(parent.id) and s["status"] != "Expired"
    ]
    assert len(active) == 1 and active[0]["supplier_id"] == str(a.id), active


def test_silver_directory_allows_many_on_child(client, seeded_db, db):
    """Silver is the multi-occupant subcategory DIRECTORY — the single-slot block
    must NOT apply: several Silver sponsors coexist on one child."""
    import uuid as _uuid

    from app.models import Supplier

    headers = _auth(client)
    child = seeded_db["child"]
    extras = [
        Supplier(id=_uuid.uuid4(), name="Mouser", website="mouser.com", email="x@mouser.com"),
        Supplier(id=_uuid.uuid4(), name="DigiKey", website="digikey.com", email="x@digikey.com"),
    ]
    db.add_all(extras)
    db.commit()
    for s in extras:
        r = _post(
            client,
            headers,
            supplier_id=str(s.id),
            category_id=str(child.id),
            tier="Silver",
            status="Active",
        )
        assert r.status_code == 200, r.text


def test_patch_into_occupied_platinum_slot_blocked(client, seeded_db):
    """PATCH that retargets a sponsor onto a top-level category that already has an
    active Platinum is REJECTED 409 (the incumbent keeps the slot) — the block runs
    on the mutation path too, excluding self."""
    headers = _auth(client)
    avnet, parent = seeded_db["supplier1"], seeded_db["parent"]
    # Avnet takes the parent's Platinum slot.
    assert (
        _post(
            client,
            headers,
            supplier_id=str(avnet.id),
            category_id=str(parent.id),
            tier="Platinum",
            status="Active",
        ).status_code
        == 200
    )
    # Retarget Kennedy's seeded child-Gold sponsor onto the occupied parent as Platinum → 409.
    sid = str(seeded_db["sponsor"].id)
    r = client.patch(
        f"/api/admin/sponsors/{sid}",
        json={"category_id": str(parent.id), "tier": "Platinum"},
        headers=headers,
    )
    assert r.status_code == 409, r.text


def test_expire_incumbent_then_resell_allowed(client, seeded_db):
    """Re-sell flow: once the incumbent single-slot sponsor is Expired, the slot
    frees up and a new sponsor can take it (200)."""
    headers = _auth(client)
    avnet, child = seeded_db["supplier1"], seeded_db["child"]
    sid = str(seeded_db["sponsor"].id)  # Kennedy Gold on child (incumbent)
    # Adding a 2nd Gold is blocked while the incumbent is active.
    blocked = _post(
        client,
        headers,
        supplier_id=str(avnet.id),
        category_id=str(child.id),
        tier="Gold",
        status="Active",
    )
    assert blocked.status_code == 409, blocked.text
    # Expire the incumbent (status-only PATCH — no block re-check), freeing the slot.
    e = client.patch(f"/api/admin/sponsors/{sid}", json={"status": "Expired"}, headers=headers)
    assert e.status_code == 200, e.text
    # Now the new Gold sponsor is accepted.
    r = _post(
        client,
        headers,
        supplier_id=str(avnet.id),
        category_id=str(child.id),
        tier="Gold",
        status="Active",
    )
    assert r.status_code == 200, r.text
    sponsor = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert sponsor is not None and sponsor["supplier_name"] == "Avnet", sponsor


def test_reactivating_expired_into_occupied_slot_blocked(client, seeded_db):
    """A status-only PATCH that re-activates an Expired single-slot sponsor into a
    now-occupied slot is BLOCKED (409). The block must run on status→active too —
    not just category/tier changes — else reactivation dodges it and TWO active
    sponsors land on one slot (the gap a status-only PATCH would otherwise slip
    through)."""
    headers = _auth(client)
    avnet, child = seeded_db["supplier1"], seeded_db["child"]
    incumbent = str(seeded_db["sponsor"].id)  # Kennedy Gold on child (active / NULL status)
    # Expire the incumbent → the child's Gold slot is free.
    assert (
        client.patch(
            f"/api/admin/sponsors/{incumbent}", json={"status": "Expired"}, headers=headers
        ).status_code
        == 200
    )
    # A new Gold sponsor takes the freed slot.
    new = _post(
        client, headers, supplier_id=str(avnet.id), category_id=str(child.id), tier="Gold", status="Active"
    )
    assert new.status_code == 200, new.text
    # Re-activating the old incumbent now would make TWO active Golds on the child → 409.
    r = client.patch(f"/api/admin/sponsors/{incumbent}", json={"status": "Active"}, headers=headers)
    assert r.status_code == 409, r.text


# --- Read-side visibility: NULL = Active, Expired hidden -------------------


def test_legacy_null_status_sponsor_visible(client, seeded_db):
    """The seeded Kennedy sponsor has NULL status (legacy). It must still surface
    as the child's SponsorBlock sponsor — NULL is treated as Active."""
    child = seeded_db["child"]
    sponsor = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert sponsor is not None and sponsor["supplier_name"] == "Kennedy Electronics"


def test_expired_sponsor_hidden_from_banner(client, seeded_db):
    """An Expired sponsor is excluded from the banner by the read-side visible
    filter, even though it's a valid row."""
    headers = _auth(client)
    avnet, parent = seeded_db["supplier1"], seeded_db["parent"]
    r = _post(
        client,
        headers,
        supplier_id=str(avnet.id),
        category_id=str(parent.id),
        tier="Platinum",
        status="Expired",
    )
    assert r.status_code == 200, r.text
    plat = client.get(f"/api/categories/{parent.slug}/partners").json()["platinum"]
    assert plat is None or plat["supplier_name"] != "Avnet"


def test_subcategory_rejects_platinum(client, seeded_db):
    """Matrix completeness: a child no longer accepts Platinum (top-level-only
    now) — Gold and Silver are the child tiers."""
    headers = _auth(client)
    r = _post(
        client,
        headers,
        supplier_id=str(seeded_db["supplier1"].id),
        category_id=str(seeded_db["child"].id),
        tier="Platinum",
        status="Active",
    )
    assert r.status_code == 422, r.text
