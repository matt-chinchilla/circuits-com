"""The staff-only registered-account roster: /api/admin/users.

`auth_header` logs in against the accounts `seeded_db` creates, so every test
that authenticates has to request it alongside `db` — the two share one
session, so a row added through `db` is visible to the request.
"""

from app.models import User


def _customer(db, email="c@test.example", activated_at=None):
    u = User(username=email, email=email, password_hash="x", role="user",
             first_name="Ada", last_name="Lovelace", signup_country="US",
             activated_at=activated_at)
    db.add(u)
    db.flush()
    return u


def test_a_customer_cannot_read_the_roster(client, db, seeded_db, auth_header):
    _customer(db)
    db.commit()
    r = client.get("/api/admin/users/",
                   headers=auth_header(email="kennedy_user@test.example"))
    assert r.status_code == 403
    assert r.json()["detail"] == "staff_only"


def test_staff_can_read_the_roster(client, db, seeded_db, auth_header):
    _customer(db)
    db.commit()
    r = client.get("/api/admin/users/", headers=auth_header())
    assert r.status_code == 200
    emails = [row["email"] for row in r.json()]
    assert "c@test.example" in emails


def test_the_roster_carries_the_columns_the_page_renders(
    client, db, seeded_db, auth_header
):
    _customer(db)
    db.commit()
    row = [u for u in client.get("/api/admin/users/",
                                 headers=auth_header()).json()
           if u["email"] == "c@test.example"][0]
    for key in ("id", "full_name", "email", "created_at", "signup_country",
                "website", "tier", "email_verified_at", "activated_at",
                "supplier_id", "manufacturer_id"):
        assert key in row, f"missing {key}"


def test_activation_stamps_and_is_idempotent(client, db, seeded_db, auth_header):
    u = _customer(db)
    db.commit()
    r = client.patch(f"/api/admin/users/{u.id}", json={"activated": True},
                     headers=auth_header())
    assert r.status_code == 200
    first = r.json()["activated_at"]
    assert first is not None
    again = client.patch(f"/api/admin/users/{u.id}", json={"activated": True},
                         headers=auth_header())
    assert again.json()["activated_at"] == first, "re-activating must not re-stamp"


def test_deactivation_is_refused_because_activation_is_one_way(
    client, db, seeded_db, auth_header
):
    """This test asserted the OPPOSITE until 2026-08-26.

    Deactivation existed as a way to revoke a lapsed customer without deleting
    them — but it also reset activated_at to NULL, which made the next
    Activate a fresh edge that mailed a second welcome. The owner chose a
    one-way door with deletion as the only way back, which removes the cycle
    rather than tracking around it. See test_activation_is_one_way.py.
    """
    from datetime import UTC, datetime

    u = _customer(db, activated_at=datetime.now(UTC))
    db.commit()
    r = client.patch(f"/api/admin/users/{u.id}", json={"activated": False},
                     headers=auth_header())
    assert r.status_code == 409
    assert r.json()["detail"] == "activation_is_one_way"


def test_a_customer_cannot_activate_themselves(client, db, seeded_db, auth_header):
    u = _customer(db)
    db.commit()
    r = client.patch(f"/api/admin/users/{u.id}", json={"activated": True},
                     headers=auth_header(email="kennedy_user@test.example"))
    assert r.status_code == 403


def test_delete_is_owner_only(client, db, seeded_db, auth_header):
    u = _customer(db)
    db.commit()
    # `admin` is not `owner`.
    r = client.delete(f"/api/admin/users/{u.id}", headers=auth_header())
    assert r.status_code == 403
    assert r.json()["detail"] == "owner_only"


def test_activation_emails_the_customer_exactly_once(
    client, db, seeded_db, auth_header, monkeypatch
):
    """The stamp not moving is the mechanism; THIS is the harm it prevents.

    Re-saving an already-active account must not mail them again, and a save
    that only changes a capability link must not mail them at all.
    """
    from app.routes import admin_users

    sent = []

    async def fake_send(to, first_name, url):
        sent.append((to, first_name, url))
        return True

    monkeypatch.setattr(admin_users.email_service, "send_activation_email", fake_send)
    u = _customer(db)
    db.commit()
    headers = auth_header()
    client.patch(f"/api/admin/users/{u.id}", json={"activated": True}, headers=headers)
    client.patch(f"/api/admin/users/{u.id}", json={"activated": True}, headers=headers)
    client.patch(f"/api/admin/users/{u.id}", json={"supplier_id": None}, headers=headers)
    assert len(sent) == 1, sent
    assert sent[0][2].endswith("/account?activated=1")


def test_the_roster_manages_customers_only(client, db, seeded_db, auth_header):
    """A staff row is not roster material — no activating or deleting an admin
    through the customer roster. Unknown/malformed ids get 404/422, not a 500.
    """
    import uuid

    headers = auth_header()
    admin_id = seeded_db["admin_user"].id
    assert client.patch(
        f"/api/admin/users/{admin_id}", json={"activated": True}, headers=headers
    ).status_code == 404
    assert client.patch(
        f"/api/admin/users/{uuid.uuid4()}", json={"activated": True}, headers=headers
    ).status_code == 404
    assert client.patch(
        "/api/admin/users/not-a-uuid", json={"activated": True}, headers=headers
    ).status_code == 422
    # extra="forbid" — the body may never carry `role`.
    assert client.patch(
        f"/api/admin/users/{uuid.uuid4()}", json={"role": "owner"}, headers=headers
    ).status_code == 422
    assert client.get("/api/admin/users/").status_code == 401


# ── DELETE /api/admin/users/{id} ────────────────────────────────────────────
# test_delete_is_owner_only above only proves the DOOR. Everything past it —
# that the row actually goes, that the customer's own inbox goes with it, that
# a staff account is not roster material — held on a handler that was a no-op
# returning {"status": "ok"} for anything it was handed.


def _owner(db, email="owner@test.example"):
    """The one role that may destroy a row. `seeded_db`'s admin is `admin`,
    which is deliberately NOT enough (auth_service.require_owner)."""
    from app.services.auth_service import hash_password

    u = User(username=email, email=email,
             password_hash=hash_password("testpass123"), role="owner",
             first_name="Mat", last_name="Owner")
    db.add(u)
    db.flush()
    return u


def test_the_owner_can_actually_delete_a_customer(client, db, seeded_db, auth_header):
    u = _customer(db)
    _owner(db)
    db.commit()
    r = client.delete(f"/api/admin/users/{u.id}",
                      headers=auth_header(email="owner@test.example"))
    assert r.status_code == 200
    db.expire_all()
    assert db.query(User).filter(User.email == "c@test.example").count() == 0


def test_deleting_a_customer_takes_their_own_inbox_with_them(client, db, seeded_db, auth_header):
    """messages.user_id is ON DELETE CASCADE, and the split matters: a
    customer's welcome row is THEIRS, while a staff-inbox row (user_id NULL) is
    the company's record of the registration and must survive."""
    from app.models import Message

    u = _customer(db)
    _owner(db)
    db.add(Message(id="am1", type="welcome", status="new", seq=9201,
                   user_id=u.id, payload={}))
    db.add(Message(id="am2", type="signup", status="new", seq=9202,
                   user_id=None, payload={}))
    db.commit()

    r = client.delete(f"/api/admin/users/{u.id}",
                      headers=auth_header(email="owner@test.example"))
    assert r.status_code == 200
    db.expire_all()
    assert db.query(User).filter(User.email == "c@test.example").count() == 0
    assert db.query(Message).filter(Message.id == "am1").count() == 0
    assert db.query(Message).filter(Message.id == "am2").count() == 1


def test_the_roster_will_not_delete_a_staff_account(client, db, seeded_db, auth_header):
    """Same rule the PATCH follows: this endpoint manages CUSTOMERS. Deleting
    an administrator — the owner's own login included — is not something the
    customer roster gets to do, and 404 is the honest answer because as far as
    this collection is concerned that id is not in it."""
    owner = _owner(db)
    db.commit()
    headers = auth_header(email="owner@test.example")
    admin_id = seeded_db["admin_user"].id
    owner_id = owner.id

    assert client.delete(f"/api/admin/users/{admin_id}", headers=headers).status_code == 404
    assert client.delete(f"/api/admin/users/{owner_id}", headers=headers).status_code == 404
    db.expire_all()
    assert db.query(User).filter(User.id == admin_id).count() == 1
    assert db.query(User).filter(User.id == owner_id).count() == 1


def test_delete_answers_404_and_422_rather_than_500(client, db, seeded_db, auth_header):
    import uuid

    _owner(db)
    db.commit()
    headers = auth_header(email="owner@test.example")
    assert client.delete(f"/api/admin/users/{uuid.uuid4()}",
                         headers=headers).status_code == 404
    assert client.delete("/api/admin/users/not-a-uuid",
                         headers=headers).status_code == 422
    assert client.delete(f"/api/admin/users/{uuid.uuid4()}").status_code == 401


# ── The capability links (D18) ──────────────────────────────────────────────


def test_a_capability_link_that_names_nothing_is_a_4xx(client, db, seeded_db, auth_header):
    """A well-formed uuid naming no row used to reach db.commit() and come back
    as an unhandled FK violation — a 500 on an admin form, which reads as "the
    server is broken" rather than "that company is gone"."""
    import uuid

    u = _customer(db)
    db.commit()
    headers = auth_header()
    ghost = str(uuid.uuid4())

    r = client.patch(f"/api/admin/users/{u.id}", json={"supplier_id": ghost}, headers=headers)
    assert r.status_code == 422
    assert r.json()["detail"] == "unknown_supplier"

    r = client.patch(f"/api/admin/users/{u.id}", json={"manufacturer_id": ghost}, headers=headers)
    assert r.status_code == 422
    assert r.json()["detail"] == "unknown_manufacturer"

    db.expire_all()
    row = db.query(User).filter(User.email == "c@test.example").one()
    assert row.supplier_id is None
    assert row.manufacturer_id is None


def test_a_rejected_link_does_not_half_apply_the_rest_of_the_body(
    client, db, seeded_db, auth_header
):
    """One body, one outcome. A save carrying an activation AND a dead
    supplier_id must leave NOTHING pending on the session — deliberately
    asserted WITHOUT expire_all(), which would discard an un-committed
    in-memory stamp and hide exactly the bug."""
    import uuid

    u = _customer(db)
    db.commit()
    r = client.patch(
        f"/api/admin/users/{u.id}",
        json={"activated": True, "supplier_id": str(uuid.uuid4())},
        headers=auth_header(),
    )
    assert r.status_code == 422
    assert db.query(User).filter(User.email == "c@test.example").one().activated_at is None


def test_a_real_link_is_still_accepted(client, db, seeded_db, auth_header):
    """The other half: the check must not be "refuse everything". Both links
    set, then cleared."""
    from app.models import Manufacturer

    u = _customer(db)
    maker = Manufacturer(name="Nordic Semiconductor", slug="nordic-semiconductor",
                         canonical_key="nordic semiconductor")
    db.add(maker)
    db.commit()
    supplier = seeded_db["supplier2"]
    headers = auth_header()

    r = client.patch(f"/api/admin/users/{u.id}",
                     json={"supplier_id": str(supplier.id),
                           "manufacturer_id": str(maker.id)}, headers=headers)
    assert r.status_code == 200
    assert r.json()["supplier_id"] == str(supplier.id)
    assert r.json()["manufacturer_id"] == str(maker.id)
    assert r.json()["company"] == "Kennedy Electronics"

    r = client.patch(f"/api/admin/users/{u.id}",
                     json={"supplier_id": None, "manufacturer_id": None}, headers=headers)
    assert r.status_code == 200
    assert r.json()["supplier_id"] is None
    assert r.json()["manufacturer_id"] is None
