#!/usr/bin/env python3
"""Put the Gold and Platinum prices and the card-update portal into the Stripe SANDBOX.

The /join rehearsal (spec 2026-09-23 §13) sells Gold and Platinum through
Checkout, and Checkout resolves prices by LOOKUP KEY. The live account has all
six tier prices; the sandbox (acct_1U0vYADbWRRGbHVZ) only ever got the Silver
twins. This script creates the other four in the live shape exactly:

  * one product per (tier, line) — advertising txcd_10701000, platform
    txcd_10103001 (the 90/10 split is NY tax structure, not cosmetics);
  * monthly USD prices, tax_behavior INCLUSIVE (the sticker is what the buyer
    pays), lookup keys {tier}_{advertising|platform}_monthly;
  * the billing-portal configuration the card-update link uses: the card and
    nothing else, found again by metadata[managed_by]=circuits-com.

It is idempotent: an existing price with the right shape is left alone, an
existing price with the WRONG shape is reported and never overwritten
(unit_amount and tax_behavior are immutable — fixing one is a new price with
transfer_lookup_key, a decision for a person), and the portal configuration is
created once.

SAFETY: sandbox only. The key is read from STRIPE_SECRET_KEY_TEST (shell env,
then the repo's .env) and anything that is not an sk_test_ key is refused
before a single request is made.

    python scripts/stripe_sandbox_setup.py --dry-run   # reads only, prints the plan
    python scripts/stripe_sandbox_setup.py
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.stripe.com/v1"
# The version every app Stripe call is pinned to (task0-stripe-versions.md).
API_VERSION = "2026-07-29.dahlia"
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
KEY_VAR = "STRIPE_SECRET_KEY_TEST"

# List prices in dollars — must equal QUOTE_LADDER[tier][0] in
# api/app/services/stripe_quotes.py (a test pins the two together; this script
# stays stdlib-only so it runs without the api's dependencies).
LIST_USD = {"silver": 250, "gold": 2500, "platinum": 10000}
TIERS = ("silver", "gold", "platinum")

# (line, share of list in percent, tax code, product name suffix)
LINES = (
    ("advertising", 90, "txcd_10701000", "Advertising"),
    ("platform", 10, "txcd_10103001", "Platform"),
)

MANAGED_BY = "circuits-com"

# Exactly T2's ensure_portal_configuration body (review F11): the card, and
# every other portal feature off, so the link can never cancel or change a plan.
PORTAL_CONFIGURATION = {
    "features": {
        "payment_method_update": {"enabled": True},
        "customer_update": {"enabled": False},
        "invoice_history": {"enabled": False},
        "subscription_cancel": {"enabled": False},
        "subscription_update": {"enabled": False},
    },
    "metadata": {"managed_by": MANAGED_BY},
}


class SetupError(Exception):
    """Stripe refused a request; the message is printable."""


# --------------------------------------------------------------------------
# HTTP — the ONE function that talks to Stripe (tests replace it).
# --------------------------------------------------------------------------


def form_encode(data, prefix=""):
    pairs = []
    if isinstance(data, dict):
        for key, value in data.items():
            child = f"{prefix}[{key}]" if prefix else str(key)
            pairs += form_encode(value, child)
    elif isinstance(data, (list, tuple)):
        for index, value in enumerate(data):
            pairs += form_encode(value, f"{prefix}[{index}]")
    elif isinstance(data, bool):
        pairs.append((prefix, "true" if data else "false"))
    elif data is not None:
        pairs.append((prefix, str(data)))
    return pairs


def api(method, path, key, params=None):
    encoded = urllib.parse.urlencode(form_encode(params or {}))
    url = f"{API}{path}"
    body = None
    if method == "GET":
        if encoded:
            url = f"{url}?{encoded}"
    else:
        body = encoded.encode()
    request = urllib.request.Request(url, data=body, method=method)
    token = base64.b64encode(f"{key}:".encode()).decode()
    request.add_header("Authorization", f"Basic {token}")
    request.add_header("Content-Type", "application/x-www-form-urlencoded")
    request.add_header("Stripe-Version", API_VERSION)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.load(exc).get("error", {}).get("message")
        except ValueError:
            detail = None
        raise SetupError(f"Stripe {exc.code} on {method} {path}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise SetupError(f"network error on {method} {path}: {exc.reason}") from exc


def list_all(path, key, params=None):
    """Every row of a list endpoint (cursor pagination)."""
    params = dict(params or {}, limit=100)
    while True:
        page = api("GET", path, key, params)
        yield from page.get("data", [])
        if not page.get("has_more") or not page.get("data"):
            return
        params["starting_after"] = page["data"][-1]["id"]


# --------------------------------------------------------------------------
# What the sandbox must hold.
# --------------------------------------------------------------------------


def price_lines(tier):
    """The two prices a tier bills as, in lookup_keys_for order."""
    list_cents = LIST_USD[tier] * 100
    return [
        {
            "line": line,
            "lookup_key": f"{tier}_{line}_monthly",
            "unit_amount": list_cents * share // 100,
            "tax_code": tax_code,
            "product_name": f"{tier.title()} Sponsorship — {suffix}",
            "tag": f"{tier}_{line}",
        }
        for line, share, tax_code, suffix in LINES
    ]


def _tax_code_id(product):
    tax_code = product.get("tax_code")
    return tax_code.get("id") if isinstance(tax_code, dict) else tax_code


def _price_problems(price, want):
    product = price.get("product")
    problems = []
    if price.get("unit_amount") != want["unit_amount"]:
        problems.append(f"unit_amount {price.get('unit_amount')} != {want['unit_amount']}")
    if price.get("currency") != "usd":
        problems.append(f"currency {price.get('currency')} != usd")
    if (price.get("recurring") or {}).get("interval") != "month":
        problems.append("not monthly")
    if price.get("tax_behavior") != "inclusive":
        problems.append(f"tax_behavior {price.get('tax_behavior')} != inclusive")
    # expand[]=data.product makes this the product object; a bare id means the
    # expansion was not honoured, and then the tax code simply isn't checked.
    if isinstance(product, dict) and _tax_code_id(product) != want["tax_code"]:
        problems.append(f"product tax_code {_tax_code_id(product)} != {want['tax_code']}")
    return problems


def _find_product(key, want):
    for product in list_all("/products", key, {"active": True}):
        if (product.get("metadata") or {}).get("circuits_line") == want["tag"]:
            return product
    return None


def ensure_price(key, want, dry_run, report):
    """Returns False when an existing price has the wrong shape."""
    found = api(
        "GET",
        "/prices",
        key,
        {"lookup_keys": [want["lookup_key"]], "active": True, "expand": ["data.product"]},
    ).get("data", [])
    if found:
        problems = _price_problems(found[0], want)
        if problems and all(p.startswith("unit_amount ") for p in problems):
            # Only the amount is stale (the sandbox Silver twins predate the live
            # 2026-08-22 repricing). unit_amount is immutable, so do what live did:
            # a new price on the SAME product takes the lookup key, the old one is
            # archived. Any other mismatch is a human's call — reported, never fixed.
            old = found[0]
            product = old.get("product")
            product_id = product.get("id") if isinstance(product, dict) else product
            if dry_run:
                report(
                    f"  reprice  {want['lookup_key']} ({old.get('id')}) "
                    f"{old.get('unit_amount')} -> {want['unit_amount']} cents"
                )
                return True
            new = api(
                "POST",
                "/prices",
                key,
                {
                    "product": product_id,
                    "currency": "usd",
                    "unit_amount": want["unit_amount"],
                    "recurring": {"interval": "month"},
                    "tax_behavior": "inclusive",
                    "lookup_key": want["lookup_key"],
                    "transfer_lookup_key": True,
                    "metadata": {"managed_by": MANAGED_BY},
                },
            )
            api("POST", f"/prices/{old['id']}", key, {"active": False})
            report(
                f"  repriced {want['lookup_key']} {old['id']} -> {new['id']} "
                f"({want['unit_amount']} cents); old archived"
            )
            return True
        if problems:
            report(
                f"  MISMATCH {want['lookup_key']} ({found[0].get('id')}): " + "; ".join(problems)
            )
            return False
        report(f"  ok       {want['lookup_key']} ({found[0].get('id')})")
        return True

    product = _find_product(key, want)
    if product is None:
        if dry_run:
            report(f"  create   product '{want['product_name']}' tax_code {want['tax_code']}")
            product_id = "<new product>"
        else:
            product = api(
                "POST",
                "/products",
                key,
                {
                    "name": want["product_name"],
                    "tax_code": want["tax_code"],
                    "metadata": {"managed_by": MANAGED_BY, "circuits_line": want["tag"]},
                },
            )
            product_id = product["id"]
            report(f"  created  product {product_id} '{want['product_name']}'")
    else:
        product_id = product["id"]
        tax_code = _tax_code_id(product)
        if tax_code != want["tax_code"]:
            if dry_run:
                report(f"  update   product {product_id} tax_code {tax_code} -> {want['tax_code']}")
            else:
                api("POST", f"/products/{product_id}", key, {"tax_code": want["tax_code"]})
                report(f"  updated  product {product_id} tax_code -> {want['tax_code']}")

    body = {
        "product": product_id,
        "currency": "usd",
        "unit_amount": want["unit_amount"],
        "recurring": {"interval": "month"},
        "tax_behavior": "inclusive",
        "lookup_key": want["lookup_key"],
        "metadata": {"managed_by": MANAGED_BY},
    }
    if dry_run:
        report(f"  create   price {want['lookup_key']} {want['unit_amount']} cents/month inclusive")
    else:
        price = api("POST", "/prices", key, body)
        report(f"  created  price {price['id']} {want['lookup_key']} {want['unit_amount']} cents")
    return True


def ensure_portal_configuration(key, dry_run, report):
    for config in list_all("/billing_portal/configurations", key):
        if (config.get("metadata") or {}).get("managed_by") == MANAGED_BY:
            report(f"  ok       portal configuration {config['id']}")
            return
    if dry_run:
        report("  create   portal configuration (payment_method_update only)")
        return
    config = api("POST", "/billing_portal/configurations", key, PORTAL_CONFIGURATION)
    report(f"  created  portal configuration {config['id']}")


# --------------------------------------------------------------------------


def secret_key():
    """STRIPE_SECRET_KEY_TEST from the shell, then .env — never the live variable."""
    if value := os.environ.get(KEY_VAR):
        return value.strip()
    if KEY_VAR in os.environ:
        return ""
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith(f"{KEY_VAR}="):
                return line.split("=", 1)[1].strip()
    return ""


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--dry-run", action="store_true", help="read the sandbox and print the plan; write nothing"
    )
    args = parser.parse_args(argv)

    key = secret_key()
    if not key.startswith("sk_test_"):
        print(
            f"Refusing: {KEY_VAR} is not a sandbox secret key (must start sk_test_). "
            "This script never touches the live account.",
            file=sys.stderr,
        )
        return 2

    report = print
    ok = True
    try:
        for tier in TIERS:
            report(f"{tier.title()}:")
            for want in price_lines(tier):
                ok = ensure_price(key, want, args.dry_run, report) and ok
        report("Card-update portal:")
        ensure_portal_configuration(key, args.dry_run, report)
    except SetupError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(
        "\nDashboard-only (owner): Billing -> Revenue recovery -> Smart Retries over "
        "3 weeks, ending in 'Leave the subscription past-due' (spec §10)."
    )
    if not ok:
        print(
            "\nOne or more existing prices have the wrong shape (listed above). Nothing was "
            "overwritten: create a correct price with transfer_lookup_key=true, then archive "
            "the old one.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
