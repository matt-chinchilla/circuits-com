"""Sales quotes — the service against a scripted Stripe, the routes against
a monkeypatched service.

The service tests drive real httpx through ``MockTransport``: every branch the
code takes (customer reuse, lazy coupon mint, conflict-verify, the finalize
self-check-and-cancel) is proven by what the fake Stripe RECEIVED, not by what
the function claims. ``asyncio.run`` keeps them independent of pytest-asyncio
configuration.

The money invariant under test everywhere: the quote's finalized total equals
the ladder step EXACTLY — "$1,250 all-in" must never become $1,328.54.
"""

import asyncio
import json
from urllib.parse import parse_qsl

import httpx
import pytest

from app.config import settings
from app.services import stripe_quotes
from app.services.stripe_quotes import (
    QUOTE_LADDER,
    StripeApiError,
    create_sponsor_quote,
    lookup_keys_for,
    make_client,
)

ADDRESS = {"line1": "1 Main St", "city": "Lake Ronkonkoma", "state": "NY", "postal_code": "11779"}


class FakeStripe:
    """Just enough of Stripe's REST surface, with a request tape.

    ``urls`` records the FULL request URL — the encoding defect (a raw ``+``
    reaching Stripe and decoding as a space) was invisible while the fake
    ignored query strings, so this fake reads them the way Stripe would:
    ``/v1/customers`` actually filters on the decoded ``email`` param."""

    def __init__(self):
        self.tape: list[tuple[str, str, dict]] = []
        self.urls: list[str] = []
        self.customers: list[dict] = []  # rows: {id, email, metadata}
        self.quote_rows: list[dict] = []
        self.quote_metadata: dict = {"managed_by": "circuits-com"}
        self.coupon_exists = False
        self.existing_coupon_amount: int | None = None
        self.existing_coupon_duration = "forever"
        self.cancel_fails = False
        self.finalized_total: int | None = None  # None → echo the "right" total
        self.right_total = 0

    def form(self, request: httpx.Request) -> dict:
        return dict(parse_qsl(request.content.decode()))

    def handler(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.tape.append((method, path, self.form(request)))
        self.urls.append(str(request.url))

        if request.url.host == "files.stripe.com":
            return httpx.Response(200, content=b"%PDF-1.7 fake")

        if method == "GET" and path == "/v1/prices":
            keys = request.url.params.get_list("lookup_keys[]")
            return httpx.Response(
                200,
                json={"data": [{"id": f"price_{k}", "lookup_key": k} for k in keys]},
            )
        if method == "GET" and path == "/v1/customers":
            wanted = request.url.params.get("email")
            rows = [c for c in self.customers if c.get("email") == wanted]
            return httpx.Response(200, json={"data": rows})
        if method == "POST" and path == "/v1/customers":
            return httpx.Response(200, json={"id": "cus_new"})
        if method == "POST" and path.startswith("/v1/customers/"):
            return httpx.Response(200, json={"id": path.rsplit("/", 1)[1]})
        if method == "POST" and path == "/v1/coupons":
            if self.coupon_exists:
                return httpx.Response(
                    400,
                    json={"error": {"message": "Coupon already exists.", "code": "resource_already_exists"}},
                )
            return httpx.Response(200, json={"id": self.form(request).get("id")})
        if method == "GET" and path.startswith("/v1/coupons/"):
            return httpx.Response(
                200,
                json={
                    "id": path.rsplit("/", 1)[1],
                    "amount_off": self.existing_coupon_amount,
                    "duration": self.existing_coupon_duration,
                    "currency": "usd",
                },
            )
        if method == "POST" and path == "/v1/quotes":
            return httpx.Response(200, json={"id": "qt_testquote0001", "status": "draft"})
        if method == "POST" and path.endswith("/finalize"):
            total = self.right_total if self.finalized_total is None else self.finalized_total
            return httpx.Response(
                200,
                json={"id": "qt_testquote0001", "number": "QT-0001", "status": "open", "amount_total": total},
            )
        if method == "POST" and path.endswith("/cancel"):
            if self.cancel_fails:
                return httpx.Response(500, json={"error": {"message": "cancel exploded"}})
            return httpx.Response(200, json={"id": "qt_testquote0001", "status": "canceled"})
        if method == "GET" and path.startswith("/v1/quotes/"):
            return httpx.Response(
                200, json={"id": path.rsplit("/", 1)[1], "metadata": self.quote_metadata}
            )
        if method == "POST" and path.endswith("/accept"):
            return httpx.Response(
                200, json={"id": path.split("/")[3], "status": "accepted", "subscription": "sub_42"}
            )
        if method == "GET" and path == "/v1/quotes":
            return httpx.Response(200, json={"data": self.quote_rows})
        return httpx.Response(404, json={"error": {"message": f"unrouted {method} {path}"}})


def _run(fake: FakeStripe, coro_factory):
    async def go():
        async with make_client("sk_test_x", transport=httpx.MockTransport(fake.handler)) as client:
            return await coro_factory(client)

    return asyncio.run(go())


def _quote(fake: FakeStripe, *, tier="Gold", total=300):
    fake.right_total = total * 100
    return _run(
        fake,
        lambda client: create_sponsor_quote(
            client,
            sponsor_id="sponsor-1",
            tier=tier,
            supplier_id="supplier-1",
            supplier_name="Kennedy Electronics",
            email="info@kennedy.com",
            address=ADDRESS,
            monthly_total_usd=total,
        ),
    )


def _sent(fake: FakeStripe, method: str, path: str) -> dict:
    for m, p, form in fake.tape:
        if m == method and p == path:
            return form
    raise AssertionError(f"{method} {path} never reached Stripe; tape={[(m, p) for m, p, _ in fake.tape]}")


# ── create_sponsor_quote ────────────────────────────────────────────────────


def test_discounted_quote_builds_the_exact_all_in_total():
    fake = FakeStripe()
    result = _quote(fake, tier="Gold", total=300)
    assert result["amount_total"] == 30000
    assert result["quote_id"] == "qt_testquote0001"

    quote = _sent(fake, "POST", "/v1/quotes")
    assert quote["subscription_data[metadata][sponsor_id]"] == "sponsor-1"
    assert quote["automatic_tax[enabled]"] == "true"
    assert quote["collection_method"] == "send_invoice"
    assert quote["discounts[0][coupon]"] == "GOLD-AT-300"
    assert quote["line_items[0][price]"] == "price_gold_advertising_monthly"
    assert quote["line_items[1][price]"] == "price_gold_platform_monthly"

    coupon = _sent(fake, "POST", "/v1/coupons")
    assert coupon["amount_off"] == "30000"  # (600 − 300) × 100
    assert coupon["duration"] == "forever"


def test_list_price_quote_sends_no_discount():
    fake = FakeStripe()
    _quote(fake, tier="Gold", total=600)
    quote = _sent(fake, "POST", "/v1/quotes")
    assert not any(k.startswith("discounts") for k in quote)
    assert not any(p == "/v1/coupons" for _, p, _ in fake.tape)


def test_existing_customer_is_reused_and_address_refreshed():
    fake = FakeStripe()
    fake.customers = [
        {"id": "cus_existing", "email": "info@kennedy.com", "metadata": {"supplier_id": "supplier-1"}}
    ]
    result = _quote(fake)
    assert result["customer_id"] == "cus_existing"
    update = _sent(fake, "POST", "/v1/customers/cus_existing")
    assert update["address[state]"] == "NY"
    assert update["address[country]"] == "US"


def test_shared_billing_inbox_never_overwrites_another_suppliers_customer():
    """Two suppliers legitimately share an AP email. The lookup matches on
    metadata.supplier_id, so the OTHER company's customer is left untouched
    and this supplier gets its own."""
    fake = FakeStripe()
    fake.customers = [
        {"id": "cus_other", "email": "info@kennedy.com", "metadata": {"supplier_id": "someone-else"}}
    ]
    result = _quote(fake)
    assert result["customer_id"] == "cus_new"
    assert not any(p == "/v1/customers/cus_other" for _, p, _ in fake.tape)


def test_plus_addressed_email_is_percent_encoded_in_the_lookup():
    """A raw '+' in a query string decodes server-side as a SPACE, so the
    lookup would never match and every quote would mint a duplicate customer.
    The params channel must encode it."""
    fake = FakeStripe()
    fake.customers = [
        {"id": "cus_plus", "email": "billing+ap@kennedy.com", "metadata": {"supplier_id": "supplier-1"}}
    ]
    fake.right_total = 30000
    result = _run(
        fake,
        lambda client: create_sponsor_quote(
            client,
            sponsor_id="sponsor-1",
            tier="Gold",
            supplier_id="supplier-1",
            supplier_name="Kennedy Electronics",
            email="billing+ap@kennedy.com",
            address=ADDRESS,
            monthly_total_usd=300,
        ),
    )
    # The fake filters on the DECODED email — a reused (not duplicate)
    # customer proves the round-trip survived encoding…
    assert result["customer_id"] == "cus_plus"
    # …and the wire never carried a bare '+' in the customers query.
    lookup_urls = [u for u in fake.urls if "/v1/customers?" in u]
    assert lookup_urls and all("+" not in u for u in lookup_urls)


def test_total_mismatch_cancels_the_quote_and_raises():
    """The honesty gate: a finalized total that is not the sticker must die
    server-side, never reach a customer."""
    fake = FakeStripe()
    fake.finalized_total = 132854  # the $1,328.54 the requirement forbids
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Platinum", total=1250)
    assert "canceled" in str(err.value)
    assert any(p.endswith("/cancel") for _, p, _ in fake.tape)


def test_failed_cancel_still_reports_the_mismatch_with_the_quote_id():
    """If the cleanup cancel itself fails, the error must still be the
    MISMATCH — naming the still-open quote — not a bare network error that
    reads as 'nothing happened, retry'."""
    fake = FakeStripe()
    fake.finalized_total = 132854
    fake.cancel_fails = True
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Platinum", total=1250)
    message = str(err.value)
    assert "qt_testquote0001" in message
    assert "still OPEN" in message


def test_off_ladder_target_is_refused_before_any_stripe_call():
    fake = FakeStripe()
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Gold", total=299)
    assert err.value.status == 422
    assert fake.tape == []


def test_unknown_tier_is_refused():
    fake = FakeStripe()
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Featured", total=300)
    assert err.value.status == 422


def test_coupon_conflict_with_matching_amount_is_reused():
    fake = FakeStripe()
    fake.coupon_exists = True
    fake.existing_coupon_amount = 30000
    _quote(fake, tier="Gold", total=300)
    assert _sent(fake, "POST", "/v1/quotes")["discounts[0][coupon]"] == "GOLD-AT-300"


def test_coupon_conflict_with_wrong_amount_is_an_error_not_a_discount():
    """A hand-made coupon wearing our deterministic name but the wrong amount
    would misprice the quote — refuse loudly."""
    fake = FakeStripe()
    fake.coupon_exists = True
    fake.existing_coupon_amount = 5000
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Gold", total=300)
    assert err.value.status == 409
    assert not any(p == "/v1/quotes" for _, p, _ in fake.tape)


def test_coupon_conflict_with_once_duration_is_refused():
    """Stripe defaults coupon duration to 'once': a Dashboard-made coupon with
    the RIGHT amount would discount only the first invoice and silently revert
    every renewal to list price. Amount alone is not enough to reuse."""
    fake = FakeStripe()
    fake.coupon_exists = True
    fake.existing_coupon_amount = 30000
    fake.existing_coupon_duration = "once"
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Gold", total=300)
    assert err.value.status == 409
    assert "duration" in str(err.value)


def test_accept_refuses_a_quote_this_app_did_not_create():
    fake = FakeStripe()
    fake.quote_metadata = {}
    with pytest.raises(StripeApiError) as err:
        _run(fake, lambda client: stripe_quotes.accept_quote(client, "qt_testquote0001"))
    assert err.value.status == 422
    assert not any(p.endswith("/accept") for _, p, _ in fake.tape)


def test_accept_returns_the_subscription_for_our_own_quote():
    fake = FakeStripe()
    result = _run(fake, lambda client: stripe_quotes.accept_quote(client, "qt_testquote0001"))
    assert result["subscription_id"] == "sub_42"
    assert result["status"] == "accepted"


def test_sponsor_quote_list_filters_to_this_sponsorship():
    """One supplier, many placements, one Stripe customer: the panel must see
    only ITS quotes, or 'Customer accepted' on page A can activate board B."""
    fake = FakeStripe()
    fake.customers = [
        {"id": "cus_1", "email": "info@kennedy.com", "metadata": {"supplier_id": "supplier-1"}}
    ]
    fake.quote_rows = [
        {"id": "qt_mine00000001", "number": "QT-1", "status": "open", "amount_total": 30000,
         "created": 1, "metadata": {"sponsor_id": "sponsor-1"}},
        {"id": "qt_other0000001", "number": "QT-2", "status": "open", "amount_total": 9000,
         "created": 2, "metadata": {"sponsor_id": "sponsor-OTHER"}},
    ]
    rows = _run(
        fake,
        lambda client: stripe_quotes.list_sponsor_quotes(
            client, email="info@kennedy.com", supplier_id="supplier-1", sponsor_id="sponsor-1"
        ),
    )
    assert [r["quote_id"] for r in rows] == ["qt_mine00000001"]


def test_sponsor_quote_list_is_empty_when_no_customer_matches_the_supplier():
    fake = FakeStripe()
    fake.customers = [
        {"id": "cus_other", "email": "info@kennedy.com", "metadata": {"supplier_id": "someone-else"}}
    ]
    rows = _run(
        fake,
        lambda client: stripe_quotes.list_sponsor_quotes(
            client, email="info@kennedy.com", supplier_id="supplier-1", sponsor_id="sponsor-1"
        ),
    )
    assert rows == []
    assert not any(p == "/v1/quotes" for _, p, _ in fake.tape)


def test_ladder_first_entry_is_the_list_price():
    """The service derives coupon amounts from steps[0]; a reordered ladder
    would silently misprice every discount."""
    assert QUOTE_LADDER["silver"][0] == 100
    assert QUOTE_LADDER["gold"][0] == 600
    assert QUOTE_LADDER["platinum"][0] == 2400
    for tier, steps in QUOTE_LADDER.items():
        assert steps[0] == max(steps), tier
        assert lookup_keys_for(tier) == [f"{tier}_advertising_monthly", f"{tier}_platform_monthly"]


# ── The routes ──────────────────────────────────────────────────────────────


@pytest.fixture
def stripe_key(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_route")


def test_routes_404_without_a_key(client, seeded_db, auth_header):
    headers = auth_header()
    assert client.get("/api/admin/quote-ladder", headers=headers).status_code == 404
    resp = client.post(
        f"/api/admin/sponsors/{seeded_db['sponsor'].id}/quote",
        json={"monthly_total": 300, "address": ADDRESS},
        headers=headers,
    )
    assert resp.status_code == 404


def test_quote_ladder_requires_auth(client, stripe_key):
    assert client.get("/api/admin/quote-ladder").status_code in (401, 403)


def test_quote_ladder_renders_the_single_home(client, seeded_db, auth_header, stripe_key):
    body = client.get("/api/admin/quote-ladder", headers=auth_header()).json()
    assert body["tiers"]["gold"]["list"] == 600
    assert body["tiers"]["platinum"]["steps"] == QUOTE_LADDER["platinum"]


def test_demo_session_is_refused_even_on_reads(client, db, seeded_db, stripe_key, monkeypatch):
    """Quote lists and PDFs are customers' billing documents; the public
    'See Demo' session must not read them (the calendar posture)."""
    import bcrypt

    from app.models import User

    monkeypatch.setattr(settings, "DEMO_LOGIN_ENABLED", True, raising=False)
    db.add(
        User(
            username="demo",
            password_hash=bcrypt.hashpw(b"demo", bcrypt.gensalt()).decode(),
            role="admin",
            email="demo@circuitcenter.ai",
        )
    )
    db.commit()
    token = client.post("/api/auth/demo").json()["token"]
    resp = client.get("/api/admin/quote-ladder", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "demo_account_no_billing"


def test_create_quote_uses_the_sponsor_row(client, seeded_db, auth_header, stripe_key, monkeypatch):
    seen = {}

    async def fake_create(client_, **kwargs):
        seen.update(kwargs)
        return {"quote_id": "qt_x", "number": "QT-1", "amount_total": 30000,
                "customer_id": "cus_1", "status": "open"}

    monkeypatch.setattr(stripe_quotes, "create_sponsor_quote", fake_create)
    sponsor = seeded_db["sponsor"]
    resp = client.post(
        f"/api/admin/sponsors/{sponsor.id}/quote",
        json={"monthly_total": 300, "address": ADDRESS},
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["quote_id"] == "qt_x"
    assert seen["sponsor_id"] == str(sponsor.id)
    assert seen["tier"] == "gold"  # seeded row is lowercase; service normalizes
    assert seen["email"] == "info@kennedy.com"  # supplier's email by default


def test_create_quote_surfaces_stripe_422_as_string_detail(
    client, seeded_db, auth_header, stripe_key, monkeypatch
):
    async def fake_create(client_, **kwargs):
        raise StripeApiError("$299/mo is not on the gold ladder", status=422)

    monkeypatch.setattr(stripe_quotes, "create_sponsor_quote", fake_create)
    resp = client.post(
        f"/api/admin/sponsors/{seeded_db['sponsor'].id}/quote",
        json={"monthly_total": 300, "address": ADDRESS},
        headers=auth_header(),
    )
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], str)  # apiErrorDetail contract


def test_create_quote_unknown_sponsor_is_404(client, seeded_db, auth_header, stripe_key):
    resp = client.post(
        "/api/admin/sponsors/not-a-uuid/quote",
        json={"monthly_total": 300, "address": ADDRESS},
        headers=auth_header(),
    )
    assert resp.status_code == 404


def test_accept_rejects_a_malformed_quote_id(client, seeded_db, auth_header, stripe_key):
    resp = client.post("/api/admin/quotes/../v1/charges/accept", headers=auth_header())
    assert resp.status_code in (404, 422)
    resp = client.post("/api/admin/quotes/qt_bad!id/accept", headers=auth_header())
    assert resp.status_code == 422


def test_accept_returns_the_subscription(client, seeded_db, auth_header, stripe_key, monkeypatch):
    async def fake_accept(client_, quote_id):
        return {"quote_id": quote_id, "status": "accepted", "subscription_id": "sub_42"}

    monkeypatch.setattr(stripe_quotes, "accept_quote", fake_accept)
    resp = client.post("/api/admin/quotes/qt_testquote0001/accept", headers=auth_header())
    assert resp.status_code == 200
    assert resp.json()["subscription_id"] == "sub_42"


def test_pdf_streams_as_a_download(client, seeded_db, auth_header, stripe_key, monkeypatch):
    async def fake_pdf(client_, quote_id):
        return b"%PDF-1.7 fake"

    monkeypatch.setattr(stripe_quotes, "quote_pdf", fake_pdf)
    resp = client.get("/api/admin/quotes/qt_testquote0001/pdf", headers=auth_header())
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert "attachment" in resp.headers["content-disposition"]
    assert resp.content.startswith(b"%PDF")


def test_sponsor_quotes_route_scopes_to_supplier_and_sponsor(
    client, seeded_db, auth_header, stripe_key, monkeypatch
):
    sponsor = seeded_db["sponsor"]
    seen = {}

    async def fake_list(client_, *, email, supplier_id, sponsor_id):
        seen.update(email=email, supplier_id=supplier_id, sponsor_id=sponsor_id)
        return [{"quote_id": "qt_testquote0001", "number": "QT-0001", "status": "open",
                 "amount_total": 30000, "created": 1}]

    monkeypatch.setattr(stripe_quotes, "list_sponsor_quotes", fake_list)
    resp = client.get(f"/api/admin/sponsors/{sponsor.id}/quotes", headers=auth_header())
    assert resp.status_code == 200
    assert resp.json()["quotes"][0]["number"] == "QT-0001"
    assert seen == {
        "email": "info@kennedy.com",
        "supplier_id": str(sponsor.supplier_id),
        "sponsor_id": str(sponsor.id),
    }


def test_pdf_and_ladder_run_end_to_end_against_mock_transport(client, seeded_db, auth_header, stripe_key, monkeypatch):
    """One route exercised WITHOUT monkeypatching the service — the transport
    is swapped instead, so route→service→httpx wiring is proven whole."""
    fake = FakeStripe()

    def patched_make_client(secret_key, transport=None):
        return httpx.AsyncClient(
            base_url=stripe_quotes.STRIPE_API,
            headers={"Authorization": f"Bearer {secret_key}"},
            transport=httpx.MockTransport(fake.handler),
        )

    monkeypatch.setattr(stripe_quotes, "make_client", patched_make_client)
    resp = client.get("/api/admin/quotes/qt_testquote0001/pdf", headers=auth_header())
    assert resp.status_code == 200
    assert resp.content == b"%PDF-1.7 fake"


def test_quote_id_pattern_never_escapes_the_path():
    """Belt-and-braces: the id regex admits no '/', '?', '#' or '.' — nothing
    that could re-route the interpolated Stripe URL."""
    from app.routes.admin_quotes import _QUOTE_ID

    assert _QUOTE_ID.fullmatch("qt_1AbC234xyz")
    for evil in ("qt_a/..", "qt_a?x=1", "qt_a#f", "qt_", "quote_123", "qt_" + "a" * 100):
        assert not _QUOTE_ID.fullmatch(evil), evil


def test_ladder_payload_is_json_serializable():
    json.dumps(QUOTE_LADDER)
