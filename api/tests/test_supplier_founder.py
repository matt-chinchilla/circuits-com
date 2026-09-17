"""Migration 054 — `suppliers.founder`, the founding-distributor flag.

Owner ask 2026-09-17: a boolean that stays True for an early partner "until
the monthly-income we get from sponsors is over $5,000/month OR until I
decide", and that is False for every supplier in both databases today. No
automation of that sunset exists yet — these tests pin the column, its
default, its public round-trip and the one wall that protects it.

The column is NOT NULL, so the Python-side `default=False` is what keeps
`Base.metadata.create_all` (the SQLite suite) and every ORM insert legal
without naming the field.
"""

from datetime import UTC, datetime
from pathlib import Path

import bcrypt
from app.models import User
from app.models.supplier import Supplier

VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"


def _auth_header(client):
    resp = client.post(
        "/api/auth/login", json={"email": "admin@test.example", "password": "testpass123"}
    )
    return {"Authorization": f"Bearer {resp.json()['token']}"}


# ── (a) the column itself ───────────────────────────────────────────────────


def test_supplier_has_a_not_null_founder_column():
    col = Supplier.__table__.c.get("founder")
    assert col is not None, "Supplier.founder column missing"
    assert col.nullable is False, "founder must be NOT NULL — there is no 'unknown' here"


def test_founder_carries_both_defaults():
    """Both matter and they are not interchangeable: the server_default is the
    DDL that backfills every existing prod row to false, the Python default is
    what covers ORM inserts and the SQLite suite's create_all."""
    assert Supplier.__table__.c.founder.default.arg is False
    assert Supplier.__table__.c.founder.server_default is not None


def test_a_flushed_supplier_without_the_key_is_not_a_founder(db):
    row = Supplier(name="Unflagged Distribution")
    db.add(row)
    db.flush()
    assert row.founder is False


# ── (b) absent key → false, everywhere the row is read ──────────────────────


def test_create_without_founder_reads_back_false(client, seeded_db):
    headers = _auth_header(client)
    created = client.post("/api/suppliers/", json={"name": "No Flag Co"}, headers=headers).json()
    assert created["founder"] is False

    listed = {s["name"]: s for s in client.get("/api/suppliers/").json()}
    assert listed["No Flag Co"]["founder"] is False

    detail = client.get(f"/api/suppliers/{created['id']}").json()
    assert detail["founder"] is False


def test_founder_is_public_on_the_unauthenticated_list(client, seeded_db):
    """It is an incentive badge, not a secret — the key must survive the
    public read path (SupplierResponse is shared by public AND admin)."""
    from app.schemas.supplier import SupplierResponse

    assert "founder" in SupplierResponse.model_fields
    for row in client.get("/api/suppliers/").json():
        assert "founder" in row


# ── (c) the write round-trip ────────────────────────────────────────────────


def test_create_with_founder_true_round_trips(client, seeded_db):
    headers = _auth_header(client)
    created = client.post(
        "/api/suppliers/", json={"name": "Founding Partner Co", "founder": True}, headers=headers
    ).json()
    assert created["founder"] is True
    assert client.get(f"/api/suppliers/{created['id']}").json()["founder"] is True


def test_put_can_clear_the_flag(client, seeded_db):
    headers = _auth_header(client)
    created = client.post(
        "/api/suppliers/", json={"name": "Sunset Co", "founder": True}, headers=headers
    ).json()
    resp = client.put(f"/api/suppliers/{created['id']}", json={"founder": False}, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["founder"] is False


def test_put_without_the_key_leaves_the_flag_alone(client, seeded_db):
    """update_supplier dumps with exclude_unset — an unrelated edit (a phone
    number, a logo) must not silently un-found a founding distributor."""
    headers = _auth_header(client)
    created = client.post(
        "/api/suppliers/", json={"name": "Untouched Co", "founder": True}, headers=headers
    ).json()
    resp = client.put(
        f"/api/suppliers/{created['id']}", json={"phone": "555-0142"}, headers=headers
    )
    assert resp.status_code == 200
    assert resp.json()["founder"] is True


def test_put_refuses_an_explicit_null_with_422(client, seeded_db):
    """`SupplierUpdate.founder` is `bool | None` because Pydantic needs the
    None to mean "unset" — but it cannot tell an omitted key from an explicit
    null, and this is the schema's first NOT NULL column. Without the guard
    the setattr loop writes None and the request 500s at commit."""
    headers = _auth_header(client)
    created = client.post(
        "/api/suppliers/", json={"name": "Null Founder Co", "founder": True}, headers=headers
    ).json()
    resp = client.put(f"/api/suppliers/{created['id']}", json={"founder": None}, headers=headers)
    assert resp.status_code == 422, resp.text
    # The rejected write left the row exactly as it was.
    assert client.get(f"/api/suppliers/{created['id']}").json()["founder"] is True


def test_post_refuses_an_explicit_null_with_422(client, seeded_db):
    """The create path needs no guard — `SupplierCreate.founder` is a plain
    `bool`, so Pydantic itself rejects the null. Pinned so a later "make it
    optional like the others" edit has to notice it is load-bearing."""
    headers = _auth_header(client)
    resp = client.post(
        "/api/suppliers/", json={"name": "Null Create Co", "founder": None}, headers=headers
    )
    assert resp.status_code == 422, resp.text


def test_the_silver_directory_carries_the_flag(client, db, tier_boards, seeded_db):
    """`CategoryDetailResponse.silver` is declared `list[SupplierResponse]`,
    but `GET /api/categories/{slug}` has no response_model and the payload is
    built field by field in category_service — so a field the schema names and
    the dict omits is simply absent today, and would read back as the field
    DEFAULT (False) the day anything validates through that schema. The
    Silver board is also where a founding-distributor mark would most
    plausibly render."""
    supplier = seeded_db["supplier1"]
    supplier.founder = True
    db.commit()

    body = client.get(f"/api/categories/{tier_boards['child2'].slug}").json()
    by_name = {s["name"]: s for s in body["silver"]}
    assert by_name, "the tier_boards fixture seeds two Silver sponsors"
    assert all("founder" in s for s in by_name.values()), by_name
    assert by_name[supplier.name]["founder"] is True
    # The other Silver occupant is untouched — not a blanket true.
    assert by_name[seeded_db["supplier2"].name]["founder"] is False


# ── (d) the read-only staff wall (alembic 051) ──────────────────────────────


def test_a_viewer_cannot_set_the_flag(client, db, seeded_db):
    """A `viewer` is read-only staff: require_staff already 403s every
    mutating verb, so the flag needs NO per-route check. This is the guard
    that the wall is really the thing protecting it."""
    db.add(
        User(
            username="founder_viewer",
            email="founder_viewer@test.example",
            password_hash=bcrypt.hashpw(b"testpass123", bcrypt.gensalt()).decode(),
            role="viewer",
            email_verified_at=datetime.now(UTC),
        )
    )
    db.commit()
    token = client.post(
        "/api/auth/login",
        json={"email": "founder_viewer@test.example", "password": "testpass123"},
    ).json()["token"]
    viewer_headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/api/suppliers/", json={"name": "Viewer Target Co"}, headers=_auth_header(client)
    ).json()

    resp = client.put(
        f"/api/suppliers/{created['id']}", json={"founder": True}, headers=viewer_headers
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "read_only"
    # And it really did not land.
    assert client.get(f"/api/suppliers/{created['id']}").json()["founder"] is False


# ── (e) the migration chain ─────────────────────────────────────────────────


def test_migration_054_is_chained_to_053():
    src = (VERSIONS / "054_supplier_founder.py").read_text()
    assert 'revision = "054"' in src
    assert 'down_revision = "053"' in src
    assert 'op.add_column(' in src and '"founder"' in src
    assert "server_default=sa.false()" in src, (
        "the constant server_default is what backfills every existing prod "
        "supplier to false without a table rewrite"
    )
    assert "nullable=False" in src
    assert 'op.drop_column("suppliers", "founder")' in src, "downgrade must drop the column"


# ── (e) the sponsor boards carry it (the badge's data) ──────────────────────


def test_sponsor_boards_carry_founder(db, client, tier_boards, seeded_db):
    """The Platinum (`/partners`) and Gold (`/{slug}` → `sponsor`) boards are
    hand-serialized SponsorResponse dicts, so a key the schema names but the
    dict omits would silently read back False for every founder. Flip the
    fixture's supplier and read it through both boards, plus the keyword
    route (the other hand-built SponsorResponse site)."""
    from app.models import Sponsor

    # Platinum on parent2 is supplier1; the Gold slot on `child` is supplier2.
    supplier1, supplier2 = seeded_db["supplier1"], seeded_db["supplier2"]
    parent2, child = tier_boards["parent2"], seeded_db["child"]

    plat = client.get(f"/api/categories/{parent2.slug}/partners").json()["platinum"]
    assert plat["founder"] is False
    gold = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert gold is not None and gold["founder"] is False

    supplier1.founder = True
    supplier2.founder = True
    db.add(Sponsor(supplier_id=supplier1.id, keyword="founder-kw", tier="gold"))
    db.commit()
    from app.services.category_cache import clear as clear_category_cache

    clear_category_cache()

    plat = client.get(f"/api/categories/{parent2.slug}/partners").json()["platinum"]
    assert plat["supplier_name"] == supplier1.name and plat["founder"] is True
    gold = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert gold["supplier_name"] == supplier2.name and gold["founder"] is True
    assert client.get("/api/sponsors/keyword/founder-kw").json()["founder"] is True
