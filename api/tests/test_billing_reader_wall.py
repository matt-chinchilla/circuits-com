"""R6 — the read-only viewer is refused customer MONEY on reads.

A viewer is staff for the console (``require_staff`` admits GETs), but card
details, invoice links, quote PDFs and live discount codes are customers'
billing documents and bearer discounts. ``require_billing_reader`` refuses a
viewer with 403 ``no_billing_access`` on those reads; an admin or owner
passes; a customer is stopped earlier by the staff wall (403 ``staff_only``).

The walk at the bottom pins WHICH routes carry the reader wall by function
identity, so a billing read added later without it fails here.
"""

import uuid
from datetime import UTC, datetime

import pytest
from fastapi.routing import APIRoute

from app.config import settings
from app.main import app
from app.models import User
from app.services import stripe_quotes
from app.services.auth_service import (
    NO_BILLING_ACCESS_DETAIL,
    STAFF_ONLY_DETAIL,
    create_token,
    require_billing_reader,
)
from tests.fake_stripe import FakeStripe


def _header_for(db, role: str) -> dict[str, str]:
    user = User(
        id=uuid.uuid4(),
        username=f"{role}-{uuid.uuid4().hex[:6]}",
        email=f"{role}-{uuid.uuid4().hex[:6]}@test.example",
        password_hash="x",
        role=role,
        email_verified_at=datetime.now(UTC),
    )
    db.add(user)
    db.commit()
    return {"Authorization": f"Bearer {create_token(str(user.id), role)}"}


@pytest.fixture
def stripe_on(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_wall")
    fake = FakeStripe()
    monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)
    return fake


def _billing_reads(seeded_db) -> list[str]:
    sid = seeded_db["sponsor"].id
    return [
        f"/api/admin/sponsors/{sid}/quotes",
        "/api/admin/quotes/qt_testquote0001/pdf",
        f"/api/admin/sponsors/{sid}/billing",
        "/api/admin/sales-codes/",
    ]


def test_viewer_is_refused_every_billing_read(client, db, seeded_db, stripe_on):
    viewer = _header_for(db, "viewer")
    for path in _billing_reads(seeded_db):
        resp = client.get(path, headers=viewer)
        assert resp.status_code == 403, path
        assert resp.json()["detail"] == NO_BILLING_ACCESS_DETAIL, path


def test_customer_is_refused_by_the_staff_wall_first(client, db, seeded_db, stripe_on):
    customer = _header_for(db, "user")
    for path in _billing_reads(seeded_db):
        resp = client.get(path, headers=customer)
        assert resp.status_code == 403, path
        assert resp.json()["detail"] == STAFF_ONLY_DETAIL, path


@pytest.mark.parametrize("role", ["admin", "owner"])
def test_acting_staff_pass_the_wall(client, db, seeded_db, stripe_on, role):
    """They reach the handler: the quote list answers (no Stripe customer →
    empty), the PDF streams, the codes list answers, and the billing read
    answers too (no subscription is a 200 with ``needs_resolution``)."""
    headers = _header_for(db, role)
    for path in _billing_reads(seeded_db):
        resp = client.get(path, headers=headers)
        assert resp.status_code != 403, (path, resp.text)


def test_the_quote_ladder_stays_readable_by_a_viewer(client, db, seeded_db, stripe_on):
    """List / Founder's Deal / floor arithmetic is not customer data."""
    viewer = _header_for(db, "viewer")
    assert client.get("/api/admin/quote-ladder", headers=viewer).status_code == 200


# Every GET that returns a customer's billing documents or live codes. A new
# one must be named here AND carry the wall — the walk proves the second.
WALLED_READS = {
    ("GET", "/api/admin/sponsors/{sponsor_id}/quotes"),
    ("GET", "/api/admin/quotes/{quote_id}/pdf"),
    ("GET", "/api/admin/sponsors/{sponsor_id}/billing"),
    ("GET", "/api/admin/sales-codes/"),
}


def _gate_calls(route: APIRoute) -> set:
    seen, stack = set(), list(route.dependant.dependencies)
    while stack:
        dep = stack.pop()
        if dep.call is not None:
            seen.add(dep.call)
        stack.extend(dep.dependencies)
    return seen


def test_every_billing_read_carries_the_reader_wall_by_identity():
    found = {}
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in route.methods:
                found[(method, route.path)] = route
    for key in WALLED_READS:
        assert key in found, f"{key} is not served"
        assert require_billing_reader in _gate_calls(found[key]), key
