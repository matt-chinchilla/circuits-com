"""Tests for /api/admin/messages — admin inbox CRUD.

Backend Phase 4: persists every public-form submission into the messages
table so the admin inbox shows real rows instead of localStorage seeds.
"""

import uuid
from datetime import UTC, datetime, timedelta

import bcrypt
import pytest

from app.models import Message, User

DEMO_EMAIL = "demo@circuitcenter.ai"


@pytest.fixture
def demo_header(client, db, seeded_db):
    """A live demo session — minted the only way a visitor can get one.

    `POST /api/auth/demo` hands a real admin session to any anonymous visitor,
    so the delete routes have to refuse it server-side.
    """
    db.add(
        User(
            username="demo",
            password_hash=bcrypt.hashpw(b"demo", bcrypt.gensalt()).decode(),
            role="admin",
            email=DEMO_EMAIL,
        )
    )
    db.commit()
    resp = client.post("/api/auth/demo")
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _auth_header(client):
    resp = client.post(
        "/api/auth/login",
        json={"email": "admin@test.example", "password": "testpass123"},
    )
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _insert_message(
    db,
    *,
    seq: int,
    type: str = "contact",
    payload: dict | None = None,
    status: str = "new",
    created_at: datetime | None = None,
    assigned_to: str | None = None,
    read_at: datetime | None = None,
    responded_at: datetime | None = None,
) -> Message:
    msg = Message(
        id=str(uuid.uuid4()),
        type=type,
        status=status,
        seq=seq,
        payload=payload
        or {
            "name": "Test User",
            "email": "test@example.com",
            "subject": "Test",
            "message": "Hello",
        },
        created_at=created_at or datetime.now(UTC),
        read_at=read_at,
        responded_at=responded_at,
        assigned_to=assigned_to,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return msg


class TestListMessages:
    def test_list_empty(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.get("/api/admin/messages/", headers=headers)
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_returns_messages_in_created_at_desc_order(self, client, seeded_db, db):
        # Insert oldest → newest
        now = datetime.now(UTC)
        _insert_message(db, seq=1, created_at=now - timedelta(hours=2))
        _insert_message(db, seq=2, created_at=now - timedelta(hours=1))
        _insert_message(db, seq=3, created_at=now)

        headers = _auth_header(client)
        resp = client.get("/api/admin/messages/", headers=headers)
        assert resp.status_code == 200
        rows = resp.json()
        assert len(rows) == 3
        # Most recent first
        assert [r["seq"] for r in rows] == [3, 2, 1]

    def test_list_requires_auth(self, client, seeded_db):
        resp = client.get("/api/admin/messages/")
        assert resp.status_code == 401

    def test_list_includes_nested_payload(self, client, seeded_db, db):
        _insert_message(
            db,
            seq=1,
            type="contact",
            payload={
                "name": "Ada Lovelace",
                "email": "ada@example.test",
                "subject": "Bug",
                "message": "Found a glitch",
                "reason": "general",
            },
        )
        headers = _auth_header(client)
        resp = client.get("/api/admin/messages/", headers=headers)
        rows = resp.json()
        assert len(rows) == 1
        msg = rows[0]
        assert msg["type"] == "contact"
        assert msg["payload"]["name"] == "Ada Lovelace"
        assert msg["payload"]["reason"] == "general"


class TestGetMessage:
    def test_get_missing_returns_404(self, client, seeded_db):
        headers = _auth_header(client)
        fake_id = str(uuid.uuid4())
        resp = client.get(f"/api/admin/messages/{fake_id}", headers=headers)
        assert resp.status_code == 404

    def test_get_returns_full_message_with_payload(self, client, seeded_db, db):
        msg = _insert_message(
            db,
            seq=42,
            type="join",
            payload={
                "company_name": "Acme Co",
                "contact_person": "Wile E. Coyote",
                "email": "wile@example.invalid",
                "phone": "555-0100",
                "categories_of_interest": ["passives", "ics"],
                "tier": "gold",
            },
        )
        headers = _auth_header(client)
        resp = client.get(f"/api/admin/messages/{msg.id}", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == msg.id
        assert data["seq"] == 42
        assert data["type"] == "join"
        assert data["payload"]["company_name"] == "Acme Co"
        assert data["payload"]["categories_of_interest"] == ["passives", "ics"]

    def test_get_requires_auth(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        resp = client.get(f"/api/admin/messages/{msg.id}")
        assert resp.status_code == 401


class TestPatchMessage:
    def test_patch_status_read_sets_read_at(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1, status="new")
        assert msg.read_at is None

        headers = _auth_header(client)
        resp = client.patch(
            f"/api/admin/messages/{msg.id}",
            json={"status": "read"},
            headers=headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "read"
        assert data["read_at"] is not None

    def test_patch_status_read_does_not_overwrite_existing_read_at(self, client, seeded_db, db):
        prior_read = datetime.now(UTC) - timedelta(days=2)
        msg = _insert_message(db, seq=1, status="read", read_at=prior_read)

        headers = _auth_header(client)
        resp = client.patch(
            f"/api/admin/messages/{msg.id}",
            json={"status": "read"},
            headers=headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        # read_at should still be the original timestamp (not now). SQLite drops
        # tz info on round-trip, so compare naive seconds-since-epoch instead.
        returned = datetime.fromisoformat(data["read_at"].replace("Z", "+00:00"))
        if returned.tzinfo is None:
            returned = returned.replace(tzinfo=UTC)
        assert abs((returned - prior_read).total_seconds()) < 1

    def test_patch_status_responded_sets_responded_at(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1, status="new")
        assert msg.responded_at is None

        headers = _auth_header(client)
        resp = client.patch(
            f"/api/admin/messages/{msg.id}",
            json={"status": "responded"},
            headers=headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "responded"
        assert data["responded_at"] is not None

    def test_patch_status_responded_does_not_overwrite_existing(self, client, seeded_db, db):
        prior = datetime.now(UTC) - timedelta(days=1)
        msg = _insert_message(db, seq=1, status="responded", responded_at=prior)

        headers = _auth_header(client)
        resp = client.patch(
            f"/api/admin/messages/{msg.id}",
            json={"status": "responded"},
            headers=headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        returned = datetime.fromisoformat(data["responded_at"].replace("Z", "+00:00"))
        if returned.tzinfo is None:
            returned = returned.replace(tzinfo=UTC)
        assert abs((returned - prior).total_seconds()) < 1

    def test_patch_assigned_to_persists(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        headers = _auth_header(client)
        resp = client.patch(
            f"/api/admin/messages/{msg.id}",
            json={"assigned_to": "Anthony"},
            headers=headers,
        )
        assert resp.status_code == 200
        assert resp.json()["assigned_to"] == "Anthony"

        # Reload and confirm persistence
        resp2 = client.get(f"/api/admin/messages/{msg.id}", headers=headers)
        assert resp2.json()["assigned_to"] == "Anthony"

    def test_patch_last_reply_body_persists(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        headers = _auth_header(client)
        resp = client.patch(
            f"/api/admin/messages/{msg.id}",
            json={"last_reply_body": "Thanks for reaching out."},
            headers=headers,
        )
        assert resp.status_code == 200
        assert resp.json()["last_reply_body"] == "Thanks for reaching out."

    def test_patch_unknown_id_returns_404(self, client, seeded_db):
        headers = _auth_header(client)
        fake_id = str(uuid.uuid4())
        resp = client.patch(
            f"/api/admin/messages/{fake_id}",
            json={"status": "read"},
            headers=headers,
        )
        assert resp.status_code == 404

    def test_patch_requires_auth(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        resp = client.patch(
            f"/api/admin/messages/{msg.id}",
            json={"status": "read"},
        )
        assert resp.status_code == 401

    def test_patch_partial_update_preserves_other_fields(self, client, seeded_db, db):
        msg = _insert_message(db, seq=7, assigned_to="Daniel")

        headers = _auth_header(client)
        resp = client.patch(
            f"/api/admin/messages/{msg.id}",
            json={"status": "read"},
            headers=headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "read"
        # assigned_to preserved across the partial update
        assert data["assigned_to"] == "Daniel"


class TestDeleteMessage:
    """DELETE /api/admin/messages/{id} — the inbox's row-level delete."""

    def test_delete_removes_the_row(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        headers = _auth_header(client)

        resp = client.delete(f"/api/admin/messages/{msg.id}", headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}

        assert client.get(f"/api/admin/messages/{msg.id}", headers=headers).status_code == 404
        assert db.query(Message).count() == 0

    def test_delete_leaves_other_rows_alone(self, client, seeded_db, db):
        keep = _insert_message(db, seq=1)
        drop = _insert_message(db, seq=2)
        headers = _auth_header(client)

        assert client.delete(f"/api/admin/messages/{drop.id}", headers=headers).status_code == 200

        remaining = db.query(Message).all()
        assert [m.id for m in remaining] == [keep.id]

    def test_delete_unknown_id_returns_404(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.delete(f"/api/admin/messages/{uuid.uuid4()}", headers=headers)
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Message not found"

    def test_delete_is_idempotent_only_once(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        headers = _auth_header(client)

        assert client.delete(f"/api/admin/messages/{msg.id}", headers=headers).status_code == 200
        assert client.delete(f"/api/admin/messages/{msg.id}", headers=headers).status_code == 404

    def test_delete_requires_auth(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        resp = client.delete(f"/api/admin/messages/{msg.id}")
        assert resp.status_code == 401
        assert db.query(Message).count() == 1

    def test_demo_account_cannot_delete(self, client, seeded_db, db, demo_header):
        msg = _insert_message(db, seq=1)

        resp = client.delete(f"/api/admin/messages/{msg.id}", headers=demo_header)
        assert resp.status_code == 403
        assert resp.json()["detail"] == "demo_account_read_only"
        # The REAL row is untouched — the demo never reaches the table.
        assert db.query(Message).count() == 1


class TestBulkDeleteMessages:
    """POST /api/admin/messages/bulk-delete — multi-select delete."""

    URL = "/api/admin/messages/bulk-delete"

    def test_bulk_delete_removes_every_named_row(self, client, seeded_db, db):
        msgs = [_insert_message(db, seq=i) for i in (1, 2, 3)]
        headers = _auth_header(client)

        resp = client.post(self.URL, json={"ids": [m.id for m in msgs]}, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"deleted": 3, "missing": 0}
        assert db.query(Message).count() == 0

    def test_bulk_delete_splits_known_from_unknown(self, client, seeded_db, db):
        known = [_insert_message(db, seq=i) for i in (1, 2)]
        survivor = _insert_message(db, seq=3)
        headers = _auth_header(client)

        ids = [known[0].id, str(uuid.uuid4()), known[1].id, str(uuid.uuid4())]
        resp = client.post(self.URL, json={"ids": ids}, headers=headers)
        assert resp.status_code == 200
        # A stale selection list is normal, not an error.
        assert resp.json() == {"deleted": 2, "missing": 2}

        assert [m.id for m in db.query(Message).all()] == [survivor.id]

    def test_bulk_delete_empty_ids_is_a_no_op(self, client, seeded_db, db):
        _insert_message(db, seq=1)
        headers = _auth_header(client)

        resp = client.post(self.URL, json={"ids": []}, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"deleted": 0, "missing": 0}
        assert db.query(Message).count() == 1

    def test_bulk_delete_missing_ids_key_is_a_no_op(self, client, seeded_db, db):
        _insert_message(db, seq=1)
        headers = _auth_header(client)

        resp = client.post(self.URL, json={}, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"deleted": 0, "missing": 0}
        assert db.query(Message).count() == 1

    def test_bulk_delete_counts_duplicate_ids_once(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        headers = _auth_header(client)

        resp = client.post(self.URL, json={"ids": [msg.id, msg.id, msg.id]}, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"deleted": 1, "missing": 0}
        assert db.query(Message).count() == 0

    def test_bulk_delete_counts_duplicate_unknown_ids_once(self, client, seeded_db):
        headers = _auth_header(client)
        ghost = str(uuid.uuid4())

        resp = client.post(self.URL, json={"ids": [ghost, ghost]}, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"deleted": 0, "missing": 1}

    def test_bulk_delete_accepts_exactly_the_cap(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        headers = _auth_header(client)
        ids = [msg.id] + [str(uuid.uuid4()) for _ in range(199)]

        resp = client.post(self.URL, json={"ids": ids}, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"deleted": 1, "missing": 199}

    def test_bulk_delete_over_cap_is_422(self, client, seeded_db, db):
        _insert_message(db, seq=1)
        headers = _auth_header(client)
        ids = [str(uuid.uuid4()) for _ in range(201)]

        resp = client.post(self.URL, json={"ids": ids}, headers=headers)
        assert resp.status_code == 422
        assert resp.json()["detail"] == "too_many_ids"
        # Refused before it touched anything.
        assert db.query(Message).count() == 1

    def test_bulk_delete_requires_auth(self, client, seeded_db, db):
        msg = _insert_message(db, seq=1)
        resp = client.post(self.URL, json={"ids": [msg.id]})
        assert resp.status_code == 401
        assert db.query(Message).count() == 1

    def test_demo_account_cannot_bulk_delete(self, client, seeded_db, db, demo_header):
        msgs = [_insert_message(db, seq=i) for i in (1, 2)]

        resp = client.post(self.URL, json={"ids": [m.id for m in msgs]}, headers=demo_header)
        assert resp.status_code == 403
        assert resp.json()["detail"] == "demo_account_read_only"
        assert db.query(Message).count() == 2

    def test_bulk_delete_commits_exactly_once(self, client, seeded_db, db, monkeypatch):
        """One transaction for the batch — never a commit per id."""
        msgs = [_insert_message(db, seq=i) for i in (1, 2, 3)]
        headers = _auth_header(client)  # log in BEFORE counting commits

        commits = []
        real_commit = db.commit
        monkeypatch.setattr(db, "commit", lambda: (commits.append(1), real_commit())[1])

        resp = client.post(self.URL, json={"ids": [m.id for m in msgs]}, headers=headers)
        assert resp.status_code == 200
        assert len(commits) == 1
        assert db.query(Message).count() == 0

    def test_bulk_delete_is_all_or_nothing(self, client, seeded_db, db, monkeypatch):
        """A failed commit leaves EVERY row — no half-deleted batch."""
        msgs = [_insert_message(db, seq=i) for i in (1, 2, 3)]
        headers = _auth_header(client)

        def boom():
            raise RuntimeError("commit exploded")

        monkeypatch.setattr(db, "commit", boom)

        with pytest.raises(RuntimeError):
            client.post(self.URL, json={"ids": [m.id for m in msgs]}, headers=headers)

        monkeypatch.undo()
        db.rollback()
        assert db.query(Message).count() == 3


class TestBulkDeleteRouteOrder:
    """`/bulk-delete` must not be swallowed by the `/{message_id}` routes."""

    def test_bulk_delete_path_is_not_matched_as_a_message_id(self, client, seeded_db):
        headers = _auth_header(client)
        # If registration order were wrong this would 404 ("Message not found")
        # from a path-param route instead of running the batch handler.
        resp = client.post("/api/admin/messages/bulk-delete", json={"ids": []}, headers=headers)
        assert resp.status_code == 200
        assert resp.json() == {"deleted": 0, "missing": 0}
