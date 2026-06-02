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

Behavioral contract this file locks in:

  - ``tier == 'Featured'`` + ``category_id`` set:
      * does NOT supersede other sponsors for that category.
      * upserts a ``CategorySupplier`` row with ``is_featured=True`` and
        an auto-assigned rank (max(rank)+1 across the category) so the
        new sponsor surfaces on the banner immediately.

  - ``tier`` in {Silver, Gold, Platinum} + ``category_id`` set: 422
    ("Category placement requires Featured tier"). Category sponsorship
    is the Featured tier's promise; lower tiers must use keyword
    placement.

  - PATCH semantics mirror POST: changing tier to/from Featured triggers
    the same side-effects.

  - ``tier == 'Featured'`` + ``keyword`` set: still 422 — Featured is
    category-only by design (matches the admin form's new "grey-out"
    constraint).

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


# ── Bug 1: auto-feature side-effect when tier == Featured ───────────────────


def test_featured_sponsor_post_creates_category_supplier_row(client, seeded_db, db):
    """POST tier=Featured + category_id → upserts CategorySupplier(is_featured=True).

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


def test_featured_sponsor_post_upserts_existing_category_supplier(client, seeded_db, db):
    """Existing CategorySupplier with is_featured=False is FLIPPED to True.

    Mirrors the ``feature`` endpoint behavior: an unfeatured association
    that becomes a Featured sponsor should flip, not duplicate.
    """
    headers = _auth_header(client)
    supplier = seeded_db["supplier1"]
    child = seeded_db["child"]  # conftest links supplier1 to child as is_featured=False

    pre = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == child.id,
            CategorySupplier.supplier_id == supplier.id,
        )
        .first()
    )
    assert pre is not None and pre.is_featured is False

    resp = _post_sponsor(
        client,
        headers,
        supplier_id=str(supplier.id),
        category_id=str(child.id),
    )
    assert resp.status_code == 200, resp.text

    after = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == child.id,
            CategorySupplier.supplier_id == supplier.id,
        )
        .all()
    )
    assert len(after) == 1, "Must upsert, not duplicate"
    assert after[0].is_featured is True


def test_featured_sponsor_auto_rank_is_unique_and_increments(client, seeded_db, db):
    """Two distinct Featured sponsors on the same category get distinct ranks.

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


# ── Bug 2: do NOT supersede peers when new sponsor is Featured ───────────────


def test_featured_sponsor_post_does_not_supersede_peers(client, seeded_db, db):
    """Adding a second Featured sponsor leaves the first one Active.

    This is the literal Kennedy/Matt's reproduction: pre-fix, the second
    POST set Kennedy.status = 'Expired' because ``_supersede_existing_for_category``
    ran unconditionally. Featured = multi-sponsor-per-category tier, so
    peers must coexist.
    """
    headers = _auth_header(client)
    cat = seeded_db["parent"]
    sup1 = seeded_db["supplier1"]
    sup2 = seeded_db["supplier2"]

    # First Featured sponsor.
    r1 = _post_sponsor(client, headers, supplier_id=str(sup1.id), category_id=str(cat.id))
    first_id = r1.json()["id"]

    # Second Featured sponsor on the SAME category.
    _post_sponsor(client, headers, supplier_id=str(sup2.id), category_id=str(cat.id))

    # The first one MUST still be Active — no supersede.
    first = db.query(Sponsor).filter(Sponsor.id == uuid.UUID(first_id)).first()
    assert first is not None
    assert first.status == "Active", (
        f"Featured sponsor was wrongly superseded: status={first.status!r}"
    )


# ── Bug 3 / new constraint: Category placement is Featured-only ──────────────


def test_category_placement_requires_featured_tier(client, seeded_db):
    """Silver / Gold / Platinum + category_id → 422.

    Mirrors the new admin form constraint ("grey out Category unless
    tier is Featured"). Server-side guard so a hand-crafted POST can't
    bypass the UI.
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
            f"tier={bad_tier!r}+category should 422 (got {resp.status_code}: {resp.text})"
        )


def test_featured_tier_with_keyword_still_422(client, seeded_db):
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


# ── PATCH semantics mirror POST ─────────────────────────────────────────────


def test_patch_to_featured_tier_creates_category_supplier(client, seeded_db, db):
    """PATCH tier from Gold→Featured AND attaching a category should
    auto-feature the supplier (same side-effect as POST)."""
    headers = _auth_header(client)
    sup = seeded_db["supplier1"]
    cat = seeded_db["parent"]

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

    # PATCH: switch to Featured + category placement.
    resp = client.patch(
        f"/api/admin/sponsors/{sponsor_id}",
        json={
            "tier": "Featured",
            "category_id": str(cat.id),
            "keyword": None,
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    row = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == cat.id,
            CategorySupplier.supplier_id == sup.id,
        )
        .first()
    )
    assert row is not None and row.is_featured is True
