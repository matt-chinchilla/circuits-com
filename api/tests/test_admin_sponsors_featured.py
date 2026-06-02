"""Tier-aware supersede + auto-feature side-effect on admin sponsor writes.

Background — 2026-06-02 bug report:
  User added "Matt's Test Company" to PMICs as tier='Featured' via the
  admin sponsor form. Expectation: the supplier appears on the public
  PreferredPartnersBanner. Reality: banner unchanged (still only
  Kennedy Electronics), AND Kennedy's existing PMIC sponsor was
  auto-marked Expired by ``_supersede_existing_for_category``.

  Two root causes:

    1. Admin sponsor POST writes only to ``sponsors``. The banner reads
       ``category_suppliers.is_featured`` (PreferredPartnersBanner v15).
       The two tables had no link, so a Featured sponsor was invisible
       to the banner.

    2. ``_supersede_existing_for_category`` fired on EVERY new sponsor
       for a given category, regardless of tier. The product model
       changed in v15: the banner now shows MULTIPLE Featured partners
       per category, so superseding peers makes the banner go down to
       one row instead of growing.

Updated rule (2026-06-02 softening): Featured is the ONLY tier allowed
on top-level (parent_id IS NULL) categories. Silver/Gold/Platinum may
attach to CHILD categories (the "Subcategory Sponsor" slot — single
sponsor per child, supersede peers) or to a keyword (multi-sponsor per
keyword, no supersede). Featured + child category → 422; non-Featured +
top-level category → 422.

Behavioral contract this file locks in:

  - ``tier == 'Featured'`` + top-level ``category_id`` set:
      * does NOT supersede other sponsors for that category.
      * upserts a ``CategorySupplier`` row with ``is_featured=True`` and
        an auto-assigned rank (max(rank)+1 across the category) so the
        new sponsor surfaces on the banner immediately.

  - ``tier == 'Featured'`` + child ``category_id`` set: 422.
  - ``tier == 'Featured'`` + ``keyword`` set: 422.

  - ``tier`` in {Silver, Gold, Platinum} + top-level ``category_id``: 422.
  - ``tier`` in {Silver, Gold, Platinum} + child ``category_id``: 200,
    supersede peers on that child (single Subcategory Sponsor slot);
    do NOT upsert CategorySupplier.
  - ``tier`` in {Silver, Gold, Platinum} + ``keyword``: 200, no supersede.

  - PATCH semantics mirror POST: re-resolve post-update tier+category_id
    and re-validate.

Tier comparison is case-insensitive throughout — admin emits TitleCase
(``'Featured'``), legacy seed rows emit lowercase (``'gold'``); per
CLAUDE.md gotcha the wire format isn't normalized today.
"""

import uuid

from app.models import CategorySupplier, Sponsor


def _auth_header(client):
    resp = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "testpass123"},
    )
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _post_sponsor(client, headers, **kw):
    """Helper: POST /api/admin/sponsors/ with sensible defaults."""
    payload = {
        "tier": "Featured",
        "amount": "1000.00",
        "status": "Active",
        **kw,
    }
    return client.post("/api/admin/sponsors/", json=payload, headers=headers)


# ── Featured + top-level category: auto-feature + no supersede ──────────────


def test_featured_top_level_creates_category_supplier_row(client, seeded_db, db):
    """POST tier=Featured + top-level category_id → upserts CategorySupplier(is_featured=True).

    Drives the banner: PreferredPartnersBanner reads
    ``category.suppliers`` filtered to ``is_featured=True``, so a new
    Featured sponsor MUST land on the join table or the banner stays
    stale (the 2026-06-02 reproduction).
    """
    headers = _auth_header(client)
    supplier = seeded_db["supplier1"]
    category = seeded_db["parent"]

    # Verify pre-state: no existing CategorySupplier row for this pair.
    pre = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == category.id,
            CategorySupplier.supplier_id == supplier.id,
        )
        .first()
    )
    assert pre is None

    resp = _post_sponsor(
        client,
        headers,
        supplier_id=str(supplier.id),
        category_id=str(category.id),
    )
    assert resp.status_code == 200, resp.text

    row = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == category.id,
            CategorySupplier.supplier_id == supplier.id,
        )
        .first()
    )
    assert row is not None, "Featured sponsor MUST create a CategorySupplier row"
    assert row.is_featured is True
    assert row.rank >= 1


def test_featured_top_level_upserts_existing_category_supplier(client, seeded_db, db):
    """Existing CategorySupplier with is_featured=False is FLIPPED to True.

    Mirrors the ``feature`` endpoint behavior: an unfeatured association
    that becomes a Featured sponsor should flip, not duplicate. Uses
    parent (top-level) category to satisfy the new rule.
    """
    headers = _auth_header(client)
    supplier = seeded_db["supplier1"]
    parent = seeded_db["parent"]

    # Pre-state: seed only links suppliers to the child, not parent. Add a
    # parent-level association with is_featured=False so we can observe the flip.
    db.add(
        CategorySupplier(
            category_id=parent.id,
            supplier_id=supplier.id,
            is_featured=False,
            rank=1,
        )
    )
    db.commit()

    pre = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == parent.id,
            CategorySupplier.supplier_id == supplier.id,
        )
        .first()
    )
    assert pre is not None and pre.is_featured is False

    resp = _post_sponsor(
        client,
        headers,
        supplier_id=str(supplier.id),
        category_id=str(parent.id),
    )
    assert resp.status_code == 200, resp.text

    after = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == parent.id,
            CategorySupplier.supplier_id == supplier.id,
        )
        .all()
    )
    assert len(after) == 1, "Must upsert, not duplicate"
    assert after[0].is_featured is True


def test_featured_auto_rank_is_unique_and_increments(client, seeded_db, db):
    """Two distinct Featured sponsors on the same top-level category get distinct ranks.

    Banner ORDER BY rank asc renders the lower-rank row first; collisions
    on rank would make the banner pick a deterministic-but-arbitrary
    winner. Verify the auto-assigner reserves a fresh slot per insert.
    """
    headers = _auth_header(client)
    cat = seeded_db["parent"]
    sup1 = seeded_db["supplier1"]
    sup2 = seeded_db["supplier2"]

    _post_sponsor(client, headers, supplier_id=str(sup1.id), category_id=str(cat.id))
    _post_sponsor(client, headers, supplier_id=str(sup2.id), category_id=str(cat.id))

    ranks = sorted(
        cs.rank
        for cs in db.query(CategorySupplier)
        .filter(CategorySupplier.category_id == cat.id)
        .all()
    )
    assert len(ranks) == 2
    assert len(set(ranks)) == 2, f"Expected unique ranks, got {ranks}"


def test_featured_top_level_does_not_supersede_peers(client, seeded_db, db):
    """Adding a second Featured sponsor on the same top-level cat leaves the first Active.

    The literal Kennedy/Matt's reproduction: pre-fix, the second
    POST set Kennedy.status = 'Expired' because
    ``_supersede_existing_for_category`` ran unconditionally. Featured =
    multi-sponsor-per-category tier, so peers must coexist.
    """
    headers = _auth_header(client)
    cat = seeded_db["parent"]
    sup1 = seeded_db["supplier1"]
    sup2 = seeded_db["supplier2"]

    r1 = _post_sponsor(client, headers, supplier_id=str(sup1.id), category_id=str(cat.id))
    first_id = r1.json()["id"]

    _post_sponsor(client, headers, supplier_id=str(sup2.id), category_id=str(cat.id))

    first = db.query(Sponsor).filter(Sponsor.id == uuid.UUID(first_id)).first()
    assert first is not None
    assert first.status == "Active", (
        f"Featured sponsor was wrongly superseded: status={first.status!r}"
    )


# ── New constraint: Featured rejects child / keyword ────────────────────────


def test_featured_rejects_child_category(client, seeded_db):
    """Featured + child (non-top-level) category → 422.

    Featured tier is reserved for top-level category sponsorship
    (PreferredPartnersBanner). Subcategory sponsorship is a separate
    product surface served by lower tiers.
    """
    headers = _auth_header(client)
    sup = seeded_db["supplier1"]
    child = seeded_db["child"]

    resp = _post_sponsor(
        client,
        headers,
        supplier_id=str(sup.id),
        category_id=str(child.id),
    )
    assert resp.status_code == 422, resp.text


def test_featured_rejects_keyword(client, seeded_db):
    """Featured + keyword → 422. Featured is category-only by design."""
    headers = _auth_header(client)
    sup = seeded_db["supplier1"]

    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup.id),
            "keyword": "ldo",
            "tier": "Featured",
            "amount": "500.00",
            "status": "Active",
        },
        headers=headers,
    )
    assert resp.status_code == 422


# ── New constraint: top-level requires Featured ─────────────────────────────


def test_top_level_placement_requires_featured_tier(client, seeded_db):
    """Silver / Gold / Platinum + top-level category_id → 422.

    Mirrors the admin form constraint: top-level category placement is
    the Featured tier's promise. Lower tiers must use child-category
    (Subcategory Sponsor) or keyword placement.
    """
    headers = _auth_header(client)
    sup = seeded_db["supplier1"]
    cat = seeded_db["parent"]

    for bad_tier in ("Silver", "Gold", "Platinum", "silver", "gold", "platinum"):
        resp = client.post(
            "/api/admin/sponsors/",
            json={
                "supplier_id": str(sup.id),
                "category_id": str(cat.id),
                "tier": bad_tier,
                "amount": "500.00",
                "status": "Active",
            },
            headers=headers,
        )
        assert resp.status_code == 422, (
            f"tier={bad_tier!r}+top-level should 422 (got {resp.status_code}: {resp.text})"
        )


# ── New constraint: non-Featured + child = Subcategory Sponsor (allowed) ────


def test_subcategory_placement_allowed_for_non_featured_tier(client, seeded_db):
    """Silver / Gold / Platinum + child category_id → 200 for each."""
    headers = _auth_header(client)
    sup = seeded_db["supplier1"]
    child = seeded_db["child"]

    for good_tier in ("Silver", "Gold", "Platinum", "silver", "gold", "platinum"):
        resp = client.post(
            "/api/admin/sponsors/",
            json={
                "supplier_id": str(sup.id),
                "category_id": str(child.id),
                "tier": good_tier,
                "amount": "500.00",
                "status": "Active",
            },
            headers=headers,
        )
        assert resp.status_code == 200, (
            f"tier={good_tier!r}+child should 200 (got {resp.status_code}: {resp.text})"
        )


def test_subcategory_placement_supersedes_peers(client, seeded_db, db):
    """Two Gold sponsors on the same child → first becomes Expired.

    Single Subcategory Sponsor slot per child category, so a new
    non-Featured sponsor evicts the previous occupant.
    """
    headers = _auth_header(client)
    child = seeded_db["child"]
    sup1 = seeded_db["supplier1"]
    sup2 = seeded_db["supplier2"]

    r1 = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup1.id),
            "category_id": str(child.id),
            "tier": "Gold",
            "amount": "300.00",
            "status": "Active",
        },
        headers=headers,
    )
    assert r1.status_code == 200, r1.text
    first_id = r1.json()["id"]

    r2 = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup2.id),
            "category_id": str(child.id),
            "tier": "Gold",
            "amount": "400.00",
            "status": "Active",
        },
        headers=headers,
    )
    assert r2.status_code == 200, r2.text

    db.expire_all()
    first = db.query(Sponsor).filter(Sponsor.id == uuid.UUID(first_id)).first()
    assert first is not None
    assert first.status == "Expired", (
        f"Expected first Subcategory Sponsor superseded, got status={first.status!r}"
    )


def test_subcategory_placement_does_not_upsert_category_supplier(client, seeded_db, db):
    """Gold + child → CategorySupplier row NOT created or flipped.

    Subcategory sponsorship is a sponsor-row concept; it MUST NOT bleed
    into the CategorySupplier featured-partner directory.
    """
    headers = _auth_header(client)
    child = seeded_db["child"]
    sup1 = seeded_db["supplier1"]

    # Pre-state from seed: supplier1 IS joined to child with is_featured=False.
    pre = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == child.id,
            CategorySupplier.supplier_id == sup1.id,
        )
        .first()
    )
    assert pre is not None
    assert pre.is_featured is False

    resp = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup1.id),
            "category_id": str(child.id),
            "tier": "Gold",
            "amount": "300.00",
            "status": "Active",
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    db.expire_all()
    after = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == child.id,
            CategorySupplier.supplier_id == sup1.id,
        )
        .first()
    )
    assert after is not None
    assert after.is_featured is False, (
        "Non-Featured sponsor must NOT flip is_featured on the join row"
    )


def test_keyword_placement_does_not_supersede_peers(client, seeded_db, db):
    """Two Gold sponsors on the same keyword → both stay Active.

    Keyword placement is multi-sponsor (sponsor pages enumerate all
    Active sponsors for the keyword), so no supersede.
    """
    headers = _auth_header(client)
    sup1 = seeded_db["supplier1"]
    sup2 = seeded_db["supplier2"]

    r1 = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup1.id),
            "keyword": "voltage-regulator",
            "tier": "Gold",
            "amount": "200.00",
            "status": "Active",
        },
        headers=headers,
    )
    assert r1.status_code == 200, r1.text
    first_id = r1.json()["id"]

    r2 = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup2.id),
            "keyword": "voltage-regulator",
            "tier": "Gold",
            "amount": "200.00",
            "status": "Active",
        },
        headers=headers,
    )
    assert r2.status_code == 200, r2.text

    db.expire_all()
    first = db.query(Sponsor).filter(Sponsor.id == uuid.UUID(first_id)).first()
    assert first is not None
    assert first.status == "Active", (
        f"Keyword peer was wrongly superseded: status={first.status!r}"
    )


# ── PATCH semantics mirror POST ─────────────────────────────────────────────


def test_patch_to_featured_top_level_creates_category_supplier(client, seeded_db, db):
    """PATCH tier from Gold→Featured AND attaching a top-level category
    should auto-feature the supplier (same side-effect as POST)."""
    headers = _auth_header(client)
    sup = seeded_db["supplier1"]
    parent = seeded_db["parent"]

    # Start with a keyword sponsor at a non-Featured tier.
    r1 = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup.id),
            "keyword": "ldo",
            "tier": "Gold",
            "amount": "200.00",
            "status": "Active",
        },
        headers=headers,
    )
    sponsor_id = r1.json()["id"]

    # PATCH: switch to Featured + top-level category placement.
    resp = client.patch(
        f"/api/admin/sponsors/{sponsor_id}",
        json={
            "tier": "Featured",
            "category_id": str(parent.id),
            "keyword": None,
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    row = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == parent.id,
            CategorySupplier.supplier_id == sup.id,
        )
        .first()
    )
    assert row is not None and row.is_featured is True


def test_patch_to_subcategory_supersedes_peer_on_target(client, seeded_db, db):
    """PATCH that retargets a Gold sponsor to a new child category should
    supersede any existing visible sponsor on the NEW child."""
    headers = _auth_header(client)
    sup1 = seeded_db["supplier1"]
    sup2 = seeded_db["supplier2"]
    child = seeded_db["child"]

    # Seed an existing Gold sponsor on the target child.
    r_existing = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup1.id),
            "category_id": str(child.id),
            "tier": "Gold",
            "amount": "300.00",
            "status": "Active",
        },
        headers=headers,
    )
    assert r_existing.status_code == 200, r_existing.text
    existing_id = r_existing.json()["id"]

    # A second sponsor with a different placement (keyword) — will be re-targeted.
    r_to_move = client.post(
        "/api/admin/sponsors/",
        json={
            "supplier_id": str(sup2.id),
            "keyword": "smps",
            "tier": "Gold",
            "amount": "300.00",
            "status": "Active",
        },
        headers=headers,
    )
    assert r_to_move.status_code == 200, r_to_move.text
    to_move_id = r_to_move.json()["id"]

    # PATCH the second sponsor onto the same child → should expire the first.
    resp = client.patch(
        f"/api/admin/sponsors/{to_move_id}",
        json={
            "category_id": str(child.id),
            "keyword": None,
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    db.expire_all()
    existing = db.query(Sponsor).filter(Sponsor.id == uuid.UUID(existing_id)).first()
    assert existing is not None
    assert existing.status == "Expired", (
        f"Peer on target child should have been superseded, got {existing.status!r}"
    )
