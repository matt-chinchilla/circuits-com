"""The Stripe ops layer (``services/stripe_billing``) and the client pin /
idempotency / coupon helper it rests on (``services/stripe_quotes``).

Every test drives real httpx through the shared FakeStripe, which emits the
dahlia shapes and refuses any unpinned call — so what is asserted is what
Stripe RECEIVED, never what a function claims it sent.
"""

import asyncio

import httpx
import pytest

from app.services import stripe_billing as sb
from app.services import stripe_quotes as sq
from app.services.stripe_quotes import StripeApiError
from tests.fake_stripe import FakeStripe

SUB = "sub_000000001"
CUS = "cus_000000001"


@pytest.fixture
def fake():
    return FakeStripe()


def run(factory, fake: FakeStripe):
    async def go():
        async with fake.client() as client:
            return await factory(client)

    return asyncio.run(go())


# ── client pin, encoding, idempotency ───────────────────────────────────────


def test_every_request_is_version_pinned(fake):
    fake.add_subscription(SUB)
    run(lambda c: sb.get_subscription(c, SUB), fake)
    assert fake.tape
    assert all(h.get("Stripe-Version") == "2026-07-29.dahlia" for *_, h in fake.tape)


def test_make_client_sends_the_pinned_version():
    assert sq.STRIPE_API_VERSION == "2026-07-29.dahlia"
    client = sq.make_client("sk_test_x")
    try:
        assert client.headers["Stripe-Version"] == "2026-07-29.dahlia"
    finally:
        asyncio.run(client.aclose())


def test_flatten_passes_an_empty_string_through_as_an_empty_string():
    """``discounts=`` (empty string) is how Stripe is told to CLEAR a
    subscription's discounts; an empty list sends nothing and changes nothing."""
    assert sq._flatten({"discounts": ""}) == {"discounts": ""}
    assert sq._flatten({"discounts": []}) == {}
    assert sq._flatten({"a": {"b": ""}}) == {"a[b]": ""}


def test_call_forwards_an_idempotency_key_only_when_given(fake):
    fake.add_customer(CUS)

    async def go(c):
        await sq._call(c, "POST", f"/v1/customers/{CUS}", {"name": "A"}, idempotency_key="k-1")
        await sq._call(c, "POST", f"/v1/customers/{CUS}", {"name": "B"})

    run(go, fake)
    first, second = fake.calls("POST", f"/v1/customers/{CUS}")
    assert first.headers["Idempotency-Key"] == "k-1"
    assert "Idempotency-Key" not in second.headers


def test_call_carries_stripes_error_code(fake):
    fake.add_paid_invoice("in_000000009", sub=SUB, pi="pi_000000009", amount=100, refunded=True)
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sq._call(c, "POST", "/v1/refunds", {"payment_intent": "pi_000000009"}), fake)
    assert err.value.status == 400
    assert err.value.code == "charge_already_refunded"


# ── prices + coupons ────────────────────────────────────────────────────────


def test_resolve_tier_prices_returns_rows_in_lookup_key_order(fake):
    rows = run(lambda c: sq.resolve_tier_prices(c, "gold"), fake)
    assert rows == [
        {
            "id": "price_gold_advertising_monthly",
            "product": "prod_goldadv",
            "unit_amount": 225000,
            "lookup_key": "gold_advertising_monthly",
        },
        {
            "id": "price_gold_platform_monthly",
            "product": "prod_goldplat",
            "unit_amount": 25000,
            "lookup_key": "gold_platform_monthly",
        },
    ]
    assert fake.last("GET", "/v1/prices").params == {
        "lookup_keys[]": ["gold_advertising_monthly", "gold_platform_monthly"],
        "active": "true",
    }


def test_resolve_tier_prices_refuses_a_missing_price(fake):
    del fake.prices["gold_platform_monthly"]
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sq.resolve_tier_prices(c, "gold"), fake)
    assert err.value.status == 422


def test_ensure_price_coupon_creates_fenced_to_the_resolved_products(fake):
    products = fake.product_ids("gold")
    cid = run(
        lambda c: sq.ensure_price_coupon(
            c, "gold", 2100, products, name="Gold Founder's Deal — $2,100/mo"
        ),
        fake,
    )
    assert cid == "GOLD-AT-2100"
    form = fake.last("POST", "/v1/coupons").form
    assert form["id"] == "GOLD-AT-2100"
    assert form["amount_off"] == "40000"
    assert form["currency"] == "usd"
    assert form["duration"] == "forever"
    assert form["applies_to[products][0]"] == "prod_goldadv"
    assert form["applies_to[products][1]"] == "prod_goldplat"
    assert form["name"] == "Gold Founder's Deal — $2,100/mo"
    assert "percent_off" not in form


def test_ensure_price_coupon_reuses_a_matching_coupon_via_expand(fake):
    products = fake.product_ids("gold")
    fake.add_coupon("GOLD-AT-1850", amount_off=65000, products=products)
    cid = run(lambda c: sq.ensure_price_coupon(c, "gold", 1850, products), fake)
    assert cid == "GOLD-AT-1850"
    assert fake.last("GET", "/v1/coupons/GOLD-AT-1850").params == {"expand[]": ["applies_to"]}


@pytest.mark.parametrize(
    "kwargs, field",
    [
        ({"amount_off": 5000}, "amount_off"),
        ({"duration": "once"}, "duration"),
        ({"currency": "eur"}, "currency"),
        ({"valid": False}, "valid"),
        ({"products": ["prod_someoneelse"]}, "applies_to"),
        ({"products": None}, "applies_to"),
    ],
)
def test_ensure_price_coupon_refuses_a_coupon_that_differs(fake, kwargs, field):
    products = fake.product_ids("gold")
    base = {"amount_off": 65000, "products": products}
    base.update(kwargs)
    fake.add_coupon("GOLD-AT-1850", **base)
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sq.ensure_price_coupon(c, "gold", 1850, products), fake)
    assert err.value.status == 409
    assert field in err.value.message


@pytest.mark.parametrize("target", [2500, 2600, 0, -5])
def test_ensure_price_coupon_refuses_out_of_range_targets_before_any_call(fake, target):
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sq.ensure_price_coupon(c, "gold", target, ["prod_goldadv"]), fake)
    assert err.value.status == 422
    assert fake.tape == []


def test_ensure_price_coupon_refuses_unknown_tier_and_empty_fence(fake):
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sq.ensure_price_coupon(c, "bronze", 100, ["prod_x"]), fake)
    assert err.value.status == 422
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sq.ensure_price_coupon(c, "gold", 2100, []), fake)
    assert err.value.status == 422
    assert fake.tape == []


def test_quote_uses_resolved_products_not_hardcoded_live_ids(fake):
    """The coupon fence comes from the prices Stripe returned — in the sandbox
    the product ids differ from live, and a hard-coded live id failed there."""
    fake.add_price("gold_advertising_monthly", product="prod_SANDBOXadv", unit_amount=225000)
    fake.add_price("gold_platform_monthly", product="prod_SANDBOXplat", unit_amount=25000)
    result = run(
        lambda c: sq.create_sponsor_quote(
            c,
            sponsor_id="sponsor-1",
            tier="gold",
            supplier_id="supplier-1",
            supplier_name="Kennedy",
            email="info@kennedy.com",
            address={"line1": "1 Main", "city": "X", "state": "NY", "postal_code": "11779"},
            monthly_total_usd=1250,
        ),
        fake,
    )
    assert result["amount_total"] == 125000
    form = fake.last("POST", "/v1/coupons").form
    assert form["applies_to[products][0]"] == "prod_SANDBOXadv"
    assert form["applies_to[products][1]"] == "prod_SANDBOXplat"
    assert not hasattr(sq, "_TIER_PRODUCTS")
    assert not hasattr(sq, "_ensure_ladder_coupon")


# ── ids + pure readers ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "kind, value",
    [
        ("sub", "sub_000000001"),
        ("in", "in_1AbCdEfGh"),
        ("cus", "cus_ABCDEFGH12"),
        ("cs", "cs_test_a1B2c3D4e5"),
        ("cs", "cs_live_a1B2c3D4e5"),
    ],
)
def test_checked_id_accepts_real_ids(kind, value):
    assert sb.checked_id(kind, value) == value


@pytest.mark.parametrize(
    "kind, value",
    [
        ("sub", "sub_../x"),
        ("sub", "sub_short"),
        ("sub", "in_000000001"),
        ("in", "in_000000001/pay"),
        ("cus", "cus_0000 0001"),
        ("cs", "cs_prod_a1B2c3D4e5"),
        ("sub", ""),
        ("sub", None),
        ("sub", "sub_000000001\n"),
        ("nope", "sub_000000001"),
    ],
)
def test_checked_id_rejects_anything_else(kind, value):
    with pytest.raises(StripeApiError) as err:
        sb.checked_id(kind, value)
    assert err.value.status == 422


def test_period_end_reads_items():
    assert (
        sb.period_end({"items": {"data": [{"current_period_end": 5}, {"current_period_end": 9}]}})
        == 9
    )
    assert sb.period_end({"items": {"data": []}}) is None
    assert sb.period_end({}) is None


def test_cancel_scheduled_reads_both_fields():
    assert sb.cancel_scheduled({"cancel_at_period_end": True, "cancel_at": 9}) is True
    assert (
        sb.cancel_scheduled({"cancel_at_period_end": False, "cancel_at": 9}) is True
    )  # flexible mode
    assert sb.cancel_scheduled({"cancel_at_period_end": False, "cancel_at": None}) is False
    assert sb.cancel_scheduled({}) is False


# ── reads ───────────────────────────────────────────────────────────────────


def test_get_subscription_validates_before_the_path(fake):
    with pytest.raises(StripeApiError):
        run(lambda c: sb.get_subscription(c, "sub_../../v1/charges"), fake)
    assert fake.tape == []


def test_list_invoices_filters_by_params(fake):
    fake.add_subscription(SUB)
    fake.add_subscription("sub_000000002")
    fake.add_open_invoice("in_000000001", sub=SUB, amount=210000, created=10)
    fake.add_paid_invoice("in_000000002", sub=SUB, pi="pi_000000002", amount=210000, created=20)
    fake.add_open_invoice("in_000000003", sub="sub_000000002", amount=5, created=30)
    rows = run(lambda c: sb.list_invoices(c, SUB), fake)
    assert [r["id"] for r in rows] == ["in_000000002", "in_000000001"]
    assert fake.last("GET", "/v1/invoices").params == {"subscription": SUB, "limit": "24"}
    rows = run(lambda c: sb.list_invoices(c, SUB, status="open", limit=5), fake)
    assert [r["id"] for r in rows] == ["in_000000001"]
    assert fake.last("GET", "/v1/invoices").params == {
        "subscription": SUB,
        "status": "open",
        "limit": "5",
    }


def test_invoice_payment_intent_uses_invoice_payments(fake):
    fake.add_paid_invoice("in_000000001", sub=SUB, pi="pi_000000001", amount=210000)
    assert "payment_intent" not in fake.invoices["in_000000001"]  # the dahlia shape
    pi = run(lambda c: sb.invoice_payment_intent(c, "in_000000001"), fake)
    assert pi == "pi_000000001"
    assert fake.last("GET", "/v1/invoice_payments").params == {
        "invoice": "in_000000001",
        "status": "paid",
    }


def test_invoice_payment_intent_refuses_a_non_payment_intent_payment(fake):
    fake.add_paid_invoice(
        "in_000000001", sub=SUB, pi="ch_000000001", amount=210000, payment_type="charge"
    )
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sb.invoice_payment_intent(c, "in_000000001"), fake)
    assert err.value.status == 409
    assert err.value.code == "unsupported_payment"


def test_invoice_payment_intent_refuses_an_unpaid_invoice(fake):
    fake.add_open_invoice("in_000000001", sub=SUB, amount=210000)
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sb.invoice_payment_intent(c, "in_000000001"), fake)
    assert err.value.status == 409


def test_preview_next_posts_create_preview(fake):
    fake.add_coupon("GOLD-AT-2100", amount_off=40000, products=fake.product_ids("gold"))
    fake.add_subscription(SUB, coupons=["GOLD-AT-2100"])
    preview = run(lambda c: sb.preview_next(c, SUB), fake)
    assert preview["amount_due"] == 210000
    assert fake.last("POST", "/v1/invoices/create_preview").form == {"subscription": SUB}


def test_preview_next_is_none_when_nothing_is_upcoming(fake):
    fake.add_subscription(SUB, status="canceled")
    assert run(lambda c: sb.preview_next(c, SUB), fake) is None


def test_default_card_reads_the_customer_default(fake):
    fake.add_payment_method("pm_1", brand="mastercard", last4="4444", exp_month=3, exp_year=2031)
    fake.add_customer(CUS, default_payment_method="pm_1")
    card = run(lambda c: sb.default_card(c, CUS), fake)
    assert card == {"brand": "mastercard", "last4": "4444", "exp_month": 3, "exp_year": 2031}
    assert fake.last("GET", f"/v1/customers/{CUS}").params == {
        "expand[]": ["invoice_settings.default_payment_method"]
    }


def test_default_card_is_none_without_one(fake):
    fake.add_customer(CUS)
    assert run(lambda c: sb.default_card(c, CUS), fake) is None


def test_search_sponsor_subscriptions_excludes_canceled(fake):
    sponsor = "5f0c7c2e-1111-4222-8333-944455556666"
    fake.add_subscription(SUB, metadata={"sponsor_id": sponsor})
    fake.add_subscription("sub_000000002", metadata={"sponsor_id": sponsor}, status="canceled")
    fake.add_subscription("sub_000000003", metadata={"sponsor_id": "other"})
    rows = run(lambda c: sb.search_sponsor_subscriptions(c, sponsor), fake)
    assert [r["id"] for r in rows] == [SUB]
    assert fake.last("GET", "/v1/subscriptions/search").params["query"] == (
        f"metadata['sponsor_id']:'{sponsor}' AND -status:'canceled'"
    )


def test_search_sponsor_subscriptions_refuses_a_non_uuid(fake):
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sb.search_sponsor_subscriptions(c, "x' OR status:'active"), fake)
    assert err.value.status == 422
    assert fake.tape == []


# ── writes ──────────────────────────────────────────────────────────────────


def test_idempotency_key_header_forwarded(fake):
    fake.add_paid_invoice("in_000000003", sub=SUB, pi="pi_000000003", amount=210000)
    refund = run(lambda c: sb.refund_invoice(c, "in_000000003", 5000, "refund:abc"), fake)
    assert refund["amount"] == 5000
    req = fake.last("POST", "/v1/refunds")
    assert req.headers["Idempotency-Key"] == "refund:abc"
    assert req.form == {"payment_intent": "pi_000000003", "amount": "5000"}


def test_refund_without_amount_is_full(fake):
    fake.add_paid_invoice("in_000000003", sub=SUB, pi="pi_000000003", amount=210000)
    run(lambda c: sb.refund_invoice(c, "in_000000003", None, "k"), fake)
    assert fake.last("POST", "/v1/refunds").form == {"payment_intent": "pi_000000003"}
    assert fake.payment_intents["pi_000000003"]["amount_refunded"] == 210000


def test_refund_already_refunded_is_success(fake):
    fake.add_paid_invoice("in_000000002", sub=SUB, pi="pi_000000002", amount=210000, refunded=True)
    assert run(lambda c: sb.refund_invoice(c, "in_000000002", None, "k2"), fake) is None


def test_refund_above_the_remainder_is_refused_by_stripe(fake):
    fake.add_paid_invoice(
        "in_000000002", sub=SUB, pi="pi_000000002", amount=210000, refunded=200000
    )
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sb.refund_invoice(c, "in_000000002", 20000, "k"), fake)
    assert err.value.status == 400


@pytest.mark.parametrize("amount", [0, -1])
def test_refund_refuses_a_non_positive_amount_before_any_call(fake, amount):
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sb.refund_invoice(c, "in_000000002", amount, "k"), fake)
    assert err.value.status == 422
    assert fake.tape == []


def test_cancel_now_cancels_without_invoicing_or_prorating(fake):
    fake.add_subscription(SUB)
    sub = run(lambda c: sb.cancel_now(c, SUB, "cancel:1"), fake)
    assert sub["status"] == "canceled"
    assert fake.last("DELETE", f"/v1/subscriptions/{SUB}").params == {
        "invoice_now": "false",
        "prorate": "false",
    }


@pytest.mark.parametrize("mode", ["error", "return"])
def test_cancel_now_on_an_already_canceled_sub_returns_it(fake, mode):
    fake.add_subscription(SUB, status="canceled")
    fake.cancel_canceled_mode = mode
    sub = run(lambda c: sb.cancel_now(c, SUB, "cancel:1"), fake)
    assert sub["id"] == SUB
    assert sub["status"] == "canceled"


def test_cancel_now_other_errors_still_raise(fake):
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sb.cancel_now(c, "sub_000000404", "k"), fake)
    assert err.value.status == 404


def test_set_period_end_cancel_schedules(fake):
    fake.add_subscription(SUB)
    sub = run(lambda c: sb.set_period_end_cancel(c, SUB, True, "k1"), fake)
    assert sb.cancel_scheduled(sub)
    req = fake.last("POST", f"/v1/subscriptions/{SUB}")
    assert req.form == {"cancel_at_period_end": "true"}
    assert req.headers["Idempotency-Key"] == "k1"


def test_resume_clears_a_period_end_cancel(fake):
    fake.add_subscription(SUB, cancel_at_period_end=True, cancel_at=1_900_000_000)
    sub = run(lambda c: sb.set_period_end_cancel(c, SUB, False, "k1"), fake)
    assert not sb.cancel_scheduled(sub)
    assert fake.calls("POST", f"/v1/subscriptions/{SUB}")[0].form == {
        "cancel_at_period_end": "false"
    }


def test_resume_also_sends_cancel_at_empty_when_cancel_at_is_set(fake):
    """Flexible billing mode: a scheduled cancel can be ``cancel_at`` alone."""
    fake.add_subscription(SUB, cancel_at=1_900_000_000)
    sub = run(lambda c: sb.set_period_end_cancel(c, SUB, False, "k1"), fake)
    assert sub["cancel_at"] is None
    posts = fake.calls("POST", f"/v1/subscriptions/{SUB}")
    assert [p.form for p in posts] == [{"cancel_at_period_end": "false"}, {"cancel_at": ""}]
    # A second POST with different params must not reuse the first key.
    assert posts[0].headers["Idempotency-Key"] != posts[1].headers["Idempotency-Key"]


def test_void_open_invoices_voids_each_open_one(fake):
    fake.add_subscription(SUB)
    fake.add_open_invoice("in_000000001", sub=SUB, amount=1)
    fake.add_open_invoice("in_000000002", sub=SUB, amount=1)
    fake.add_paid_invoice("in_000000003", sub=SUB, pi="pi_000000003", amount=1)
    fake.add_open_invoice("in_000000004", sub="sub_000000002", amount=1)
    assert run(lambda c: sb.void_open_invoices(c, SUB), fake) == 2
    assert fake.invoices["in_000000001"]["status"] == "void"
    assert fake.invoices["in_000000002"]["status"] == "void"
    assert fake.invoices["in_000000004"]["status"] == "open"
    assert fake.last("GET", "/v1/invoices").params["status"] == "open"
    assert all(r.headers.get("Idempotency-Key") for r in fake.posts())


def test_void_open_invoices_pages(fake):
    fake.add_subscription(SUB)
    for n in range(1, 106):
        fake.add_open_invoice(f"in_{n:09d}", sub=SUB, amount=1, created=n)
    assert run(lambda c: sb.void_open_invoices(c, SUB), fake) == 105


def test_set_coupon_applies_one_coupon_and_verifies(fake):
    fake.add_coupon("GOLD-AT-1850", amount_off=65000, products=fake.product_ids("gold"))
    fake.add_subscription(SUB)
    run(lambda c: sb.set_coupon(c, SUB, "GOLD-AT-1850", "k1"), fake)
    req = fake.last("POST", f"/v1/subscriptions/{SUB}")
    assert req.form == {"discounts[0][coupon]": "GOLD-AT-1850"}
    assert req.headers["Idempotency-Key"] == "k1"
    assert fake.last("GET", f"/v1/subscriptions/{SUB}").params == {"expand[]": ["discounts"]}


def test_set_coupon_none_sends_empty_discounts_on_the_wire(fake):
    fake.add_subscription(SUB, discounts=["di_x"])
    run(lambda c: sb.set_coupon(c, SUB, None, "k1"), fake)
    assert fake.last("POST", f"/v1/subscriptions/{SUB}").form == {"discounts": ""}
    assert fake.subscriptions[SUB]["discounts"] == []


def test_set_coupon_raises_502_when_the_reread_disagrees(fake):
    fake.add_coupon("GOLD-AT-2100", amount_off=40000, products=fake.product_ids("gold"))
    fake.add_coupon("GOLD-AT-1850", amount_off=65000, products=fake.product_ids("gold"))
    fake.add_subscription(SUB, coupons=["GOLD-AT-2100"])
    fake.update_ignores_discounts = True
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sb.set_coupon(c, SUB, "GOLD-AT-1850", "k1"), fake)
    assert err.value.status == 502


def test_set_coupon_clear_raises_502_when_a_discount_survives(fake):
    fake.add_coupon("GOLD-AT-2100", amount_off=40000, products=fake.product_ids("gold"))
    fake.add_subscription(SUB, coupons=["GOLD-AT-2100"])
    fake.update_ignores_discounts = True
    with pytest.raises(StripeApiError) as err:
        run(lambda c: sb.set_coupon(c, SUB, None, "k1"), fake)
    assert err.value.status == 502


def test_pay_oldest_open_invoice(fake):
    fake.add_subscription(SUB)
    fake.add_open_invoice("in_000000002", sub=SUB, amount=1, created=20)
    fake.add_open_invoice("in_000000001", sub=SUB, amount=1, created=10)
    paid = run(lambda c: sb.pay_oldest_open_invoice(c, SUB, "pay:1"), fake)
    assert paid["id"] == "in_000000001"
    req = fake.last("POST", "/v1/invoices/in_000000001/pay")
    assert req.headers["Idempotency-Key"] == "pay:1"
    assert fake.invoices["in_000000002"]["status"] == "open"


def test_pay_oldest_open_invoice_none_when_nothing_open(fake):
    fake.add_subscription(SUB)
    assert run(lambda c: sb.pay_oldest_open_invoice(c, SUB, "pay:1"), fake) is None
    assert fake.posts() == []


def test_move_card_to_customer(fake):
    fake.add_subscription(SUB, customer=CUS, default_payment_method="pm_1")
    assert run(lambda c: sb.move_card_to_customer(c, SUB), fake) is True
    assert fake.last("POST", f"/v1/customers/{CUS}").form == {
        "invoice_settings[default_payment_method]": "pm_1"
    }
    assert fake.last("POST", f"/v1/subscriptions/{SUB}").form == {"default_payment_method": ""}
    assert fake.customers[CUS]["invoice_settings"]["default_payment_method"] == "pm_1"
    assert fake.subscriptions[SUB]["default_payment_method"] is None
    assert all(r.headers.get("Idempotency-Key") for r in fake.posts())


def test_move_card_to_customer_is_false_when_nothing_to_move(fake):
    fake.add_subscription(SUB, customer=CUS)
    assert run(lambda c: sb.move_card_to_customer(c, SUB), fake) is False
    assert fake.posts() == []


def test_ensure_portal_configuration_creates_card_only(fake):
    config_id = run(lambda c: sb.ensure_portal_configuration(c), fake)
    form = fake.last("POST", "/v1/billing_portal/configurations").form
    features = {k: v for k, v in form.items() if k.startswith("features[")}
    assert features == {
        "features[payment_method_update][enabled]": "true",
        "features[customer_update][enabled]": "false",
        "features[invoice_history][enabled]": "false",
        "features[subscription_cancel][enabled]": "false",
        "features[subscription_update][enabled]": "false",
    }
    assert form["metadata[managed_by]"] == "circuits-com"
    assert config_id == fake.portal_configurations[-1]["id"]


def test_ensure_portal_configuration_pages_and_reuses_ours(fake):
    for _ in range(150):
        fake.add_portal_configuration()
    ours = fake.add_portal_configuration(metadata={"managed_by": "circuits-com"})
    config_id = run(lambda c: sb.ensure_portal_configuration(c), fake)
    assert config_id == ours["id"]
    assert fake.calls("POST", "/v1/billing_portal/configurations") == []
    assert len(fake.calls("GET", "/v1/billing_portal/configurations")) == 2


def test_card_update_session_uses_the_payment_method_flow(fake):
    fake.add_customer(CUS)
    url = run(
        lambda c: sb.card_update_session(c, CUS, "bpc_000000001", "https://x.test/done"), fake
    )
    assert url.startswith("https://billing.stripe.com/")
    form = fake.last("POST", "/v1/billing_portal/sessions").form
    assert form["customer"] == CUS
    assert form["configuration"] == "bpc_000000001"
    assert form["flow_data[type]"] == "payment_method_update"
    assert form["flow_data[after_completion][type]"] == "redirect"
    assert form["flow_data[after_completion][redirect][return_url]"] == "https://x.test/done"


def test_expire_checkout_session(fake):
    fake.add_session("cs_test_a1B2c3D4e5")
    assert run(lambda c: sb.expire_checkout_session(c, "cs_test_a1B2c3D4e5"), fake) is None
    assert fake.sessions["cs_test_a1B2c3D4e5"]["status"] == "expired"


@pytest.mark.parametrize("status", ["expired", "complete"])
def test_expire_checkout_session_already_done_is_no_error(fake, status):
    fake.add_session("cs_test_a1B2c3D4e5", status=status)
    assert run(lambda c: sb.expire_checkout_session(c, "cs_test_a1B2c3D4e5"), fake) is None


def test_stamp_customer_supplier(fake):
    fake.add_customer(CUS)
    run(lambda c: sb.stamp_customer_supplier(c, CUS, "supplier-9"), fake)
    req = fake.last("POST", f"/v1/customers/{CUS}")
    assert req.form == {
        "metadata[supplier_id]": "supplier-9",
        "metadata[managed_by]": "circuits-com",
    }
    assert req.headers.get("Idempotency-Key")
    assert fake.customers[CUS]["metadata"]["supplier_id"] == "supplier-9"


def test_unreachable_stripe_is_a_502():
    def boom(request):
        raise httpx.ConnectError("down")

    async def go():
        async with sq.make_client("sk_test_x", transport=httpx.MockTransport(boom)) as c:
            return await sb.get_subscription(c, SUB)

    with pytest.raises(StripeApiError) as err:
        asyncio.run(go())
    assert err.value.status == 502
