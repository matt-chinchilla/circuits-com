"""Tests for POST /api/sponsor-rep-request endpoint (CSB v13, commit 1).

Mirrors the pattern in tests/test_forms.py — patches the email-notification
helper at the route module's import site (NOT services.email) so the
BackgroundTask never reaches SMTP, then asserts the Message row was
persisted and the request_id matches the CS-XXXXXX format.

All emails use @example.com so GitGuardian doesn't flag the fixture.
"""

import re
import uuid
from unittest.mock import AsyncMock, patch

import pytest

from app.models import Category, Sponsor, Supplier
from app.models.message import Message


@pytest.fixture
def create_sponsor_for_category(db):
    """Seed one supplier + one category + one Active sponsor on it.

    Returns the Sponsor row (with FK relationships flushed) so each test
    can POST against /api/sponsor-rep-request with a real sponsor_id.
    """
    supplier = Supplier(
        id=uuid.uuid4(),
        name="Rep-Test Distributor",
        phone="555-000-1212",
        website="repdist.example.com",
        email="info@repdist.example.com",
    )
    category = Category(
        id=uuid.uuid4(),
        name="Rep Test Category",
        slug="rep-test-category",
        icon="lightning",
        sort_order=0,
    )
    db.add_all([supplier, category])
    db.flush()

    sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=supplier.id,
        category_id=category.id,
        image_url="/rep-sponsor.jpg",
        description="Rep request sponsor seed",
        tier="gold",
        status="Active",
    )
    db.add(sponsor)
    db.commit()
    db.refresh(sponsor)
    return sponsor


def test_happy_path_returns_request_id(client, create_sponsor_for_category):
    """POST returns 200 + {request_id: 'CS-XXXXXX'} matching /^CS-[0-9A-F]{6}$/."""
    sponsor = create_sponsor_for_category
    payload = {
        "sponsor_id": str(sponsor.id),
        "name": "Pat Requester",
        "email": "rep+sponsor@example.com",
        "note": "Please reach out about volume pricing.",
    }
    with patch(
        "app.routes.sponsor_rep_requests.send_sponsor_rep_notification",
        new_callable=AsyncMock,
    ):
        response = client.post("/api/sponsor-rep-request", json=payload)

    assert response.status_code == 200, response.text
    body = response.json()
    assert "request_id" in body
    assert re.match(r"^CS-[0-9A-F]{6}$", body["request_id"]), body["request_id"]


def test_persists_message_row(client, db, create_sponsor_for_category):
    """POST writes a Message row with type='sponsor_rep_request'."""
    sponsor = create_sponsor_for_category
    payload = {
        "sponsor_id": str(sponsor.id),
        "name": "Sam Buyer",
        "email": "rep+sponsor@example.com",
        "note": "Hello",
    }
    with patch(
        "app.routes.sponsor_rep_requests.send_sponsor_rep_notification",
        new_callable=AsyncMock,
    ):
        response = client.post("/api/sponsor-rep-request", json=payload)

    assert response.status_code == 200, response.text
    rows = db.query(Message).all()
    assert len(rows) == 1
    msg = rows[0]
    assert msg.type == "sponsor_rep_request"


def test_unknown_sponsor_id_returns_404(client, db):
    """POST with a UUID that does not exist returns 404 and writes no Message."""
    payload = {
        "sponsor_id": str(uuid.uuid4()),
        "name": "Pat Requester",
        "email": "rep+sponsor@example.com",
        "note": "n/a",
    }
    with patch(
        "app.routes.sponsor_rep_requests.send_sponsor_rep_notification",
        new_callable=AsyncMock,
    ):
        response = client.post("/api/sponsor-rep-request", json=payload)

    assert response.status_code == 404
    assert db.query(Message).count() == 0


def test_invalid_email_returns_422(client, db, create_sponsor_for_category):
    """Pydantic EmailStr validation rejects malformed addresses (422)."""
    sponsor = create_sponsor_for_category
    payload = {
        "sponsor_id": str(sponsor.id),
        "name": "Pat Requester",
        "email": "not-an-email",
        "note": "anything",
    }
    response = client.post("/api/sponsor-rep-request", json=payload)
    assert response.status_code == 422
    assert db.query(Message).count() == 0


def test_schedules_email_notification(client, create_sponsor_for_category):
    """BackgroundTask schedules send_sponsor_rep_notification(sponsor_data, payload, request_id).

    The route materializes ORM data into primitives BEFORE scheduling the task
    so the background path is ORM-detachment-free. Assert that contract here.
    """
    sponsor = create_sponsor_for_category
    payload = {
        "sponsor_id": str(sponsor.id),
        "name": "Pat Requester",
        "email": "rep+sponsor@example.com",
        "note": "Please connect us.",
    }
    with patch(
        "app.routes.sponsor_rep_requests.send_sponsor_rep_notification",
        new_callable=AsyncMock,
    ) as mock_notify:
        response = client.post("/api/sponsor-rep-request", json=payload)

    assert response.status_code == 200, response.text
    mock_notify.assert_called_once()
    sponsor_data, requester_payload, request_id = mock_notify.call_args.args
    # sponsor_data is a primitive dict, NOT the ORM instance — every value
    # plain-typed so a detached SQLAlchemy session can't strand the task.
    assert isinstance(sponsor_data, dict)
    assert sponsor_data["company_name"] == sponsor.supplier.name
    assert sponsor_data["contact_name"] == sponsor.contact_name
    assert requester_payload == {
        "name": "Pat Requester",
        "email": "rep+sponsor@example.com",
        "note": "Please connect us.",
    }
    assert request_id.startswith("CS-")
    assert len(request_id) == 9  # "CS-" + 6 hex chars
