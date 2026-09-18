"""Staff badge endpoints (055) — grant, restyle, enable, revoke.

`founder` stopped being a column in 055; a supplier IS a founder when it holds
an ENABLED founder-family badge. These routes are the only way staff put one
there, so they are also the only way the fire on the public boards changes —
which is why every WRITE has to call `invalidate_catalog_caches()`: the badge
look now rides INSIDE the cached category payload, and a stale page would paint
the old fire for up to an hour.

The wall is `require_staff`: a `viewer` (read-only staff, 051) reads the
catalogue and a supplier's holdings but is refused 403 `read_only` on every
mutating verb, without this router opting in per route. A customer's 403 on
these routes and staff's 403 on the customer look-only route are Task 4's.
"""

import uuid
from datetime import UTC, datetime

import bcrypt

from app.models import Badge, SupplierBadge, User
from app.models.badge import FOUNDER_BADGE_1, FOUNDER_BADGE_2, FOUNDER_FAMILY


def _auth_header(client):
    resp = client.post(
        "/api/auth/login", json={"email": "admin@test.example", "password": "testpass123"}
    )
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _viewer_header(client, db, email="badge_staff_viewer@test.example"):
    db.add(
        User(
            username="badge_staff_viewer",
            email=email,
            password_hash=bcrypt.hashpw(b"testpass123", bcrypt.gensalt()).decode(),
            role="viewer",
            email_verified_at=datetime.now(UTC),
        )
    )
    db.commit()
    token = client.post("/api/auth/login", json={"email": email, "password": "testpass123"}).json()[
        "token"
    ]
    return {"Authorization": f"Bearer {token}"}


def test_grant_patch_revoke_round_trip(client, db, seeded_db):
    h = _auth_header(client)
    sid = str(seeded_db["supplier1"].id)

    catalogue = client.get("/api/badges", headers=h).json()
    assert catalogue[0]["key"] == FOUNDER_BADGE_1
    assert catalogue[0]["family"] == FOUNDER_FAMILY

    r = client.post(f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}, headers=h)
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["scheme"] == "orange"
    assert row["intensity"] == 1.0 and row["opacity"] == 0.75 and row["sparks"] is True
    assert row["enabled"] is True and row["family"] == FOUNDER_FAMILY
    assert client.get(f"/api/suppliers/{sid}").json()["founder"] is True

    # One holding per (supplier, family): a second grant of the same family is
    # a conflict, not a silent second row.
    assert (
        client.post(
            f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}, headers=h
        ).status_code
        == 409
    )

    r = client.patch(
        f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}",
        json={"scheme": "white", "intensity": 1.7, "enabled": False},
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert r.json()["scheme"] == "white"
    assert r.json()["intensity"] == 1.7
    assert r.json()["enabled"] is False
    # Disabled is NOT a founder — the staff off-switch hides the mark.
    assert client.get(f"/api/suppliers/{sid}").json()["founder"] is False
    assert client.get(f"/api/suppliers/{sid}").json()["badge"] is None

    # Out of range, unknown key, and a key nobody may choose yet.
    assert (
        client.patch(
            f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={"intensity": 2.5}, headers=h
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={"opacity": 0.1}, headers=h
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={"scheme": "octarine"}, headers=h
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}",
            json={"key": "no_such_badge"},
            headers=h,
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}",
            json={"key": FOUNDER_BADGE_2},
            headers=h,
        ).status_code
        == 422
    ), "founder_badge_2 is in the catalogue but not available"

    assert (
        client.delete(f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", headers=h).status_code == 200
    )
    assert client.get(f"/api/suppliers/{sid}/badges", headers=h).json() == []
    assert client.get(f"/api/suppliers/{sid}").json()["founder"] is False


def test_the_look_survives_a_key_swap_and_an_explicit_null_is_refused(client, db, seeded_db):
    """`key` moves badge_id inside the SAME family and keeps the look; a null on
    any field that backs a NOT NULL column is 422, never a 500 at commit."""
    h = _auth_header(client)
    sid = str(seeded_db["supplier1"].id)
    client.post(f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}, headers=h)
    client.patch(
        f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}",
        json={"scheme": "violet", "sparks": False, "opacity": 0.4},
        headers=h,
    )

    # Make the alternate choosable, then swap onto it.
    db.query(Badge).filter_by(key=FOUNDER_BADGE_2).one().available = True
    db.commit()
    r = client.patch(
        f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={"key": FOUNDER_BADGE_2}, headers=h
    )
    assert r.status_code == 200, r.text
    assert r.json()["key"] == FOUNDER_BADGE_2
    assert r.json()["scheme"] == "violet" and r.json()["sparks"] is False
    assert r.json()["opacity"] == 0.4
    assert client.get(f"/api/suppliers/{sid}").json()["badge"]["key"] == FOUNDER_BADGE_2

    for field in ("scheme", "intensity", "opacity", "sparks", "enabled", "key"):
        resp = client.patch(
            f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={field: None}, headers=h
        )
        assert resp.status_code == 422, f"{field}: {resp.status_code}"

    assert (
        client.patch(
            f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={"colour": "red"}, headers=h
        ).status_code
        == 422
    ), "the body is extra='forbid'"


def test_unknown_supplier_and_unheld_family_are_404(client, seeded_db):
    h = _auth_header(client)
    sid = str(seeded_db["supplier1"].id)
    missing = str(uuid.uuid4())

    assert client.get(f"/api/suppliers/{missing}/badges", headers=h).status_code == 404
    assert (
        client.post(
            f"/api/suppliers/{missing}/badges", json={"key": FOUNDER_BADGE_1}, headers=h
        ).status_code
        == 404
    )
    assert (
        client.patch(
            f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={"scheme": "red"}, headers=h
        ).status_code
        == 404
    ), "nothing held yet"
    assert (
        client.delete(f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", headers=h).status_code == 404
    )
    assert (
        client.post(
            f"/api/suppliers/{sid}/badges", json={"key": "no_such_badge"}, headers=h
        ).status_code
        == 422
    )
    # ...and an unavailable one: the catalogue holds `founder_badge_2` dark
    # until the owner releases it, so it is not choosable on the grant door
    # either (the brief: "422 unknown/unavailable key").
    assert (
        client.post(
            f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_2}, headers=h
        ).status_code
        == 422
    )


def test_viewer_reads_but_cannot_write(client, db, seeded_db):
    h = _auth_header(client)
    vh = _viewer_header(client, db)
    sid = str(seeded_db["supplier1"].id)
    client.post(f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}, headers=h)

    assert client.get("/api/badges", headers=vh).status_code == 200
    reads = client.get(f"/api/suppliers/{sid}/badges", headers=vh)
    assert reads.status_code == 200 and len(reads.json()) == 1

    for resp in (
        client.post(f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}, headers=vh),
        client.patch(
            f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={"scheme": "red"}, headers=vh
        ),
        client.delete(f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", headers=vh),
    ):
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "read_only"


def test_anonymous_cannot_reach_the_routes(client, seeded_db):
    sid = str(seeded_db["supplier1"].id)
    assert client.get("/api/badges").status_code in (401, 403)
    assert client.get(f"/api/suppliers/{sid}/badges").status_code in (401, 403)
    assert client.post(
        f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}
    ).status_code in (401, 403)


def test_every_write_invalidates_the_caches(client, seeded_db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.routes.supplier_badges.invalidate_catalog_caches", lambda: calls.append(1)
    )
    h = _auth_header(client)
    sid = str(seeded_db["supplier1"].id)

    client.get("/api/badges", headers=h)
    client.get(f"/api/suppliers/{sid}/badges", headers=h)
    assert calls == [], "reads must not drop the caches"

    client.post(f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}, headers=h)
    client.patch(
        f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={"scheme": "blue"}, headers=h
    )
    client.delete(f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", headers=h)
    assert len(calls) == 3


def test_deleting_a_supplier_takes_its_badges_with_it(client, db, seeded_db):
    """`supplier_badges` is a dependent, not history: a company that is gone
    holds nothing, by EITHER road. `Supplier.badges` carries
    `cascade="all, delete-orphan"` and the FK carries ON DELETE CASCADE, so
    this test would still pass with `delete_supplier`'s bulk statement removed
    — it pins the OUTCOME the public boards depend on, not that one line."""
    h = _auth_header(client)
    created = client.post("/api/suppliers/", json={"name": "Badge Cascade Co"}, headers=h).json()
    sid = created["id"]
    client.post(f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}, headers=h)
    assert db.query(SupplierBadge).filter_by(supplier_id=uuid.UUID(sid)).count() == 1

    assert client.delete(f"/api/suppliers/{sid}", headers=h).status_code == 200
    db.expire_all()
    assert db.query(SupplierBadge).filter_by(supplier_id=uuid.UUID(sid)).count() == 0


def test_a_patch_cannot_move_a_holding_into_another_family(client, db, seeded_db):
    """A holding is keyed on its family, so a PATCH may only switch to the
    ALTERNATE ARTWORK of the family it already holds — never sideways into a
    different one (which would leave the row's `family` disagreeing with its
    badge and break `uq_supplier_badges_family`). The seeded catalogue is
    founder-only, so the refusal needs a second family to exist at all."""
    h = _auth_header(client)
    sid = str(seeded_db["supplier1"].id)
    client.post(f"/api/suppliers/{sid}/badges", json={"key": FOUNDER_BADGE_1}, headers=h)
    # available=True on purpose: the family check runs BEFORE the availability
    # check, so this must still answer `badge_family_mismatch`.
    db.add(Badge(key="other_badge_1", family="other", label="Other", available=True, sort_order=9))
    db.commit()

    r = client.patch(
        f"/api/suppliers/{sid}/badges/{FOUNDER_FAMILY}", json={"key": "other_badge_1"}, headers=h
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "badge_family_mismatch"


def test_data_versions_has_a_badges_scope():
    """A table may sit in two scopes: `badges`/`supplier_badges` are in
    `catalog` (the boards read them) AND in their own scope, so the editor's
    reads re-probe on a grant without the whole catalog moving."""
    from app.services.data_versions import SCOPES

    assert SCOPES["badges"] == ("badges", "supplier_badges")
