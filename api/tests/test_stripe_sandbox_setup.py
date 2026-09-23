"""Guards for scripts/stripe_sandbox_setup.py (spec §13.3).

The script puts the Gold and Platinum prices (and the card-update portal
configuration) into the Stripe SANDBOX so the /join rehearsal can run. It must
be impossible to point at the live account, and what it creates must be the
live shape exactly: inclusive tax behavior, the live lookup keys and tax
codes, the 90/10 advertising/platform split.

No request ever leaves this file: the module's one HTTP function is replaced
by an in-memory fake."""

import importlib.util
import io
import json
import sys
import urllib.parse
from pathlib import Path

import pytest

from app.services.stripe_quotes import QUOTE_LADDER, lookup_keys_for

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "stripe_sandbox_setup.py"


@pytest.fixture
def setup_mod():
    spec = importlib.util.spec_from_file_location("stripe_sandbox_setup", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["stripe_sandbox_setup"] = mod
    spec.loader.exec_module(mod)
    yield mod
    sys.modules.pop("stripe_sandbox_setup", None)


class FakeStripe:
    """Just enough of /v1/prices, /v1/products and the portal configurations."""

    def __init__(self):
        self.calls: list[tuple[str, str, dict]] = []
        self.products: list[dict] = []
        self.prices: list[dict] = []
        self.configs: list[dict] = []
        self._n = 0

    def _id(self, prefix):
        self._n += 1
        return f"{prefix}_{self._n:08d}"

    def __call__(self, method, path, key, params=None):
        params = dict(params or {})
        self.calls.append((method, path, params))
        if (method, path) == ("GET", "/prices"):
            keys = set(params.get("lookup_keys", []))
            data = [p for p in self.prices if p["active"] and p["lookup_key"] in keys]
            if "data.product" in params.get("expand", []):
                by_id = {p["id"]: p for p in self.products}
                data = [{**p, "product": by_id[p["product"]]} for p in data]
            return {"data": data, "has_more": False}
        if (method, path) == ("GET", "/products"):
            return {"data": [p for p in self.products if p["active"]], "has_more": False}
        if (method, path) == ("POST", "/products"):
            product = {
                "id": self._id("prod"),
                "active": True,
                "name": params["name"],
                "tax_code": params.get("tax_code"),
                "metadata": params.get("metadata", {}),
            }
            self.products.append(product)
            return product
        if method == "POST" and path.startswith("/products/"):
            product = next(p for p in self.products if p["id"] == path.rsplit("/", 1)[1])
            product.update({k: v for k, v in params.items() if k != "metadata"})
            return product
        if method == "POST" and path.startswith("/prices/"):
            price = next(p for p in self.prices if p["id"] == path.rsplit("/", 1)[1])
            if "active" in params:
                price["active"] = params["active"] in (True, "true")
            return price
        if (method, path) == ("POST", "/prices"):
            if params.get("transfer_lookup_key") in (True, "true"):
                for other in self.prices:
                    if other["lookup_key"] == params["lookup_key"]:
                        other["lookup_key"] = None
            price = {
                "id": self._id("price"),
                "active": True,
                "product": params["product"],
                "currency": params["currency"],
                "unit_amount": int(params["unit_amount"]),
                "recurring": {"interval": params["recurring"]["interval"]},
                "tax_behavior": params["tax_behavior"],
                "lookup_key": params["lookup_key"],
            }
            self.prices.append(price)
            return price
        if (method, path) == ("GET", "/billing_portal/configurations"):
            return {"data": list(self.configs), "has_more": False}
        if (method, path) == ("POST", "/billing_portal/configurations"):
            config = {"id": self._id("bpc"), "metadata": params.get("metadata", {})}
            self.configs.append(config)
            return config
        raise AssertionError(f"unexpected request {method} {path}")

    def posts(self, path):
        return [params for method, p, params in self.calls if method == "POST" and p == path]


@pytest.fixture
def fake(setup_mod, monkeypatch):
    stub = FakeStripe()
    monkeypatch.setattr(setup_mod, "api", stub)
    monkeypatch.setenv("STRIPE_SECRET_KEY_TEST", "sk_test_abc123")
    return stub


# ─── the live account is unreachable ────────────────────────────────────────


@pytest.mark.parametrize("key", ["sk_live_abc123", "rk_live_abc123", "rk_test_abc123", ""])
def test_a_non_sandbox_key_exits_non_zero_before_any_request(setup_mod, monkeypatch, key):
    calls = []
    monkeypatch.setattr(setup_mod, "api", lambda *a, **k: calls.append(a))
    monkeypatch.setenv("STRIPE_SECRET_KEY_TEST", key)
    assert setup_mod.main([]) != 0
    assert calls == []


def test_the_script_never_reads_the_live_key_variable(setup_mod):
    src = SCRIPT.read_text()
    assert '"STRIPE_SECRET_KEY"' not in src, "only STRIPE_SECRET_KEY_TEST may be read"


# ─── what it creates ────────────────────────────────────────────────────────


def test_fresh_sandbox_gets_inclusive_prices_with_the_live_lookup_keys(fake, setup_mod):
    assert setup_mod.main([]) == 0
    bodies = {p["lookup_key"]: p for p in fake.posts("/prices")}
    assert set(bodies) == {
        "silver_advertising_monthly",
        "silver_platform_monthly",
        "gold_advertising_monthly",
        "gold_platform_monthly",
        "platinum_advertising_monthly",
        "platinum_platform_monthly",
    }
    assert {k: int(b["unit_amount"]) for k, b in bodies.items()} == {
        "silver_advertising_monthly": 22500,
        "silver_platform_monthly": 2500,
        "gold_advertising_monthly": 225000,
        "gold_platform_monthly": 25000,
        "platinum_advertising_monthly": 900000,
        "platinum_platform_monthly": 100000,
    }
    for body in bodies.values():
        assert body["tax_behavior"] == "inclusive"
        assert body["currency"] == "usd"
        assert body["recurring"] == {"interval": "month"}


def test_products_carry_the_advertising_and_platform_tax_codes(fake, setup_mod):
    assert setup_mod.main([]) == 0
    by_product = {p["id"]: p for p in fake.products}
    for price in fake.prices:
        product = by_product[price["product"]]
        expected = (
            "txcd_10701000"
            if price["lookup_key"].endswith("_advertising_monthly")
            else "txcd_10103001"
        )
        assert product["tax_code"] == expected, price["lookup_key"]
    assert len(fake.products) == 6, "one product per (tier, line) — never one per run"


def test_the_portal_configuration_only_updates_the_card(fake, setup_mod):
    assert setup_mod.main([]) == 0
    (body,) = fake.posts("/billing_portal/configurations")
    assert body == {
        "features": {
            "payment_method_update": {"enabled": True},
            "customer_update": {"enabled": False},
            "invoice_history": {"enabled": False},
            "subscription_cancel": {"enabled": False},
            "subscription_update": {"enabled": False},
        },
        "metadata": {"managed_by": "circuits-com"},
    }


def test_the_split_is_ninety_ten_of_the_quote_ladder_list_price(setup_mod):
    # QUOTE_LADDER is the price home; the script is stdlib-only and carries its
    # own copy, so the two must agree (and lookup keys come from one rule).
    for tier in ("silver", "gold", "platinum"):
        lines = setup_mod.price_lines(tier)
        assert [line["lookup_key"] for line in lines] == lookup_keys_for(tier)
        assert sum(line["unit_amount"] for line in lines) == QUOTE_LADDER[tier][0] * 100
        assert lines[0]["unit_amount"] == QUOTE_LADDER[tier][0] * 90


# ─── idempotent ─────────────────────────────────────────────────────────────


def test_a_second_run_writes_nothing(fake, setup_mod):
    assert setup_mod.main([]) == 0
    before = len([c for c in fake.calls if c[0] == "POST"])
    assert setup_mod.main([]) == 0
    after = len([c for c in fake.calls if c[0] == "POST"])
    assert after == before


def test_a_mismatched_existing_price_is_reported_never_overwritten(fake, setup_mod):
    fake.products.append(
        {
            "id": "prod_existing1",
            "active": True,
            "name": "old",
            "tax_code": "txcd_10701000",
            "metadata": {},
        }
    )
    fake.prices.append(
        {
            "id": "price_existing1",
            "active": True,
            "product": "prod_existing1",
            "currency": "usd",
            "unit_amount": 225000,
            "recurring": {"interval": "month"},
            "tax_behavior": "exclusive",
            "lookup_key": "gold_advertising_monthly",
        }
    )
    assert setup_mod.main([]) != 0
    assert "gold_advertising_monthly" not in {p["lookup_key"] for p in fake.posts("/prices")}


def test_an_existing_managed_portal_configuration_is_reused(fake, setup_mod):
    fake.configs.append({"id": "bpc_existing1", "metadata": {"managed_by": "circuits-com"}})
    assert setup_mod.main([]) == 0
    assert fake.posts("/billing_portal/configurations") == []


def test_dry_run_reads_but_never_writes(fake, setup_mod):
    assert setup_mod.main(["--dry-run"]) == 0
    assert [c for c in fake.calls if c[0] == "POST"] == []
    assert any(c[0] == "GET" for c in fake.calls)


# ─── the HTTP function itself ───────────────────────────────────────────────


def test_every_request_is_version_pinned_and_gets_use_the_query_string(setup_mod, monkeypatch):
    seen = []

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(request, timeout=None):
        seen.append(request)
        return Resp(json.dumps({"data": [], "has_more": False}).encode())

    monkeypatch.setattr(setup_mod.urllib.request, "urlopen", fake_urlopen)
    setup_mod.api("GET", "/prices", "sk_test_abc123", {"lookup_keys": ["gold_platform_monthly"]})
    setup_mod.api("POST", "/products", "sk_test_abc123", {"name": "x"})
    get, post = seen
    assert get.get_header("Stripe-version") == "2026-07-29.dahlia"
    assert post.get_header("Stripe-version") == "2026-07-29.dahlia"
    assert get.data is None
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(get.full_url).query)
    assert query == {"lookup_keys[0]": ["gold_platform_monthly"]}
    assert post.data == b"name=x"


def test_a_stale_amount_is_repriced_on_the_same_product_and_the_key_moves(fake, setup_mod):
    """The sandbox Silver twins were made at $90 + $10 before the live repricing to
    $225 + $25 (2026-08-22). unit_amount is immutable, so the fix is the live one:
    a NEW price on the SAME product with transfer_lookup_key, then archive the old."""
    for line, amount, code in (("advertising", 9000, "txcd_10701000"), ("platform", 1000, "txcd_10103001")):
        fake.products.append({"id": f"prod_silver_{line}", "active": True, "name": "old",
                              "tax_code": code, "metadata": {}})
        fake.prices.append({"id": f"price_old_{line}", "active": True, "product": f"prod_silver_{line}",
                            "currency": "usd", "unit_amount": amount, "recurring": {"interval": "month"},
                            "tax_behavior": "inclusive", "lookup_key": f"silver_{line}_monthly"})
    assert setup_mod.main([]) == 0
    live = {p["lookup_key"]: p for p in fake.prices if p["active"] and p["lookup_key"]}
    assert live["silver_advertising_monthly"]["unit_amount"] == 22500
    assert live["silver_platform_monthly"]["unit_amount"] == 2500
    assert live["silver_advertising_monthly"]["product"] == "prod_silver_advertising"
    silver_posts = [b for b in fake.posts("/prices") if b["lookup_key"].startswith("silver_")]
    assert all(b.get("transfer_lookup_key") in (True, "true") for b in silver_posts)
    old = {p["id"]: p for p in fake.prices}
    assert old["price_old_advertising"]["active"] is False
    assert old["price_old_platform"]["active"] is False
