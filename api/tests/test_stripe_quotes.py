"""Sales quotes — the service against the shared in-memory Stripe, the routes
against a monkeypatched service (and, twice, the same fake behind the route).

The service tests drive real httpx through ``tests/fake_stripe.FakeStripe``:
every branch the code takes (customer reuse, lazy coupon mint, conflict-verify,
the finalize self-check-and-cancel) is proven by what the fake Stripe RECEIVED,
not by what the function claims. The fake COMPUTES a quote's total from the
prices and the coupon it was sent, filters ``/v1/customers`` on the decoded
``email`` query param, and asserts the pinned ``Stripe-Version`` on every call
— a weaker private fake that echoed a pre-set "right" total hid all three.
``asyncio.run`` keeps them independent of pytest-asyncio configuration.

The money invariant under test everywhere: the quote's finalized total equals
the rule's price EXACTLY — "$1,850 all-in" must never become $1,928.54.
"""

import asyncio
import json

import pytest

from app.config import settings
from app.services import sales_pricing, stripe_quotes
from app.services.stripe_quotes import (
    QUOTE_LADDER,
    StripeApiError,
    create_sponsor_quote,
    lookup_keys_for,
)
from tests.fake_stripe import FakeStripe

ADDRESS = {"line1": "1 Main St", "city": "Lake Ronkonkoma", "state": "NY", "postal_code": "11779"}


def _run(fake: FakeStripe, coro_factory):
    async def go():
        async with fake.client() as client:
            return await coro_factory(client)

    return asyncio.run(go())


def _quote(fake: FakeStripe, *, tier="Gold", pts=10, email="info@kennedy.com"):
    return _run(
        fake,
        lambda client: create_sponsor_quote(
            client,
            sponsor_id="sponsor-1",
            tier=tier,
            supplier_id="supplier-1",
            supplier_name="Kennedy Electronics",
            email=email,
            address=ADDRESS,
            code_points=pts,
        ),
    )


def _only_quote(fake: FakeStripe) -> str:
    assert len(fake.quotes) == 1, list(fake.quotes)
    return next(iter(fake.quotes))


def _gold_coupon(fake: FakeStripe, **overrides) -> None:
    """A pre-existing ``GOLD-AT-1850`` — by default exactly the one the rule
    would mint (65000 off, forever, USD, valid, fenced to Gold's products)."""
    kwargs = {"amount_off": 65000, "products": fake.product_ids("gold")}
    kwargs.update(overrides)
    fake.add_coupon("GOLD-AT-1850", **kwargs)


# ── create_sponsor_quote ────────────────────────────────────────────────────


def test_discounted_quote_builds_the_exact_all_in_total():
    """R12: 10 code points on Gold = the Founder's $2,100 less 10% of list =
    $1,850 — the same number /join charges for the same points."""
    fake = FakeStripe()
    result = _quote(fake, tier="Gold", pts=10)
    assert result["amount_total"] == 185000
    assert result["price_usd"] == 1850
    qid = _only_quote(fake)
    assert result["quote_id"] == qid
    assert fake.quotes[qid]["status"] == "open"

    quote = fake.last("POST", "/v1/quotes").form
    assert quote["subscription_data[metadata][sponsor_id]"] == "sponsor-1"
    assert quote["automatic_tax[enabled]"] == "true"
    assert quote["collection_method"] == "send_invoice"
    assert quote["discounts[0][coupon]"] == "GOLD-AT-1850"
    assert quote["line_items[0][price]"] == "price_gold_advertising_monthly"
    assert quote["line_items[1][price]"] == "price_gold_platform_monthly"

    coupon = fake.last("POST", "/v1/coupons").form
    assert coupon["amount_off"] == "65000"  # (2500 − 1850) × 100
    assert coupon["duration"] == "forever"
    assert coupon["name"] == "Gold Founder's Deal — $1,850/mo"
    # Fenced to the products Stripe resolved for the tier, not hard-coded ids.
    gold_adv, gold_plat = fake.product_ids("gold")
    assert coupon["applies_to[products][0]"] == gold_adv
    assert coupon["applies_to[products][1]"] == gold_plat


def test_zero_points_quotes_the_founders_deal_never_list():
    """No quote is priced at list any more (R12 / D5): 0 points IS the
    Founder's Deal, charged forever through one amount_off coupon."""
    fake = FakeStripe()
    result = _quote(fake, tier="Gold", pts=0)
    assert result["amount_total"] == 210000
    assert fake.last("POST", "/v1/quotes").form["discounts[0][coupon]"] == "GOLD-AT-2100"


def test_fifteen_points_stop_at_the_seventy_percent_floor():
    fake = FakeStripe()
    result = _quote(fake, tier="Platinum", pts=15)
    assert result["amount_total"] == 700000
    assert fake.last("POST", "/v1/quotes").form["discounts[0][coupon]"] == "PLATINUM-AT-7000"


def test_existing_customer_is_reused_and_address_refreshed():
    fake = FakeStripe()
    fake.add_customer(
        "cus_existing", email="info@kennedy.com", metadata={"supplier_id": "supplier-1"}
    )
    result = _quote(fake)
    assert result["customer_id"] == "cus_existing"
    assert fake.calls("POST", "/v1/customers") == []  # nobody was created
    update = fake.last("POST", "/v1/customers/cus_existing").form
    assert update["address[state]"] == "NY"
    assert update["address[country]"] == "US"


def test_shared_billing_inbox_never_overwrites_another_suppliers_customer():
    """Two suppliers legitimately share an AP email. The lookup matches on
    metadata.supplier_id, so the OTHER company's customer is left untouched
    and this supplier gets its own."""
    fake = FakeStripe()
    fake.add_customer("cus_other", email="info@kennedy.com", metadata={"supplier_id": "else"})
    result = _quote(fake)
    assert result["customer_id"] != "cus_other"
    created = fake.last("POST", "/v1/customers").form
    assert created["metadata[supplier_id]"] == "supplier-1"
    assert fake.calls("POST", "/v1/customers/cus_other") == []
    assert fake.customers["cus_other"]["metadata"] == {"supplier_id": "else"}


def test_plus_addressed_email_is_percent_encoded_in_the_lookup():
    """A raw '+' in a query string decodes server-side as a SPACE, so the
    lookup would never match and every quote would mint a duplicate customer.
    The params channel must encode it."""
    fake = FakeStripe()
    fake.add_customer(
        "cus_plus", email="billing+ap@kennedy.com", metadata={"supplier_id": "supplier-1"}
    )
    result = _quote(fake, email="billing+ap@kennedy.com")
    # The fake filters on the DECODED email — a reused (not duplicate)
    # customer proves the round-trip survived encoding…
    assert result["customer_id"] == "cus_plus"
    assert fake.calls("POST", "/v1/customers") == []
    # …and the wire never carried a bare '+' in the customers query.
    lookups = [u for u in fake.urls if u.startswith("https://api.stripe.com/v1/customers?")]
    assert lookups and all("+" not in u.split("?", 1)[1] for u in lookups)


def test_total_mismatch_cancels_the_quote_and_raises():
    """The honesty gate: a finalized total that is not the sticker must die
    server-side, never reach a customer."""
    fake = FakeStripe()
    fake.quote_finalize_total = 132854  # the $1,328.54 the requirement forbids
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Platinum", pts=10)
    assert "canceled" in str(err.value)
    qid = _only_quote(fake)
    assert fake.calls("POST", f"/v1/quotes/{qid}/cancel")
    assert fake.quotes[qid]["status"] == "canceled"


def test_failed_cancel_still_reports_the_mismatch_with_the_quote_id():
    """If the cleanup cancel itself fails, the error must still be the
    MISMATCH — naming the still-open quote — not a bare network error that
    reads as 'nothing happened, retry'."""
    fake = FakeStripe()
    fake.quote_finalize_total = 132854
    fake.quote_cancel_status = 500
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Platinum", pts=10)
    message = str(err.value)
    qid = _only_quote(fake)
    assert qid in message
    assert "still OPEN" in message
    assert fake.quotes[qid]["status"] == "open"


@pytest.mark.parametrize("pts", [-1, 16, 100])
def test_points_outside_the_rule_are_refused_before_any_stripe_call(pts):
    """Nothing prices a quote but the rule, and the rule stops at 15 points —
    a 16-point quote would break the 30% cap (D2)."""
    fake = FakeStripe()
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Gold", pts=pts)
    assert err.value.status == 422
    assert fake.tape == []


def test_unknown_tier_is_refused():
    fake = FakeStripe()
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Featured", pts=0)
    assert err.value.status == 422
    assert fake.tape == []


def test_coupon_conflict_with_matching_fields_is_reused():
    fake = FakeStripe()
    _gold_coupon(fake)
    result = _quote(fake, tier="Gold", pts=10)
    assert fake.last("POST", "/v1/quotes").form["discounts[0][coupon]"] == "GOLD-AT-1850"
    # The conflict was verified WITH the fence expanded, then reused as-is.
    verify = fake.last("GET", "/v1/coupons/GOLD-AT-1850")
    assert verify.params["expand[]"] == ["applies_to"]
    assert result["amount_total"] == 185000


def test_coupon_conflict_with_wrong_amount_is_an_error_not_a_discount():
    """A hand-made coupon wearing our deterministic name but the wrong amount
    would misprice the quote — refuse loudly."""
    fake = FakeStripe()
    _gold_coupon(fake, amount_off=5000)
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Gold", pts=10)
    assert err.value.status == 409
    assert fake.calls("POST", "/v1/quotes") == []


def test_coupon_conflict_with_once_duration_is_refused():
    """Stripe defaults coupon duration to 'once': a Dashboard-made coupon with
    the RIGHT amount would discount only the first invoice and silently revert
    every renewal to list price. Amount alone is not enough to reuse."""
    fake = FakeStripe()
    _gold_coupon(fake, duration="once")
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Gold", pts=10)
    assert err.value.status == 409
    assert "duration" in str(err.value)
    assert fake.calls("POST", "/v1/quotes") == []


def test_coupon_conflict_fenced_to_other_products_is_refused():
    """The right amount and duration, but fenced to Platinum's products (or to
    nothing, which discounts EVERYTHING): the discount would land on the wrong
    lines, so the name alone never makes it reusable."""
    fake = FakeStripe()
    _gold_coupon(fake, products=fake.product_ids("platinum"))
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Gold", pts=10)
    assert err.value.status == 409
    assert "applies_to" in str(err.value)
    assert fake.calls("POST", "/v1/quotes") == []

    unfenced = FakeStripe()
    _gold_coupon(unfenced, products=None)
    with pytest.raises(StripeApiError) as err:
        _quote(unfenced, tier="Gold", pts=10)
    assert err.value.status == 409
    assert unfenced.calls("POST", "/v1/quotes") == []


def test_coupon_conflict_that_is_no_longer_valid_is_refused():
    """``valid: false`` = exhausted or past its redeem_by: Stripe would reject
    the quote's discount, so reuse must stop here with a 409."""
    fake = FakeStripe()
    _gold_coupon(fake, valid=False)
    with pytest.raises(StripeApiError) as err:
        _quote(fake, tier="Gold", pts=10)
    assert err.value.status == 409
    assert "valid" in str(err.value)
    assert fake.calls("POST", "/v1/quotes") == []


def test_accept_refuses_a_quote_this_app_did_not_create():
    fake = FakeStripe()
    fake.add_quote("qt_testquote0001", metadata={})
    with pytest.raises(StripeApiError) as err:
        _run(fake, lambda client: stripe_quotes.accept_quote(client, "qt_testquote0001"))
    assert err.value.status == 422
    assert fake.calls("POST", "/v1/quotes/qt_testquote0001/accept") == []
    assert fake.quotes["qt_testquote0001"]["status"] == "open"


def test_accept_returns_the_subscription_for_our_own_quote():
    fake = FakeStripe()
    fake.add_quote("qt_testquote0001", metadata={"managed_by": "circuits-com"})
    result = _run(fake, lambda client: stripe_quotes.accept_quote(client, "qt_testquote0001"))
    assert result["status"] == "accepted"
    assert result["subscription_id"] == fake.quotes["qt_testquote0001"]["subscription"]
    assert result["subscription_id"].startswith("sub_")


def test_sponsor_quote_list_filters_to_this_sponsorship():
    """One supplier, many placements, one Stripe customer: the panel must see
    only ITS quotes, or 'Customer accepted' on page A can activate board B."""
    fake = FakeStripe()
    fake.add_customer("cus_1", email="info@kennedy.com", metadata={"supplier_id": "supplier-1"})
    fake.add_quote(
        "qt_mine00000001",
        customer="cus_1",
        number="QT-1",
        amount_total=30000,
        created=1,
        metadata={"sponsor_id": "sponsor-1"},
    )
    fake.add_quote(
        "qt_other0000001",
        customer="cus_1",
        number="QT-2",
        amount_total=9000,
        created=2,
        metadata={"sponsor_id": "sponsor-OTHER"},
    )
    fake.add_quote(  # another customer's quote for the same sponsor id
        "qt_stranger0001", customer="cus_x", metadata={"sponsor_id": "sponsor-1"}
    )
    rows = _run(
        fake,
        lambda client: stripe_quotes.list_sponsor_quotes(
            client, email="info@kennedy.com", supplier_id="supplier-1", sponsor_id="sponsor-1"
        ),
    )
    assert [r["quote_id"] for r in rows] == ["qt_mine00000001"]
    assert rows[0]["amount_total"] == 30000
    assert fake.last("GET", "/v1/quotes").params["customer"] == "cus_1"


def test_sponsor_quote_list_is_empty_when_no_customer_matches_the_supplier():
    fake = FakeStripe()
    fake.add_customer("cus_other", email="info@kennedy.com", metadata={"supplier_id": "else"})
    rows = _run(
        fake,
        lambda client: stripe_quotes.list_sponsor_quotes(
            client, email="info@kennedy.com", supplier_id="supplier-1", sponsor_id="sponsor-1"
        ),
    )
    assert rows == []
    assert fake.calls("GET", "/v1/quotes") == []


def test_quote_pdf_is_read_from_the_files_host():
    fake = FakeStripe()
    fake.add_quote("qt_testquote0001")
    pdf = _run(fake, lambda client: stripe_quotes.quote_pdf(client, "qt_testquote0001"))
    assert pdf == b"%PDF-1.7 fake"
    assert fake.urls[-1].startswith("https://files.stripe.com/v1/quotes/")
    with pytest.raises(StripeApiError) as err:
        _run(fake, lambda client: stripe_quotes.quote_pdf(client, "qt_nosuchquote01"))
    assert err.value.status == 404


def test_ladder_first_entry_is_the_list_price():
    """The service derives coupon amounts from steps[0]; a reordered ladder
    would silently misprice every discount."""
    assert QUOTE_LADDER["silver"][0] == 250
    assert QUOTE_LADDER["gold"][0] == 2500
    assert QUOTE_LADDER["platinum"][0] == 10000
    for tier, steps in QUOTE_LADDER.items():
        assert steps[0] == max(steps), tier
        assert lookup_keys_for(tier) == [f"{tier}_advertising_monthly", f"{tier}_platform_monthly"]


def test_the_ladder_holds_list_prices_only():
    """R12: the discounted steps are gone — every charged price comes from
    sales_pricing, so a stale step here could never be offered again."""
    assert QUOTE_LADDER == {"silver": [250], "gold": [2500], "platinum": [10000]}


# ── The routes ──────────────────────────────────────────────────────────────


@pytest.fixture
def stripe_key(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_route")


def test_routes_404_without_a_key(client, seeded_db, auth_header):
    headers = auth_header()
    assert client.get("/api/admin/quote-ladder", headers=headers).status_code == 404
    resp = client.post(
        f"/api/admin/sponsors/{seeded_db['sponsor'].id}/quote",
        json={"code_points": 0, "address": ADDRESS},
        headers=headers,
    )
    assert resp.status_code == 404


def test_quote_ladder_requires_auth(client, stripe_key):
    assert client.get("/api/admin/quote-ladder").status_code in (401, 403)


def test_quote_ladder_renders_the_rule(client, seeded_db, auth_header, stripe_key):
    body = client.get("/api/admin/quote-ladder", headers=auth_header()).json()
    gold = body["tiers"]["gold"]
    assert (gold["list"], gold["founder"], gold["floor"]) == (2500, 2100, 1750)
    assert [o["code_points"] for o in gold["options"]] == list(range(16))
    assert gold["options"][0] == {"code_points": 0, "price_usd": 2100}
    assert gold["options"][10] == {"code_points": 10, "price_usd": 1850}
    assert gold["options"][15] == {"code_points": 15, "price_usd": 1750}
    for tier, row in body["tiers"].items():
        assert [o["price_usd"] for o in row["options"]] == [
            sales_pricing.price_usd(tier, p) for p in range(16)
        ]
    assert set(body["tiers"]) == {"silver", "gold", "platinum"}
    assert "steps" not in gold  # the old discounted ladder is not offered


def test_create_quote_refuses_points_above_fifteen(client, seeded_db, auth_header, stripe_key):
    resp = client.post(
        f"/api/admin/sponsors/{seeded_db['sponsor'].id}/quote",
        json={"code_points": 16, "address": ADDRESS},
        headers=auth_header(),
    )
    assert resp.status_code == 422


def test_create_quote_end_to_end_prices_by_the_rule_and_audits(
    client, db, seeded_db, auth_header, stripe_key, monkeypatch
):
    """Route → service → FakeStripe with no service monkeypatch: 10 points on
    the seeded Gold sponsor is a $1,850 quote on GOLD-AT-1850, audited."""
    from app.models.sales import BillingAudit

    fake = FakeStripe()
    monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)
    resp = client.post(
        f"/api/admin/sponsors/{seeded_db['sponsor'].id}/quote",
        json={"code_points": 10, "address": ADDRESS},
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["amount_total"] == 185000
    assert fake.last("POST", "/v1/quotes").form["discounts[0][coupon]"] == "GOLD-AT-1850"
    row = db.query(BillingAudit).filter(BillingAudit.action == "quote_created").one()
    assert row.actor == "admin"
    assert row.amount_cents == 185000
    assert row.sponsor_id == seeded_db["sponsor"].id


def test_create_quote_uses_the_sponsor_row(client, seeded_db, auth_header, stripe_key, monkeypatch):
    seen = {}

    async def fake_create(client_, **kwargs):
        seen.update(kwargs)
        return {
            "quote_id": "qt_x",
            "number": "QT-1",
            "amount_total": 30000,
            "customer_id": "cus_1",
            "status": "open",
        }

    monkeypatch.setattr(stripe_quotes, "create_sponsor_quote", fake_create)
    sponsor = seeded_db["sponsor"]
    resp = client.post(
        f"/api/admin/sponsors/{sponsor.id}/quote",
        json={"code_points": 0, "address": ADDRESS},
        headers=auth_header(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["quote_id"] == "qt_x"
    assert seen["sponsor_id"] == str(sponsor.id)
    assert seen["tier"] == "gold"  # seeded row is lowercase; service normalizes
    assert seen["email"] == "info@kennedy.com"  # supplier's email by default
    assert seen["code_points"] == 0


def test_create_quote_surfaces_stripe_422_as_string_detail(
    client, seeded_db, auth_header, stripe_key, monkeypatch
):
    async def fake_create(client_, **kwargs):
        raise StripeApiError("$299/mo is not on the gold ladder", status=422)

    monkeypatch.setattr(stripe_quotes, "create_sponsor_quote", fake_create)
    resp = client.post(
        f"/api/admin/sponsors/{seeded_db['sponsor'].id}/quote",
        json={"code_points": 0, "address": ADDRESS},
        headers=auth_header(),
    )
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], str)  # apiErrorDetail contract


def test_create_quote_unknown_sponsor_is_404(client, seeded_db, auth_header, stripe_key):
    resp = client.post(
        "/api/admin/sponsors/not-a-uuid/quote",
        json={"code_points": 0, "address": ADDRESS},
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
        return [
            {
                "quote_id": "qt_testquote0001",
                "number": "QT-0001",
                "status": "open",
                "amount_total": 30000,
                "created": 1,
            }
        ]

    monkeypatch.setattr(stripe_quotes, "list_sponsor_quotes", fake_list)
    resp = client.get(f"/api/admin/sponsors/{sponsor.id}/quotes", headers=auth_header())
    assert resp.status_code == 200
    assert resp.json()["quotes"][0]["number"] == "QT-0001"
    assert seen == {
        "email": "info@kennedy.com",
        "supplier_id": str(sponsor.supplier_id),
        "sponsor_id": str(sponsor.id),
    }


def test_pdf_and_ladder_run_end_to_end_against_mock_transport(
    client, seeded_db, auth_header, stripe_key, monkeypatch
):
    """One route exercised WITHOUT monkeypatching the service — the transport
    is swapped instead, so route→service→httpx wiring is proven whole."""
    fake = FakeStripe()
    fake.add_quote("qt_testquote0001", metadata={"managed_by": "circuits-com"})
    monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)
    resp = client.get("/api/admin/quotes/qt_testquote0001/pdf", headers=auth_header())
    assert resp.status_code == 200
    assert resp.content == b"%PDF-1.7 fake"
    assert fake.urls[-1] == "https://files.stripe.com/v1/quotes/qt_testquote0001/pdf"
    # …and the accept route through the same wiring stamps the subscription.
    resp = client.post("/api/admin/quotes/qt_testquote0001/accept", headers=auth_header())
    assert resp.status_code == 200, resp.text
    assert resp.json()["subscription_id"] == fake.quotes["qt_testquote0001"]["subscription"]


def test_quote_id_pattern_never_escapes_the_path():
    """Belt-and-braces: the id regex admits no '/', '?', '#' or '.' — nothing
    that could re-route the interpolated Stripe URL."""
    from app.routes.admin_quotes import _QUOTE_ID

    assert _QUOTE_ID.fullmatch("qt_1AbC234xyz")
    for evil in ("qt_a/..", "qt_a?x=1", "qt_a#f", "qt_", "quote_123", "qt_" + "a" * 100):
        assert not _QUOTE_ID.fullmatch(evil), evil


def test_ladder_payload_is_json_serializable():
    json.dumps(QUOTE_LADDER)
