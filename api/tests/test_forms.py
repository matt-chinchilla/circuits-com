"""Tests for /api/contact and /api/join form endpoints."""
from unittest.mock import patch, AsyncMock


def test_contact_form_valid(client):
    """POST /api/contact with valid data returns 200 and status ok."""
    payload = {
        "name": "Alice Smith",
        "email": "alice@example.com",
        "subject": "Test inquiry",
        "message": "Hello, this is a test message.",
    }
    with patch("app.routes.forms.httpx.AsyncClient") as mock_client_class:
        mock_async_client = AsyncMock()
        mock_async_client.post = AsyncMock()
        mock_client_class.return_value.__aenter__ = AsyncMock(return_value=mock_async_client)
        mock_client_class.return_value.__aexit__ = AsyncMock(return_value=False)

        response = client.post("/api/contact", json=payload)

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_contact_form_invalid_email(client):
    """POST /api/contact with invalid email returns 422."""
    payload = {
        "name": "Bob Jones",
        "email": "not-an-email",
        "subject": "Test",
        "message": "Test message",
    }
    response = client.post("/api/contact", json=payload)
    assert response.status_code == 422


def test_join_form_valid(client):
    """POST /api/join with valid data returns 200."""
    payload = {
        "company_name": "Acme Electronics",
        "contact_person": "Jane Doe",
        "email": "jane@acme.com",
        "phone": "555-123-4567",
        "website": "https://acme.com",
        "categories_of_interest": ["Integrated Circuits"],
        "message": "We want to join.",
    }
    with patch("app.routes.forms.httpx.AsyncClient") as mock_client_class:
        mock_async_client = AsyncMock()
        mock_async_client.post = AsyncMock()
        mock_client_class.return_value.__aenter__ = AsyncMock(return_value=mock_async_client)
        mock_client_class.return_value.__aexit__ = AsyncMock(return_value=False)

        response = client.post("/api/join", json=payload)

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
