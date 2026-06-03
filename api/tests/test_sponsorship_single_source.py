"""Single-source-of-truth sponsorship model (2026-06-03).

The `sponsors` table is the ONLY source for the category page's Preferred
Partners banner (CategorySupplier.is_featured was dropped). DB uniqueness + the
tier↔placement rule keep it ACID-consistent:
  - one sponsorship per (company, category) and per (company, keyword);
  - Featured ⟺ top-level category, Platinum/Gold ⟺ child, keyword ⟺
    Silver/Gold/Platinum.

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
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]  # top-level → Featured
    r1 = _post(client, headers, supplier_id=str(sup.id), category_id=str(parent.id),
               tier="Featured", status="Active")
    assert r1.status_code == 200, r1.text
    r2 = _post(client, headers, supplier_id=str(sup.id), category_id=str(parent.id),
               tier="Featured", status="Active")
    assert r2.status_code == 409, r2.text


def test_duplicate_keyword_sponsorship_rejected(client, seeded_db):
    headers = _auth(client)
    sup = seeded_db["supplier1"]
    r1 = _post(client, headers, supplier_id=str(sup.id), keyword="capacitors",
               tier="Silver", status="Active")
    assert r1.status_code == 200, r1.text
    r2 = _post(client, headers, supplier_id=str(sup.id), keyword="capacitors",
               tier="Gold", status="Active")
    assert r2.status_code == 409, r2.text


def test_company_may_hold_many_keyword_sponsorships(client, seeded_db):
    """∞ keyword sponsorships per company (distinct keywords) — NULL category_id
    is SQL-distinct, so the (supplier, category) unique never blocks them."""
    headers = _auth(client)
    sup = seeded_db["supplier1"]
    for kw in ("resistors", "capacitors", "inductors", "diodes"):
        r = _post(client, headers, supplier_id=str(sup.id), keyword=kw,
                  tier="Silver", status="Active")
        assert r.status_code == 200, f"{kw}: {r.text}"


def test_company_may_sponsor_many_categories(client, seeded_db):
    """A company sponsors many DIFFERENT categories (one each)."""
    headers = _auth(client)
    sup, parent, child = seeded_db["supplier1"], seeded_db["parent"], seeded_db["child"]
    assert _post(client, headers, supplier_id=str(sup.id), category_id=str(parent.id),
                 tier="Featured", status="Active").status_code == 200
    assert _post(client, headers, supplier_id=str(sup.id), category_id=str(child.id),
                 tier="Gold", status="Active").status_code == 200


# --- Tier ↔ placement matrix (422) -----------------------------------------

def test_featured_rejected_on_child(client, seeded_db):
    headers = _auth(client)
    r = _post(client, headers, supplier_id=str(seeded_db["supplier1"].id),
              category_id=str(seeded_db["child"].id), tier="Featured", status="Active")
    assert r.status_code == 422


def test_featured_rejected_on_keyword(client, seeded_db):
    headers = _auth(client)
    r = _post(client, headers, supplier_id=str(seeded_db["supplier1"].id),
              keyword="memory", tier="Featured", status="Active")
    assert r.status_code == 422


def test_top_level_requires_featured(client, seeded_db):
    headers = _auth(client)
    r = _post(client, headers, supplier_id=str(seeded_db["supplier1"].id),
              category_id=str(seeded_db["parent"].id), tier="Gold", status="Active")
    assert r.status_code == 422


def test_subcategory_rejects_silver(client, seeded_db):
    headers = _auth(client)
    r = _post(client, headers, supplier_id=str(seeded_db["supplier1"].id),
              category_id=str(seeded_db["child"].id), tier="Silver", status="Active")
    assert r.status_code == 422


def test_subcategory_accepts_gold(client, seeded_db):
    headers = _auth(client)
    r = _post(client, headers, supplier_id=str(seeded_db["supplier1"].id),
              category_id=str(seeded_db["child"].id), tier="Gold", status="Active")
    assert r.status_code == 200, r.text


def test_keyword_accepts_silver_gold_platinum(client, seeded_db):
    headers = _auth(client)
    for tier, kw in (("Silver", "kw-a"), ("Gold", "kw-b"), ("Platinum", "kw-c")):
        r = _post(client, headers, supplier_id=str(seeded_db["supplier1"].id),
                  keyword=kw, tier=tier, status="Active")
        assert r.status_code == 200, f"{tier}: {r.text}"


# --- Banner = sponsors (1:1; delete removes) -------------------------------

def test_banner_reflects_sponsor_create_then_delete(client, seeded_db):
    """A Featured sponsor on a top-level category shows in that category's
    suppliers (banner); deleting it removes it. The banner reads the `sponsors`
    table directly, so there is no drift vs /admin/sponsors — and the
    2026-06-02 "deleted sponsor still shows" bug is now structurally impossible.
    """
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]  # Avnet, integrated-circuits

    def banner_names():
        return {s["name"] for s in client.get(f"/api/categories/{parent.slug}").json()["suppliers"]}

    assert "Avnet" not in banner_names()  # not a sponsor yet

    r = _post(client, headers, supplier_id=str(sup.id), category_id=str(parent.id),
              tier="Featured", status="Active")
    assert r.status_code == 200, r.text
    assert "Avnet" in banner_names()

    d = client.delete(f"/api/admin/sponsors/{r.json()['id']}", headers=headers)
    assert d.status_code == 204
    assert "Avnet" not in banner_names()


# --- PATCH re-validates the matrix + uniqueness ----------------------------
# The POST guards above are re-asserted on the mutation path: an update must
# not be able to drive a row into a state create would have rejected. The PATCH
# handler re-validates against the POST-UPDATE state (admin_sponsors.py); these
# lock that in so a future refactor of update_sponsor can't silently drop it.

def test_patch_tier_to_invalid_for_placement_rejected(client, seeded_db):
    """PATCH-ing a top-level Featured sponsor down to Gold breaks the matrix
    (top-level requires Featured) → 422. Exercises the tier-only PATCH branch."""
    headers = _auth(client)
    sup, parent = seeded_db["supplier1"], seeded_db["parent"]
    created = _post(client, headers, supplier_id=str(sup.id), category_id=str(parent.id),
                    tier="Featured", status="Active")
    assert created.status_code == 200, created.text
    r = client.patch(f"/api/admin/sponsors/{created.json()['id']}",
                     json={"tier": "Gold"}, headers=headers)
    assert r.status_code == 422, r.text


def test_patch_category_to_top_level_without_featured_rejected(client, seeded_db):
    """Re-targeting the seeded Gold child sponsor onto a top-level category
    (tier stays Gold) breaks the matrix → 422. Validation must precede the
    supersede side-effect, so the prior slot is left untouched."""
    headers = _auth(client)
    sid, parent = str(seeded_db["sponsor"].id), seeded_db["parent"]
    r = client.patch(f"/api/admin/sponsors/{sid}",
                     json={"category_id": str(parent.id)}, headers=headers)
    assert r.status_code == 422, r.text


def test_patch_collision_returns_409(client, seeded_db):
    """A PATCH that re-points a sponsor onto a (company, keyword) the company
    already holds hits UNIQUE(supplier_id, keyword) → 409. The PATCH
    IntegrityError handler is separate from the POST one — cover it directly."""
    headers = _auth(client)
    sup = seeded_db["supplier1"]
    a = _post(client, headers, supplier_id=str(sup.id), keyword="alpha",
              tier="Silver", status="Active")
    b = _post(client, headers, supplier_id=str(sup.id), keyword="beta",
              tier="Silver", status="Active")
    assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)
    r = client.patch(f"/api/admin/sponsors/{a.json()['id']}",
                     json={"keyword": "beta"}, headers=headers)
    assert r.status_code == 409, r.text


def test_patch_to_xor_violation_rejected(client, seeded_db):
    """Adding a keyword to a category sponsor (without clearing category_id)
    sets BOTH → XOR violation → 422 on the PATCH path."""
    headers = _auth(client)
    sid = str(seeded_db["sponsor"].id)  # seeded = category sponsor (child)
    r = client.patch(f"/api/admin/sponsors/{sid}",
                     json={"keyword": "oops"}, headers=headers)
    assert r.status_code == 422, r.text


# --- Single-slot supersede (the Subcategory Sponsor) -----------------------

def test_new_child_sponsor_supersedes_prior(client, seeded_db):
    """The child Subcategory Sponsor is a SINGLE slot: a new Gold/Platinum
    sponsor on a child Expires the prior visible one. The seeded Kennedy sponsor
    has NULL status (legacy) — NULL counts as visible, so it too is superseded
    (guards the 'status != Expired skips NULL' SQL three-valued-logic trap), and
    the read-side then hides the now-Expired row."""
    headers = _auth(client)
    avnet, child = seeded_db["supplier1"], seeded_db["child"]
    # Kennedy (supplier2) already sponsors `child` (Gold, status NULL) via fixture.
    r = _post(client, headers, supplier_id=str(avnet.id), category_id=str(child.id),
              tier="Gold", status="Active")
    assert r.status_code == 200, r.text
    names = {s["name"] for s in client.get(f"/api/categories/{child.slug}").json()["suppliers"]}
    assert names == {"Avnet"}, names  # Kennedy superseded → no longer visible


def test_featured_top_level_sponsors_coexist(client, seeded_db):
    """Featured is the multi-row banner: two companies Featured on the SAME
    top-level category BOTH show (no supersede) — the contrast to the single
    child slot above."""
    headers = _auth(client)
    a, b, parent = seeded_db["supplier1"], seeded_db["supplier2"], seeded_db["parent"]
    assert _post(client, headers, supplier_id=str(a.id), category_id=str(parent.id),
                 tier="Featured", status="Active").status_code == 200
    assert _post(client, headers, supplier_id=str(b.id), category_id=str(parent.id),
                 tier="Featured", status="Active").status_code == 200
    names = {s["name"] for s in client.get(f"/api/categories/{parent.slug}").json()["suppliers"]}
    assert names == {"Avnet", "Kennedy Electronics"}, names


# --- Read-side visibility: NULL = Active, Expired hidden -------------------

def test_legacy_null_status_sponsor_visible(client, seeded_db):
    """The seeded Kennedy sponsor has NULL status (legacy seed omits it). It must
    still surface on the child banner — NULL is treated as Active."""
    child = seeded_db["child"]
    names = {s["name"] for s in client.get(f"/api/categories/{child.slug}").json()["suppliers"]}
    assert "Kennedy Electronics" in names


def test_expired_sponsor_hidden_from_banner(client, seeded_db):
    """An Expired sponsor is excluded from the banner by the read-side visible
    filter, even though it's a valid row."""
    headers = _auth(client)
    avnet, parent = seeded_db["supplier1"], seeded_db["parent"]
    r = _post(client, headers, supplier_id=str(avnet.id), category_id=str(parent.id),
              tier="Featured", status="Expired")
    assert r.status_code == 200, r.text
    names = {s["name"] for s in client.get(f"/api/categories/{parent.slug}").json()["suppliers"]}
    assert "Avnet" not in names


def test_subcategory_accepts_platinum(client, seeded_db):
    """Matrix completeness: a child accepts Platinum as well as Gold."""
    headers = _auth(client)
    r = _post(client, headers, supplier_id=str(seeded_db["supplier1"].id),
              category_id=str(seeded_db["child"].id), tier="Platinum", status="Active")
    assert r.status_code == 200, r.text
