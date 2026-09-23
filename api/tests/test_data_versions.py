"""GET /api/data-versions — the change check behind the console's persisted cache.

The SQLite suite exercises the count(*) fallback; the Postgres counter path
has its own harness test (test_data_versions_pg.py).
"""

import pathlib
import re
import uuid

from app.models import Category, PageView, Part, User
from app.services.auth_service import create_token
from app.services.data_versions import SCOPES, data_versions


def _staff(client):
    resp = client.post(
        "/api/auth/login", json={"email": "admin@test.example", "password": "testpass123"}
    )
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def test_requires_a_signed_in_user(client, seeded_db):
    assert client.get("/api/data-versions").status_code == 401


def test_every_scoped_table_exists(seeded_db):
    known = set(Part.__table__.metadata.tables)
    for scope, tables in SCOPES.items():
        for table in tables:
            assert table in known, (scope, table)


def test_the_sales_tables_sit_in_their_scopes():
    """Spec §6 (057): a cached console read over a new table must see it move."""
    assert SCOPES["sales"] == ("sales_codes", "checkout_intents")
    assert {"revenue", "expenses", "sponsor_payments", "billing_audit"} == set(SCOPES["money"])
    assert {"sponsors", "sponsor_billing"} == set(SCOPES["sponsors"])


def test_scope_names_mirror_the_client_union():
    """The client declares which scopes each cached read depends on; a scope
    the server does not report would hash as `?` forever and never match."""
    ts = (
        pathlib.Path(__file__).resolve().parents[2] / "frontend/src/admin/services/queryCache.ts"
    ).read_text()
    match = re.search(r"export type DataScope =\s*([^;]+);", ts)
    assert match, "DataScope union missing from queryCache.ts"
    client_scopes = set(re.findall(r"'([a-z]+)'", match.group(1)))
    assert client_scopes == set(SCOPES)


def test_shape_and_stability(client, seeded_db):
    first = client.get("/api/data-versions", headers=_staff(client))
    assert first.status_code == 200
    scopes = first.json()["scopes"]
    assert set(scopes) == set(SCOPES)
    assert all(re.fullmatch(r"[0-9a-f]{12}", v) for v in scopes.values())
    # Reading is not writing: the answer is the same until something moves.
    assert client.get("/api/data-versions", headers=_staff(client)).json()["scopes"] == scopes


def test_an_insert_moves_exactly_its_scope(client, seeded_db, db):
    before = client.get("/api/data-versions", headers=_staff(client)).json()["scopes"]
    db.add(
        PageView(
            id=uuid.uuid4(), path="/", session_id="s1", device_type="desktop", browser="Chrome"
        )
    )
    db.commit()
    after = client.get("/api/data-versions", headers=_staff(client)).json()["scopes"]
    assert after["traffic"] != before["traffic"]
    assert {k: v for k, v in after.items() if k != "traffic"} == {
        k: v for k, v in before.items() if k != "traffic"
    }

    child = db.query(Category).filter(Category.parent_id.isnot(None)).first()
    db.add(Part(id=uuid.uuid4(), sku="VERSION-PROBE", manufacturer_name="T", category_id=child.id))
    db.commit()
    later = client.get("/api/data-versions", headers=_staff(client)).json()["scopes"]
    assert later["catalog"] != after["catalog"]
    assert later["traffic"] == after["traffic"]


def test_a_customer_can_read_it_too(client, seeded_db, db):
    customer = db.query(User).filter(User.role == "user").first()
    headers = {"Authorization": f"Bearer {create_token(str(customer.id), customer.role)}"}
    resp = client.get("/api/data-versions", headers=headers)
    assert resp.status_code == 200
    assert set(resp.json()["scopes"]) == set(SCOPES)


def test_service_is_pure_over_the_counters(db, seeded_db):
    assert data_versions(db) == data_versions(db)
