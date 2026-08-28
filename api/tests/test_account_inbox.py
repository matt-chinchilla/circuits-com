"""The customer's own inbox — app/routes/account_inbox.py — and the staff
inbox's half of the same wall, app/routes/admin_messages.py.

`messages.user_id` is the whole boundary: NULL is the shared STAFF inbox (every
public form submission, every pre-043 row), populated is exactly one person's
mail. Two doors open onto one table, so the scoping has to hold from both
sides, and a test that passes against UNSCOPED code proves nothing. Every
assertion below therefore names BOTH halves — the row that must appear and the
row that must not — against a fixture that always contains someone else's
message AND a staff-inbox message. Each has been mutation-checked (break the
filter, watch it redden); see the report.
"""

import uuid
from datetime import UTC, datetime

import pytest

from app.main import app
from app.models import Message, User
from app.routes import account_inbox
from app.services.auth_service import hash_password

PW = "Analytical1!"

# The controller wires the routers into main.py after this project lands, so
# this module must not depend on that having happened yet — and must not break
# once it has. Include once, only if it is not already mounted.
if not any(getattr(r, "path", "") == "/api/account/messages" for r in app.routes):
    app.include_router(account_inbox.router)


def _customer(db, email, *, activated=True, supplier_id=None):
    user = User(
        id=uuid.uuid4(),
        username=email,
        email=email,
        password_hash=hash_password(PW),
        role="user",
        first_name="James",
        supplier_id=supplier_id,
        email_verified_at=datetime.now(UTC),
        activated_at=datetime.now(UTC) if activated else None,
    )
    db.add(user)
    db.flush()
    return user


def _message(db, *, seq, user_id, mid=None, mtype="welcome", status="new"):
    msg = Message(
        id=mid or str(uuid.uuid4()),
        type=mtype,
        status=status,
        seq=seq,
        user_id=user_id,
        payload={"full_name": "James Chirichella"},
    )
    db.add(msg)
    db.flush()
    return msg


def _login(client, email, password=PW):
    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['token']}"}


@pytest.fixture
def inboxes(client, db):
    """Two customers and the staff inbox, each holding one row.

    Three rows is the minimum that can tell scoping apart from no scoping:
    A's own row (must be visible), B's row (another customer — must not), and
    a `user_id IS NULL` row (the staff inbox — must not, and is the one an
    equality test would hand over if it ever grew an `is_(None)` convenience).
    """
    alice = _customer(db, "alice@test.example")
    bob = _customer(db, "bob@test.example")
    mine = _message(db, seq=9101, user_id=alice.id, mid="msg-alice")
    theirs = _message(db, seq=9102, user_id=bob.id, mid="msg-bob")
    staff = _message(db, seq=9103, user_id=None, mid="msg-staff", mtype="contact")
    db.commit()
    return {
        "alice": alice,
        "bob": bob,
        "mine": mine,
        "theirs": theirs,
        "staff": staff,
        "headers": _login(client, "alice@test.example"),
    }


# ── GET /api/account/messages ───────────────────────────────────────────────


class TestTheListIsOnlyMine:
    def test_it_returns_my_row_and_nobody_elses(self, client, inboxes):
        resp = client.get("/api/account/messages", headers=inboxes["headers"])
        assert resp.status_code == 200, resp.text
        ids = [row["id"] for row in resp.json()]
        assert ids == ["msg-alice"], ids

    def test_the_staff_inbox_is_not_mine(self, client, inboxes):
        """A NULL user_id is the company's own correspondence. It is the row an
        equality filter must never match, and the one a hand-written
        `or_(user_id.is_(None))` would leak to every customer at once."""
        resp = client.get("/api/account/messages", headers=inboxes["headers"])
        assert "msg-staff" not in [row["id"] for row in resp.json()]

    def test_a_customer_with_no_mail_gets_an_empty_list_not_everyones(
        self, client, db, inboxes
    ):
        _customer(db, "carol@test.example")
        db.commit()
        resp = client.get(
            "/api/account/messages", headers=_login(client, "carol@test.example")
        )
        assert resp.status_code == 200
        assert resp.json() == []

    def test_it_never_ships_the_staff_workflow_fields(self, client, inboxes):
        """assigned_to / spam_score / last_reply_body are how STAFF work a
        queue, and `seq` is a GLOBAL counter across every message in the table —
        publishing it would tell a customer the company's total inbound volume
        and how fast it grows."""
        resp = client.get("/api/account/messages", headers=inboxes["headers"])
        row = resp.json()[0]
        for leaked in ("assigned_to", "spam_score", "last_reply_body", "seq", "user_id"):
            assert leaked not in row, leaked


class TestTheDoorIsGuarded:
    def test_anonymous_is_401(self, client, inboxes):
        assert client.get("/api/account/messages").status_code == 401

    def test_an_unactivated_customer_is_refused(self, client, db, inboxes):
        _customer(db, "pending@test.example", activated=False)
        db.commit()
        resp = client.get(
            "/api/account/messages", headers=_login(client, "pending@test.example")
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "account_not_activated"

    def test_staff_have_no_customer_inbox(self, client, db, seeded_db, inboxes):
        """This router is the CUSTOMER's inbox. Staff read the staff inbox at
        /api/admin/messages; there is no personal mail behind an admin login."""
        resp = client.get(
            "/api/account/messages", headers=_login(client, "admin@test.example", "testpass123")
        )
        assert resp.status_code == 403


# ── GET /api/account/messages/{id} ──────────────────────────────────────────


class TestReadingOneMessage:
    def test_my_own_message_reads(self, client, inboxes):
        resp = client.get("/api/account/messages/msg-alice", headers=inboxes["headers"])
        assert resp.status_code == 200
        assert resp.json()["id"] == "msg-alice"

    def test_another_customers_message_is_404_not_403(self, client, inboxes):
        """403 would confirm the row exists. The honest answer for a row that is
        not in this collection is that it is not there."""
        resp = client.get("/api/account/messages/msg-bob", headers=inboxes["headers"])
        assert resp.status_code == 404, resp.text

    def test_a_staff_inbox_row_is_404_not_403(self, client, inboxes):
        resp = client.get("/api/account/messages/msg-staff", headers=inboxes["headers"])
        assert resp.status_code == 404, resp.text

    def test_an_unknown_id_answers_exactly_like_someone_elses(self, client, inboxes):
        """The two must be indistinguishable, or the status code becomes an
        existence oracle for message ids."""
        theirs = client.get("/api/account/messages/msg-bob", headers=inboxes["headers"])
        nobodys = client.get(
            "/api/account/messages/msg-does-not-exist", headers=inboxes["headers"]
        )
        assert theirs.status_code == nobodys.status_code == 404
        assert theirs.json() == nobodys.json()


# ── PATCH /api/account/messages/{id} ────────────────────────────────────────


class TestMarkingReadAndUnread:
    def test_i_can_mark_my_own_read(self, client, db, inboxes):
        resp = client.patch(
            "/api/account/messages/msg-alice",
            json={"read": True},
            headers=inboxes["headers"],
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["read"] is True
        db.expire_all()
        row = db.query(Message).filter(Message.id == "msg-alice").one()
        assert row.status == "read"
        assert row.read_at is not None

    def test_i_can_mark_it_unread_again(self, client, db, inboxes):
        client.patch(
            "/api/account/messages/msg-alice",
            json={"read": True},
            headers=inboxes["headers"],
        )
        resp = client.patch(
            "/api/account/messages/msg-alice",
            json={"read": False},
            headers=inboxes["headers"],
        )
        assert resp.status_code == 200
        assert resp.json()["read"] is False
        db.expire_all()
        row = db.query(Message).filter(Message.id == "msg-alice").one()
        assert row.status == "new"
        # read_at is the durable fact "this was first opened at T". Marking a
        # message unread is a display preference and does not un-happen it.
        assert row.read_at is not None

    def test_the_first_read_timestamp_is_never_overwritten(self, client, db, inboxes):
        client.patch(
            "/api/account/messages/msg-alice",
            json={"read": True},
            headers=inboxes["headers"],
        )
        db.expire_all()
        first = db.query(Message).filter(Message.id == "msg-alice").one().read_at
        client.patch(
            "/api/account/messages/msg-alice",
            json={"read": False},
            headers=inboxes["headers"],
        )
        client.patch(
            "/api/account/messages/msg-alice",
            json={"read": True},
            headers=inboxes["headers"],
        )
        db.expire_all()
        assert db.query(Message).filter(Message.id == "msg-alice").one().read_at == first

    def test_i_cannot_patch_another_customers_message(self, client, db, inboxes):
        resp = client.patch(
            "/api/account/messages/msg-bob",
            json={"read": True},
            headers=inboxes["headers"],
        )
        assert resp.status_code == 404, resp.text
        db.expire_all()
        assert db.query(Message).filter(Message.id == "msg-bob").one().status == "new"

    def test_i_cannot_patch_a_staff_inbox_row(self, client, db, inboxes):
        resp = client.patch(
            "/api/account/messages/msg-staff",
            json={"read": True},
            headers=inboxes["headers"],
        )
        assert resp.status_code == 404, resp.text
        db.expire_all()
        assert db.query(Message).filter(Message.id == "msg-staff").one().status == "new"

    def test_the_staff_workflow_fields_are_not_reachable(self, client, db, inboxes):
        """`status` here is a two-valued read flag, not the staff vocabulary.
        A body that names assigned_to, or a status of 'responded', is REFUSED —
        not quietly ignored, which would let a client believe it worked."""
        for body in (
            {"assigned_to": "Daniel"},
            {"status": "responded"},
            {"read": True, "assigned_to": "Daniel"},
            {"last_reply_body": "we already replied"},
            {"user_id": str(inboxes["bob"].id)},
            {"spam_score": 0.0},
        ):
            resp = client.patch(
                "/api/account/messages/msg-alice", json=body, headers=inboxes["headers"]
            )
            assert resp.status_code == 422, (body, resp.status_code)
        db.expire_all()
        row = db.query(Message).filter(Message.id == "msg-alice").one()
        assert row.status == "new"
        assert row.assigned_to is None
        assert row.user_id == inboxes["alice"].id

    def test_read_is_required(self, client, inboxes):
        resp = client.patch(
            "/api/account/messages/msg-alice", json={}, headers=inboxes["headers"]
        )
        assert resp.status_code == 422

    def test_anonymous_cannot_patch(self, client, db, inboxes):
        resp = client.patch("/api/account/messages/msg-alice", json={"read": True})
        assert resp.status_code == 401
        db.expire_all()
        assert db.query(Message).filter(Message.id == "msg-alice").one().status == "new"


# ── The leak: /api/admin/messages is the STAFF inbox ────────────────────────


@pytest.fixture
def owner_header(client, db, seeded_db):
    db.add(
        User(
            id=uuid.uuid4(),
            username="owner",
            email="owner@test.example",
            password_hash=hash_password(PW),
            role="owner",
        )
    )
    db.commit()
    return _login(client, "owner@test.example")


class TestTheStaffInboxHoldsOnlyStaffMail:
    def test_the_list_drops_customer_rows(self, client, db, seeded_db, auth_header):
        alice = _customer(db, "alice@test.example")
        _message(db, seq=9201, user_id=alice.id, mid="msg-alice")
        _message(db, seq=9202, user_id=None, mid="msg-staff", mtype="contact")
        db.commit()
        resp = client.get("/api/admin/messages/", headers=auth_header())
        assert resp.status_code == 200, resp.text
        ids = [row["id"] for row in resp.json()]
        assert "msg-staff" in ids
        assert "msg-alice" not in ids

    def test_a_customer_row_cannot_be_read_by_id(self, client, db, seeded_db, auth_header):
        alice = _customer(db, "alice@test.example")
        _message(db, seq=9201, user_id=alice.id, mid="msg-alice")
        db.commit()
        resp = client.get("/api/admin/messages/msg-alice", headers=auth_header())
        assert resp.status_code == 404, resp.text

    def test_a_customer_row_cannot_be_patched(self, client, db, seeded_db, auth_header):
        alice = _customer(db, "alice@test.example")
        _message(db, seq=9201, user_id=alice.id, mid="msg-alice")
        db.commit()
        resp = client.patch(
            "/api/admin/messages/msg-alice",
            json={"status": "read", "assigned_to": "Daniel"},
            headers=auth_header(),
        )
        assert resp.status_code == 404, resp.text
        db.expire_all()
        row = db.query(Message).filter(Message.id == "msg-alice").one()
        assert row.status == "new"
        assert row.assigned_to is None

    def test_a_customer_row_cannot_be_deleted(self, client, db, seeded_db, owner_header):
        alice = _customer(db, "alice@test.example")
        _message(db, seq=9201, user_id=alice.id, mid="msg-alice")
        db.commit()
        resp = client.delete("/api/admin/messages/msg-alice", headers=owner_header)
        assert resp.status_code == 404, resp.text
        db.expire_all()
        assert db.query(Message).filter(Message.id == "msg-alice").count() == 1

    def test_bulk_delete_cannot_reach_a_customer_row(
        self, client, db, seeded_db, owner_header
    ):
        """The dangerous door: one crafted request naming ids the operator was
        never shown. A customer row is not in this collection, so it counts as
        MISSING and survives — while the staff row in the same call still goes."""
        alice = _customer(db, "alice@test.example")
        _message(db, seq=9201, user_id=alice.id, mid="msg-alice")
        _message(db, seq=9202, user_id=None, mid="msg-staff", mtype="contact")
        db.commit()
        resp = client.post(
            "/api/admin/messages/bulk-delete",
            json={"ids": ["msg-alice", "msg-staff"]},
            headers=owner_header,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"deleted": 1, "missing": 1}
        db.expire_all()
        assert db.query(Message).filter(Message.id == "msg-alice").count() == 1
        assert db.query(Message).filter(Message.id == "msg-staff").count() == 0

    def test_the_public_form_rows_the_staff_inbox_exists_for_still_arrive(
        self, client, db, seeded_db, auth_header
    ):
        """The fix must narrow the inbox, not empty it: every public submission
        carries user_id NULL and is exactly what staff are there to answer."""
        client.post(
            "/api/contact",
            json={
                "name": "James Chirichella",
                "email": "James@example.com",
                "subject": "Stock question",
                "message": "Do you carry the LM7805?",
            },
        )
        resp = client.get("/api/admin/messages/", headers=auth_header())
        assert resp.status_code == 200
        assert any(row["type"] == "contact" for row in resp.json())
