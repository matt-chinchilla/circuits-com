"""Tests for /api/contact, /api/join, /api/keyword-request endpoints.

The route handlers schedule email sends as FastAPI BackgroundTasks. Each
test patches services.email.* and asserts the route returned 200 + that
the correct background functions were registered with the right payload.
"""

from unittest.mock import AsyncMock, patch


def test_contact_form_valid_schedules_notification_only(client):
    """POST /api/contact returns 200 and schedules send_contact_notification."""
    payload = {
        "name": "Alice Smith",
        "email": "alice@example.com",
        "subject": "Test inquiry",
        "message": "Hello, this is a test message.",
    }
    with patch(
        "app.routes.forms.send_contact_notification", new_callable=AsyncMock
    ) as mock_notify:
        response = client.post("/api/contact", json=payload)

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    mock_notify.assert_called_once()
    sent_form = mock_notify.call_args[0][0]
    assert sent_form.email == "alice@example.com"
    assert sent_form.subject == "Test inquiry"


def test_contact_form_invalid_email(client):
    """POST /api/contact with invalid email returns 422 (Pydantic validation)."""
    payload = {
        "name": "Bob Jones",
        "email": "not-an-email",
        "subject": "Test",
        "message": "Test message",
    }
    response = client.post("/api/contact", json=payload)
    assert response.status_code == 422


def test_join_form_valid_schedules_notification_AND_autoreply(client):
    """POST /api/join schedules BOTH the notification and the auto-reply."""
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
    with patch(
        "app.routes.forms.send_join_notification", new_callable=AsyncMock
    ) as mock_notify:
        with patch(
            "app.routes.forms.send_join_autoreply", new_callable=AsyncMock
        ) as mock_autoreply:
            response = client.post("/api/join", json=payload)

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    mock_notify.assert_called_once()
    mock_autoreply.assert_called_once()
    notify_form = mock_notify.call_args[0][0]
    autoreply_form = mock_autoreply.call_args[0][0]
    assert notify_form.company_name == "Acme Electronics"
    assert autoreply_form.email == "jane@acme.com"


def test_keyword_request_valid_schedules_notification(client):
    """POST /api/keyword-request schedules send_keyword_notification."""
    payload = {
        "company_name": "Vishay",
        "email": "partnerships@vishay.com",
        "keyword": "low-noise op-amps",
        "message": "12-month commit OK.",
    }
    with patch(
        "app.routes.forms.send_keyword_notification", new_callable=AsyncMock
    ) as mock_notify:
        response = client.post("/api/keyword-request", json=payload)

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    mock_notify.assert_called_once()
    sent_form = mock_notify.call_args[0][0]
    assert sent_form.keyword == "low-noise op-amps"
