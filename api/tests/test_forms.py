"""Tests for /api/contact, /api/join, /api/keyword-request endpoints.

The route handlers persist a `Message` row before scheduling the email
BackgroundTask. Each test patches services.email.* (so SMTP is never
touched) and asserts the route returned 200 + that a Message row was
written + that the background email function was registered with the
right payload.
"""

from unittest.mock import AsyncMock, patch

from app.models.message import Message


def test_contact_form_valid_persists_message_and_schedules_notification(client, db):
    """POST /api/contact persists Message + returns 200 + schedules send_contact_notification."""
    payload = {
        "name": "Alice Smith",
        "email": "alice@example.com",
        "subject": "Test inquiry",
        "message": "Hello, this is a test message.",
    }
    with patch("app.routes.forms.send_contact_notification", new_callable=AsyncMock) as mock_notify:
        response = client.post("/api/contact", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "message_id" in body

    # DB row should exist
    rows = db.query(Message).all()
    assert len(rows) == 1
    msg = rows[0]
    assert msg.id == body["message_id"]
    assert msg.type == "contact"
    assert msg.status == "new"
    assert msg.seq == 1
    assert msg.payload == {
        "name": "Alice Smith",
        "email": "alice@example.com",
        "subject": "Test inquiry",
        "message": "Hello, this is a test message.",
    }
    assert msg.read_at is None
    assert msg.responded_at is None
    assert msg.assigned_to is None

    # Email task still scheduled
    mock_notify.assert_called_once()
    sent_form = mock_notify.call_args[0][0]
    assert sent_form.email == "alice@example.com"
    assert sent_form.subject == "Test inquiry"


def test_contact_form_invalid_email_does_not_persist(client, db):
    """POST /api/contact with invalid email returns 422 and writes no Message."""
    payload = {
        "name": "Bob Jones",
        "email": "not-an-email",
        "subject": "Test",
        "message": "Test message",
    }
    response = client.post("/api/contact", json=payload)
    assert response.status_code == 422
    assert db.query(Message).count() == 0


def test_join_form_valid_persists_message_and_schedules_both_emails(client, db):
    """POST /api/join persists Message + schedules notification AND auto-reply."""
    payload = {
        "company_name": "Acme Electronics",
        "contact_person": "Jane Doe",
        "email": "jane@acme.com",
        "phone": "555-123-4567",
        "website": "https://acme.com",
        "categories_of_interest": ["Integrated Circuits"],
        "tier": "gold",
        "message": "We want to join.",
    }
    with patch("app.routes.forms.send_join_notification", new_callable=AsyncMock) as mock_notify:
        with patch(
            "app.routes.forms.send_join_autoreply", new_callable=AsyncMock
        ) as mock_autoreply:
            response = client.post("/api/join", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "message_id" in body

    rows = db.query(Message).all()
    assert len(rows) == 1
    msg = rows[0]
    assert msg.id == body["message_id"]
    assert msg.type == "join"
    assert msg.status == "new"
    assert msg.seq == 1
    # All 8 JoinForm fields end up in payload
    assert msg.payload == {
        "company_name": "Acme Electronics",
        "contact_person": "Jane Doe",
        "email": "jane@acme.com",
        "phone": "555-123-4567",
        "website": "https://acme.com",
        "categories_of_interest": ["Integrated Circuits"],
        "tier": "gold",
        "message": "We want to join.",
    }

    mock_notify.assert_called_once()
    mock_autoreply.assert_called_once()
    notify_form = mock_notify.call_args[0][0]
    autoreply_form = mock_autoreply.call_args[0][0]
    assert notify_form.company_name == "Acme Electronics"
    assert autoreply_form.email == "jane@acme.com"


def test_join_form_optional_fields_none_persist_as_null(client, db):
    """JoinForm fields website/tier/message can be None — stored as JSON null."""
    payload = {
        "company_name": "Minimal Co",
        "contact_person": "Sam",
        "email": "sam@minimal.example.com",
        "phone": "555-000-0000",
        "categories_of_interest": [],
    }
    with patch("app.routes.forms.send_join_notification", new_callable=AsyncMock):
        with patch("app.routes.forms.send_join_autoreply", new_callable=AsyncMock):
            response = client.post("/api/join", json=payload)

    assert response.status_code == 200
    msg = db.query(Message).one()
    assert msg.payload["website"] is None
    assert msg.payload["tier"] is None
    assert msg.payload["message"] is None
    assert msg.payload["categories_of_interest"] == []


def test_keyword_request_valid_persists_message_and_schedules_notification(client, db):
    """POST /api/keyword-request persists Message + schedules notification.

    V2 design parity (2026-05-16): payload now carries `name` + `tier` alongside
    the existing fields. The KeywordLandingPage's RequestModal collects both —
    `name` is required (matches the form's required-attribute) and `tier`
    reflects whichever Silver/Gold/Platinum the user picked, or None if they
    skipped the picker and submitted from a non-tier-card entry point.
    """
    payload = {
        "company_name": "Vishay",
        "email": "partnerships@vishay.com",
        "keyword": "low-noise op-amps",
        "name": "Pat Partner",
        "tier": "gold",
        "message": "12-month commit OK.",
    }
    with patch("app.routes.forms.send_keyword_notification", new_callable=AsyncMock) as mock_notify:
        response = client.post("/api/keyword-request", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "message_id" in body

    rows = db.query(Message).all()
    assert len(rows) == 1
    msg = rows[0]
    assert msg.id == body["message_id"]
    assert msg.type == "keyword"
    assert msg.status == "new"
    assert msg.seq == 1
    assert msg.payload == {
        "company_name": "Vishay",
        "email": "partnerships@vishay.com",
        "keyword": "low-noise op-amps",
        "name": "Pat Partner",
        "tier": "gold",
        "message": "12-month commit OK.",
    }

    mock_notify.assert_called_once()
    sent_form = mock_notify.call_args[0][0]
    assert sent_form.keyword == "low-noise op-amps"
    assert sent_form.name == "Pat Partner"
    assert sent_form.tier == "gold"


def test_keyword_request_optional_tier_and_message_persist_as_null(client, db):
    """KeywordRequestForm.tier and .message are both optional — stored as JSON null when absent."""
    payload = {
        "company_name": "TI",
        "email": "x@ti.example.com",
        "keyword": "buck converter",
        "name": "Riley TI",
    }
    with patch("app.routes.forms.send_keyword_notification", new_callable=AsyncMock):
        response = client.post("/api/keyword-request", json=payload)

    assert response.status_code == 200
    msg = db.query(Message).one()
    assert msg.payload["message"] is None
    assert msg.payload["tier"] is None
    assert msg.payload["name"] == "Riley TI"


def test_keyword_request_invalid_tier_returns_422(client, db):
    """KeywordRequestForm.tier is a Literal enum — bogus values must 422 at Pydantic."""
    payload = {
        "company_name": "Acme",
        "email": "a@example.com",
        "keyword": "rp2040",
        "name": "Pat",
        "tier": "platinum-plus",  # not in SponsorTier
    }
    response = client.post("/api/keyword-request", json=payload)
    assert response.status_code == 422
    assert db.query(Message).count() == 0


def test_keyword_request_missing_name_returns_422(client, db):
    """KeywordRequestForm requires `name` (mirrors the FE input's required attribute)."""
    payload = {
        "company_name": "Acme",
        "email": "a@example.com",
        "keyword": "rp2040",
        # name missing - this is what's being tested
    }
    response = client.post("/api/keyword-request", json=payload)
    assert response.status_code == 422
    assert db.query(Message).count() == 0


def test_seq_increments_across_three_contact_submissions(client, db):
    """3 contact forms in a row → seq 1, 2, 3 (no gaps)."""
    base = {
        "name": "Tester",
        "subject": "subj",
        "message": "hi",
    }
    with patch("app.routes.forms.send_contact_notification", new_callable=AsyncMock):
        for i in range(3):
            r = client.post(
                "/api/contact",
                json={**base, "email": f"t{i}@example.com"},
            )
            assert r.status_code == 200

    seqs = [m.seq for m in db.query(Message).order_by(Message.seq).all()]
    assert seqs == [1, 2, 3]


def test_seq_shares_single_space_across_form_types(client, db):
    """One contact + one join + one keyword → seq 1, 2, 3 across types."""
    contact_payload = {
        "name": "C",
        "email": "c@example.com",
        "subject": "s",
        "message": "m",
    }
    join_payload = {
        "company_name": "JCo",
        "contact_person": "J",
        "email": "j@example.com",
        "phone": "555",
        "categories_of_interest": [],
    }
    keyword_payload = {
        "company_name": "KCo",
        "email": "k@example.com",
        "keyword": "kw",
        "name": "K",
    }
    with patch("app.routes.forms.send_contact_notification", new_callable=AsyncMock):
        with patch("app.routes.forms.send_join_notification", new_callable=AsyncMock):
            with patch("app.routes.forms.send_join_autoreply", new_callable=AsyncMock):
                with patch("app.routes.forms.send_keyword_notification", new_callable=AsyncMock):
                    assert client.post("/api/contact", json=contact_payload).status_code == 200
                    assert client.post("/api/join", json=join_payload).status_code == 200
                    assert (
                        client.post("/api/keyword-request", json=keyword_payload).status_code == 200
                    )

    rows = db.query(Message).order_by(Message.seq).all()
    assert [r.seq for r in rows] == [1, 2, 3]
    assert [r.type for r in rows] == ["contact", "join", "keyword"]


def test_join_form_missing_required_field_does_not_persist(client, db):
    """JoinForm missing required `email` returns 422 and writes no Message."""
    payload = {
        "company_name": "Acme",
        "contact_person": "Jane",
        "phone": "555",
        "categories_of_interest": [],
        # email missing
    }
    response = client.post("/api/join", json=payload)
    assert response.status_code == 422
    assert db.query(Message).count() == 0


def test_keyword_request_missing_required_field_does_not_persist(client, db):
    """KeywordRequestForm missing required `keyword` returns 422 and writes no Message."""
    payload = {
        "company_name": "Acme",
        "email": "a@example.com",
        # keyword missing
    }
    response = client.post("/api/keyword-request", json=payload)
    assert response.status_code == 422
    assert db.query(Message).count() == 0
