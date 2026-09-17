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
