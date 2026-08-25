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


def test_deactivation_clears_the_stamp(client, db, seeded_db, auth_header):
    from datetime import UTC, datetime

    u = _customer(db, activated_at=datetime.now(UTC))
    db.commit()
    r = client.patch(f"/api/admin/users/{u.id}", json={"activated": False},
                     headers=auth_header())
    assert r.json()["activated_at"] is None


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
