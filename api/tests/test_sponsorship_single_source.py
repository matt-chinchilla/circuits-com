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
