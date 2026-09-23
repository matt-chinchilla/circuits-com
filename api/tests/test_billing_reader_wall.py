"""R6 — the read-only viewer is refused customer MONEY on reads.

A viewer is staff for the console (``require_staff`` admits GETs), but card
details, invoice links, quote PDFs, live discount codes and the Needs-attention
list are customers' billing documents and bearer discounts.
``require_billing_reader`` refuses a viewer with 403 ``no_billing_access`` on
those reads; an admin or owner passes; a customer is stopped earlier by the
staff wall (403 ``staff_only``).

The routes are DISCOVERED, not listed: every GET under ``/api/admin/`` whose
path names billing, sales codes, checkout intents or quotes is walked from
``app.routes``, so a money read added later without the wall fails here the
day it is served. The only way out is the explicit ``EXEMPT`` map below, and
each entry carries its reason.
"""

import re

import pytest
from fastapi.routing import APIRoute

from app.config import settings
from app.main import app
from app.services import stripe_quotes
from app.services.auth_service import (
    NO_BILLING_ACCESS_DETAIL,
    STAFF_ONLY_DETAIL,
    require_billing_reader,
)
from tests.fake_stripe import FakeStripe

# A path segment that marks a GET as customer money.
MONEY_MARKERS = ("billing", "sales-codes", "checkout-intents", "quote")

# Money-looking GETs a viewer MAY read — each with the reason it is not
# customer data. Adding an entry is a decision, not a convenience.
EXEMPT = {
    "/api/admin/quote-ladder": (
        "list / Founder's Deal / floor arithmetic — the public price rule, no "
        "customer, invoice or code in it (pinned readable below)"
    ),
}

FAKE_PDF = b"%PDF-1.4 wall-test"


@pytest.fixture
def stripe_on(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_wall")
    fake = FakeStripe()
    monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)

    async def _pdf(client, quote_id):
        return FAKE_PDF

    monkeypatch.setattr(stripe_quotes, "quote_pdf", _pdf)
    return fake


def _money_routes() -> dict[str, APIRoute]:
    found: dict[str, APIRoute] = {}
    for route in app.routes:
        if not isinstance(route, APIRoute) or "GET" not in route.methods:
            continue
        path = route.path
        if not path.startswith("/api/admin/") or path in EXEMPT:
            continue
        if any(marker in path for marker in MONEY_MARKERS):
            found[path] = route
    return found


def _concrete(template: str, seeded_db) -> str:
    """Fill a route template's path params from the fixtures."""
    values = {
        "sponsor_id": str(seeded_db["sponsor"].id),
        "quote_id": "qt_testquote0001",
    }

    def fill(match: re.Match) -> str:
        name = match.group(1)
        assert name in values, (
            f"{template}: no fixture value for path param {{{name}}} — add one to _concrete"
        )
        return values[name]

    return re.sub(r"\{(\w+)(?::\w+)?\}", fill, template)


def _billing_reads(seeded_db) -> list[str]:
    return [_concrete(t, seeded_db) for t in sorted(_money_routes())]


def test_discovery_finds_the_known_money_reads():
    """A guard on the guard: a marker typo or a route move would otherwise
    discover nothing and every assertion below would pass vacuously."""
    assert {
        "/api/admin/sponsors/{sponsor_id}/quotes",
        "/api/admin/quotes/{quote_id}/pdf",
        "/api/admin/sponsors/{sponsor_id}/billing",
        "/api/admin/sales-codes/",
        "/api/admin/checkout-intents/attention",
    } <= set(_money_routes())


def test_viewer_is_refused_every_billing_read(client, db, seeded_db, stripe_on, viewer_header):
    viewer = viewer_header()
    for path in _billing_reads(seeded_db):
        resp = client.get(path, headers=viewer)
        assert resp.status_code == 403, (path, resp.text)
        assert resp.json()["detail"] == NO_BILLING_ACCESS_DETAIL, path


def test_customer_is_refused_by_the_staff_wall_first(
    client, db, seeded_db, stripe_on, viewer_header
):
    customer = viewer_header("user")
    for path in _billing_reads(seeded_db):
        resp = client.get(path, headers=customer)
        assert resp.status_code == 403, path
        assert resp.json()["detail"] == STAFF_ONLY_DETAIL, path


# What each money read answers an acting staff member with: a JSON key of its
# payload, or the PDF itself. A newly discovered route must be added here too.
PASS_THROUGH = {
    "/api/admin/sponsors/{sponsor_id}/quotes": "quotes",
    "/api/admin/quotes/{quote_id}/pdf": FAKE_PDF,
    "/api/admin/sponsors/{sponsor_id}/billing": "configured",
    "/api/admin/sales-codes/": "codes",
    "/api/admin/checkout-intents/attention": "failing",
}


@pytest.mark.parametrize("role", ["admin", "owner"])
def test_acting_staff_pass_the_wall(client, db, seeded_db, stripe_on, viewer_header, role):
    """They reach the handler and it answers: the quote list (no Stripe
    customer → empty), the PDF, the billing read (no subscription is a 200
    with ``needs_resolution``), the codes list and the attention list."""
    headers = viewer_header(role)
    for template in sorted(_money_routes()):
        assert template in PASS_THROUGH, f"{template}: add its expected answer to PASS_THROUGH"
        path = _concrete(template, seeded_db)
        resp = client.get(path, headers=headers)
        assert resp.status_code == 200, (path, resp.text)
        expected = PASS_THROUGH[template]
        if isinstance(expected, bytes):
            assert resp.content == expected, path
            assert resp.headers["content-type"].startswith("application/pdf"), path
        else:
            assert expected in resp.json(), (path, resp.text)


def test_the_quote_ladder_stays_readable_by_a_viewer(
    client, db, seeded_db, stripe_on, viewer_header
):
    """List / Founder's Deal / floor arithmetic is not customer data."""
    assert client.get("/api/admin/quote-ladder", headers=viewer_header()).status_code == 200


def test_every_exemption_is_still_served():
    """A stale exemption would silently re-admit a future route of that path."""
    served = {r.path for r in app.routes if isinstance(r, APIRoute)}
    for path in EXEMPT:
        assert path in served, f"EXEMPT names {path}, which is no longer served"


def _gate_calls(route: APIRoute) -> set:
    seen, stack = set(), list(route.dependant.dependencies)
    while stack:
        dep = stack.pop()
        if dep.call is not None:
            seen.add(dep.call)
        stack.extend(dep.dependencies)
    return seen


def test_every_billing_read_carries_the_reader_wall_by_identity():
    for path, route in _money_routes().items():
        assert require_billing_reader in _gate_calls(route), path
