"""Migration 055, read side — `founder` is DERIVED and every payload that carried
it now carries the look beside it.

`suppliers.founder` was a column until 055; it is now "this supplier holds an
ENABLED founder-family badge", answered in one place
(`app.services.badges.supplier_badge_fields`). These tests pin the WIRE shape at
every site that reads it — the public supplier list and detail, the customer
console's two supplier reads, the Silver directory, and the three hand-built
SponsorResponse dicts (Platinum `/partners`, Gold `/{slug}`, the keyword route).

Two of those families have no response_model at all (the category payloads are
built field by field), so a key the schema names and the dict omits is simply
ABSENT on the wire — which is exactly how `founder` could have gone missing
before, and why each board is exercised over HTTP rather than through the
helper. The helper gets its own test too, because the customer console reads
share `supplier_to_dict` rather than re-deriving anything.
"""

import uuid
from datetime import UTC, datetime

import bcrypt

from app.models import Badge, Sponsor, SupplierBadge, User
from app.models.badge import FOUNDER_BADGE_1, FOUNDER_BADGE_2, FOUNDER_FAMILY
from app.routes.suppliers import supplier_to_dict
from app.services.category_cache import clear as clear_category_cache

DEFAULT_LOOK = {"scheme": "orange", "intensity": 1.0, "opacity": 0.75, "sparks": True}


def _auth_header(client):
    resp = client.post(
        "/api/auth/login", json={"email": "admin@test.example", "password": "testpass123"}
    )
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _grant(db, supplier, key=FOUNDER_BADGE_1, **look):
    badge = db.query(Badge).filter_by(key=key).one()
    row = SupplierBadge(
        id=uuid.uuid4(),
        supplier_id=supplier.id,
        badge_id=badge.id,
        family=FOUNDER_FAMILY,
        **look,
    )
    db.add(row)
    db.commit()
    db.refresh(supplier)
    clear_category_cache()
    return row


# ── (a) the public supplier payloads ────────────────────────────────────────


def test_public_list_carries_derived_founder_and_look(client, db, seeded_db):
    sup = seeded_db["supplier1"]
    before = {s["id"]: s for s in client.get("/api/suppliers/").json()}
    assert before[str(sup.id)]["founder"] is False
    assert before[str(sup.id)]["badge"] is None

    _grant(db, sup, scheme="black", intensity=1.5)

    after = {s["id"]: s for s in client.get("/api/suppliers/").json()}
    assert after[str(sup.id)]["founder"] is True
    assert after[str(sup.id)]["badge"] == {
        "key": FOUNDER_BADGE_1,
        "scheme": "black",
        "intensity": 1.5,
        "opacity": 0.75,
        "sparks": True,
    }
    # Not a blanket true — the other seeded supplier holds nothing.
    other = after[str(seeded_db["supplier2"].id)]
    assert other["founder"] is False and other["badge"] is None


def test_detail_carries_the_pair(client, db, seeded_db):
    sup = seeded_db["supplier1"]
    _grant(db, sup, key=FOUNDER_BADGE_2, scheme="violet", opacity=0.4, sparks=False)
    body = client.get(f"/api/suppliers/{sup.id}").json()
    assert body["founder"] is True
    assert body["badge"] == {
        "key": FOUNDER_BADGE_2,
        "scheme": "violet",
        "intensity": 1.0,
        "opacity": 0.4,
        "sparks": False,
    }


def test_a_disabled_holding_shows_nothing(client, db, seeded_db):
    """`enabled` is the staff off-switch (customers may never set it). A
    disabled holding is not a founder and paints no fire."""
    sup = seeded_db["supplier1"]
    _grant(db, sup, scheme="green", enabled=False)
    body = client.get(f"/api/suppliers/{sup.id}").json()
    assert body["founder"] is False and body["badge"] is None


def test_founder_and_badge_are_public_on_the_unauthenticated_list(client, seeded_db):
    """It is an incentive badge, not a secret — both keys must survive the
    public read path, and `SupplierResponse` is shared by public AND admin."""
    from app.schemas.supplier import SupplierResponse

    assert "founder" in SupplierResponse.model_fields
    assert "badge" in SupplierResponse.model_fields
    for row in client.get("/api/suppliers/").json():
        assert "founder" in row and "badge" in row


def test_the_customer_console_reads_share_supplier_to_dict(db, seeded_db):
    """`/api/account/suppliers` and `/api/account/my-supply` build their rows
    from `routes.suppliers.supplier_to_dict` rather than re-deriving anything,
    so the pair travels to the customer console for free. Pinned both ways:
    the helper carries it, and the console still calls the helper."""
    from pathlib import Path

    sup = seeded_db["supplier1"]
    assert supplier_to_dict(sup) | {"founder": False, "badge": None} == supplier_to_dict(sup)

    _grant(db, sup, scheme="blue")
    fields = supplier_to_dict(sup)
    assert fields["founder"] is True
    assert fields["badge"] == {"key": FOUNDER_BADGE_1, **DEFAULT_LOOK, "scheme": "blue"}

    src = (
        Path(__file__).resolve().parents[1] / "app" / "routes" / "account_catalog.py"
    ).read_text()
    assert src.count("supplier_to_dict(") >= 2, (
        "both console supplier reads must go through the shared helper — a "
        "hand-built second shape is how `founder` would silently vanish there"
    )


# ── (b) the write side no longer knows the word ─────────────────────────────


def test_create_and_update_no_longer_accept_founder(client, seeded_db):
    """The column is gone; `SupplierCreate`/`SupplierUpdate` do not name the
    field, so Pydantic drops the key. Ignored, NOT honoured — the grant is the
    badge route's job, never a supplier write."""
    headers = _auth_header(client)
    created = client.post(
        "/api/suppliers/", json={"name": "No Flag Co", "founder": True}, headers=headers
    )
    assert created.status_code == 200, created.text
    assert created.json()["founder"] is False and created.json()["badge"] is None

    sid = created.json()["id"]
    updated = client.put(f"/api/suppliers/{sid}", json={"founder": True}, headers=headers)
    assert updated.status_code == 200, updated.text
    assert updated.json()["founder"] is False and updated.json()["badge"] is None
    assert client.get(f"/api/suppliers/{sid}").json()["founder"] is False


def test_a_viewer_still_cannot_write_a_supplier(client, db, seeded_db):
    """A `viewer` is read-only staff and `require_staff` 403s every mutating
    verb — the wall that used to protect the founder flag still stands over
    the supplier write path (the badge routes get their own guard in Task 3)."""
    db.add(
        User(
            username="badge_viewer",
            email="badge_viewer@test.example",
            password_hash=bcrypt.hashpw(b"testpass123", bcrypt.gensalt()).decode(),
            role="viewer",
            email_verified_at=datetime.now(UTC),
        )
    )
    db.commit()
    token = client.post(
        "/api/auth/login",
        json={"email": "badge_viewer@test.example", "password": "testpass123"},
    ).json()["token"]
    viewer_headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/api/suppliers/", json={"name": "Viewer Target Co"}, headers=_auth_header(client)
    ).json()
    resp = client.put(
        f"/api/suppliers/{created['id']}", json={"name": "Renamed"}, headers=viewer_headers
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "read_only"


# ── (c) the boards ──────────────────────────────────────────────────────────


def test_the_silver_directory_carries_the_look(client, db, tier_boards, seeded_db):
    """`CategoryDetailResponse.silver` is declared `list[SupplierResponse]`, but
    `GET /api/categories/{slug}` has no response_model and the payload is built
    field by field in category_service — a field the schema names and the dict
    omits is absent today and would read back as the DEFAULT the day anything
    validates through that schema."""
    supplier = seeded_db["supplier1"]
    _grant(db, supplier, scheme="indigo", intensity=0.5, opacity=1.0)

    body = client.get(f"/api/categories/{tier_boards['child2'].slug}").json()
    by_name = {s["name"]: s for s in body["silver"]}
    assert by_name, "the tier_boards fixture seeds two Silver sponsors"
    assert all("founder" in s and "badge" in s for s in by_name.values()), by_name
    assert by_name[supplier.name]["founder"] is True
    assert by_name[supplier.name]["badge"] == {
        "key": FOUNDER_BADGE_1,
        "scheme": "indigo",
        "intensity": 0.5,
        "opacity": 1.0,
        "sparks": True,
    }
    other = by_name[seeded_db["supplier2"].name]
    assert other["founder"] is False and other["badge"] is None


def test_sponsor_boards_carry_founder_and_the_look(client, db, tier_boards, seeded_db):
    """The Platinum (`/partners`), Gold (`/{slug}` → `sponsor`) and keyword
    boards are hand-serialized SponsorResponse dicts — three sites that must
    each stamp the pair, or the badge silently disappears from that board."""
    supplier1, supplier2 = seeded_db["supplier1"], seeded_db["supplier2"]
    parent2, child = tier_boards["parent2"], seeded_db["child"]

    plat = client.get(f"/api/categories/{parent2.slug}/partners").json()["platinum"]
    assert plat["founder"] is False and plat["badge"] is None
    gold = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert gold is not None and gold["founder"] is False and gold["badge"] is None

    db.add(Sponsor(supplier_id=supplier1.id, keyword="founder-kw", tier="gold"))
    db.commit()
    _grant(db, supplier1, scheme="white", intensity=2.0)
    _grant(db, supplier2, key=FOUNDER_BADGE_2, scheme="red", sparks=False)

    plat = client.get(f"/api/categories/{parent2.slug}/partners").json()["platinum"]
    assert plat["supplier_name"] == supplier1.name and plat["founder"] is True
    assert plat["badge"] == {
        "key": FOUNDER_BADGE_1,
        **DEFAULT_LOOK,
        "scheme": "white",
        "intensity": 2.0,
    }

    gold = client.get(f"/api/categories/{child.slug}").json()["sponsor"]
    assert gold["supplier_name"] == supplier2.name and gold["founder"] is True
    assert gold["badge"] == {
        "key": FOUNDER_BADGE_2,
        **DEFAULT_LOOK,
        "scheme": "red",
        "sparks": False,
    }

    kw = client.get("/api/sponsors/keyword/founder-kw").json()
    assert kw["founder"] is True
    assert kw["badge"] == {
        "key": FOUNDER_BADGE_1,
        **DEFAULT_LOOK,
        "scheme": "white",
        "intensity": 2.0,
    }


def test_the_sponsor_schema_names_both_keys(client, seeded_db):
    from app.schemas.sponsor import SponsorResponse

    assert "founder" in SponsorResponse.model_fields
    assert "badge" in SponsorResponse.model_fields
