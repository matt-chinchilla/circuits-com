"""A shared, in-memory Stripe for the billing tests (spec §5 / §14).

One ``httpx.MockTransport`` handler plays the slice of Stripe's REST surface
the app touches, with a request tape. Four lessons are built in:

* **It filters list endpoints by their query params**, decoded the way Stripe
  decodes them. A fake that ignored the query once certified a ``+``-in-email
  encoding bug green (billing-stripe gotcha).
* **It emits dahlia shapes** (``2026-07-29.dahlia``, the version both accounts
  default to and ``make_client`` pins): invoices hang off
  ``parent.subscription_details.subscription`` and carry NO ``payment_intent``
  / ``charge`` / ``paid`` keys — the PaymentIntent is only reachable through
  ``/v1/invoice_payments``; subscriptions carry ``items.data[].current_period_end``
  (not a top-level period end), ``cancel_at`` beside ``cancel_at_period_end``,
  and ``discounts`` as ids unless ``expand[]=discounts``; a Discount names its
  coupon at ``source.coupon``; coupons omit ``applies_to`` unless expanded.
* **It asserts every request carries ``Stripe-Version: 2026-07-29.dahlia``** —
  an unpinned call fails the test that made it, wherever it came from.
* **It honours ``Idempotency-Key`` on POST like Stripe**: the same key with the
  same path + params replays the FIRST response (a stored 402 decline too) with
  no second effect; the same key with anything different is a 400. A test of a
  "pay at most once" key is only meaningful against a fake that remembers it.

Seed state with the ``add_*`` helpers, drive code through ``fake.client()``
(or ``monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)`` to
put it behind a route), and read what Stripe RECEIVED through ``fake.tape`` /
``fake.last(method, path)`` / ``fake.calls(method, path)``.
"""

from __future__ import annotations

import itertools
import re
from typing import Any, NamedTuple
from urllib.parse import parse_qsl

import httpx

from app.services.stripe_quotes import STRIPE_API_VERSION, lookup_keys_for, make_client

# List prices in whole dollars (QUOTE_LADDER[tier][0]) split 90/10 advertising
# / platform, as the live and sandbox prices are.
_LIST_USD = {"silver": 250, "gold": 2500, "platinum": 10000}


class Req(NamedTuple):
    method: str
    path: str
    form: dict[str, str]
    params: dict[str, Any]  # str, or list[str] for a repeated key
    headers: httpx.Headers


def _err(status: int, message: str, code: str | None = None, **extra) -> httpx.Response:
    error: dict[str, Any] = {"message": message, "type": "invalid_request_error"}
    if code:
        error["code"] = code
    error.update(extra)
    return httpx.Response(status, json={"error": error})


def _no_such(kind: str, obj_id: str) -> httpx.Response:
    return _err(404, f"No such {kind}: '{obj_id}'", code="resource_missing")


def _truthy(value: str | None) -> bool:
    return value == "true"


class FakeStripe:
    def __init__(self) -> None:
        self.tape: list[Req] = []
        # The FULL request URL of each tape entry, as it went on the wire — how
        # a test proves a query value was percent-encoded (a raw ``+`` decodes
        # server-side as a space). Kept beside ``tape``, not in ``Req``, so
        # the tuple shape tests unpack stays five wide.
        self.urls: list[str] = []
        # Idempotency-Key → (fingerprint of the first request, status, body).
        self.idempotency: dict[str, tuple[tuple, int, bytes]] = {}
        self.prices: dict[str, dict] = {}
        self.subscriptions: dict[str, dict] = {}
        self.invoices: dict[str, dict] = {}
        self.invoice_payments: dict[str, list[dict]] = {}  # invoice id → payments
        self.payment_intents: dict[str, dict] = {}  # pi → {amount, amount_refunded}
        self.coupons: dict[str, dict] = {}
        self.customers: dict[str, dict] = {}
        self.payment_methods: dict[str, dict] = {}
        self.sessions: dict[str, dict] = {}
        self.portal_configurations: list[dict] = []
        self.portal_sessions: list[dict] = []
        self.refunds: list[dict] = []
        self.quotes: dict[str, dict] = {}
        self._discount_rows: dict[str, dict] = {}  # discount id → Discount (dahlia shape)

        # Behaviour flags.
        # "error": DELETE of a canceled sub answers 400 "…is already canceled…";
        # "return": Stripe hands the canceled sub back with 200.
        self.cancel_canceled_mode = "error"
        self.session_create_status: int | None = None  # e.g. 502 → session POST fails
        self.pay_fails = False  # POST /v1/invoices/{id}/pay → 402 card_declined
        self.preview_status: int | None = None  # e.g. 400 → no upcoming invoice
        self.update_ignores_discounts = (
            False  # a sub update that "succeeds" but keeps the old discount
        )
        # Quotes: a finalize that lands on this total instead of the computed
        # one (the honesty gate's mismatch), and a cancel that fails.
        self.quote_finalize_total: int | None = None
        self.quote_cancel_status: int | None = None  # e.g. 500 → cancel errors

        self._seq = itertools.count(1)
        for tier, list_usd in _LIST_USD.items():
            adv, plat = lookup_keys_for(tier)
            self.add_price(adv, product=f"prod_{tier}adv", unit_amount=list_usd * 90)
            self.add_price(plat, product=f"prod_{tier}plat", unit_amount=list_usd * 10)

    # ── client seams ──────────────────────────────────────────────────────

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def client(self) -> httpx.AsyncClient:
        return make_client("sk_test_x", transport=self.transport())

    def make_client(self, secret_key: str, transport=None) -> httpx.AsyncClient:
        """Drop-in for ``stripe_quotes.make_client`` (monkeypatch target)."""
        return make_client(secret_key, transport=self.transport())

    # ── tape readers ──────────────────────────────────────────────────────

    def calls(self, method: str, path: str) -> list[Req]:
        return [r for r in self.tape if r.method == method and r.path == path]

    def last(self, method: str, path: str) -> Req:
        hits = self.calls(method, path)
        if not hits:
            seen = [(r.method, r.path) for r in self.tape]
            raise AssertionError(f"{method} {path} never reached Stripe; tape={seen}")
        return hits[-1]

    def posts(self) -> list[Req]:
        return [r for r in self.tape if r.method == "POST"]

    # ── seeding helpers ───────────────────────────────────────────────────

    def _id(self, prefix: str) -> str:
        return f"{prefix}_{next(self._seq):012d}"

    def product_ids(self, tier: str) -> list[str]:
        return [self.prices[k]["product"] for k in lookup_keys_for(tier)]

    def add_price(
        self,
        lookup_key: str,
        *,
        product: str,
        unit_amount: int,
        active: bool = True,
        price_id: str | None = None,
    ) -> dict:
        row = {
            "id": price_id or f"price_{lookup_key}",
            "object": "price",
            "lookup_key": lookup_key,
            "product": product,
            "unit_amount": unit_amount,
            "currency": "usd",
            "active": active,
            "tax_behavior": "inclusive",
            "recurring": {"interval": "month", "interval_count": 1},
        }
        self.prices[lookup_key] = row
        return row

    def add_customer(
        self,
        customer_id: str,
        *,
        email: str | None = None,
        metadata: dict | None = None,
        default_payment_method: str | None = None,
    ) -> dict:
        row = {
            "id": customer_id,
            "object": "customer",
            "email": email,
            "name": None,
            "metadata": dict(metadata or {}),
            "invoice_settings": {"default_payment_method": default_payment_method},
        }
        self.customers[customer_id] = row
        return row

    def add_payment_method(
        self,
        pm_id: str,
        *,
        brand: str = "visa",
        last4: str = "4242",
        exp_month: int = 12,
        exp_year: int = 2030,
        kind: str = "card",
    ) -> dict:
        row: dict[str, Any] = {"id": pm_id, "object": "payment_method", "type": kind}
        if kind == "card":
            row["card"] = {
                "brand": brand,
                "last4": last4,
                "exp_month": exp_month,
                "exp_year": exp_year,
            }
        self.payment_methods[pm_id] = row
        return row

    def add_coupon(
        self,
        coupon_id: str,
        *,
        amount_off: int,
        duration: str = "forever",
        currency: str = "usd",
        valid: bool = True,
        products: list[str] | None = None,
        name: str | None = None,
    ) -> dict:
        row = {
            "id": coupon_id,
            "object": "coupon",
            "amount_off": amount_off,
            "percent_off": None,
            "currency": currency,
            "duration": duration,
            "valid": valid,
            "name": name,
            "metadata": {},
            "_products": list(products) if products is not None else None,
        }
        self.coupons[coupon_id] = row
        return row

    def add_subscription(
        self,
        sub_id: str,
        *,
        customer: str = "cus_000000001",
        tier: str = "gold",
        status: str = "active",
        default_payment_method: str | None = None,
        discounts: list[str] | None = None,
        coupons: list[str] | None = None,
        cancel_at: int | None = None,
        cancel_at_period_end: bool = False,
        period_ends: list[int] | None = None,
        metadata: dict | None = None,
        latest_invoice: str | None = None,
        collection_method: str = "charge_automatically",
        price_ids: list[str] | None = None,
    ) -> dict:
        """``discounts`` are raw discount ids; ``coupons`` attach discounts
        whose ``source.coupon`` names each coupon (what an expand returns)."""
        if customer not in self.customers:
            self.add_customer(customer)
        ends = period_ends or [1_900_000_000, 1_900_000_000]
        pids = price_ids or [self.prices[k]["id"] for k in lookup_keys_for(tier)]
        by_id = {p["id"]: p for p in self.prices.values()}
        items = []
        for i, pid in enumerate(pids):
            price = by_id.get(pid, {"id": pid, "product": None, "unit_amount": None})
            items.append(
                {
                    "id": f"si_{sub_id[4:]}{i}",
                    "object": "subscription_item",
                    "price": dict(price),
                    "quantity": 1,
                    "current_period_start": ends[min(i, len(ends) - 1)] - 2_592_000,
                    "current_period_end": ends[min(i, len(ends) - 1)],
                }
            )
        row = {
            "id": sub_id,
            "object": "subscription",
            "customer": customer,
            "status": status,
            "collection_method": collection_method,
            "billing_mode": {"type": "flexible"},
            "items": {"object": "list", "data": items},
            "cancel_at": cancel_at,
            "cancel_at_period_end": cancel_at_period_end,
            "canceled_at": None,
            "default_payment_method": default_payment_method,
            "discounts": [],
            "latest_invoice": latest_invoice,
            "metadata": dict(metadata or {}),
        }
        for di in discounts or []:
            self._discount_rows.setdefault(
                di,
                {
                    "id": di,
                    "object": "discount",
                    "source": {"type": "coupon", "coupon": None},
                    "subscription": sub_id,
                },
            )
            row["discounts"].append(di)
        for coupon in coupons or []:
            row["discounts"].append(self._attach_discount(sub_id, coupon))
        self.subscriptions[sub_id] = row
        return row

    def _attach_discount(self, sub_id: str, coupon_id: str) -> str:
        di = self._id("di")
        self._discount_rows[di] = {
            "id": di,
            "object": "discount",
            "source": {"type": "coupon", "coupon": coupon_id},
            "subscription": sub_id,
        }
        return di

    def _invoice(
        self,
        invoice_id: str,
        *,
        sub: str | None,
        amount: int,
        status: str,
        created: int | None,
        due_date: int | None,
        customer: str | None,
        collection_method: str,
    ) -> dict:
        if customer is None and sub and sub in self.subscriptions:
            customer = self.subscriptions[sub]["customer"]
        row = {
            "id": invoice_id,
            "object": "invoice",
            "customer": customer,
            "status": status,
            "collection_method": collection_method,
            "number": f"CC-{invoice_id[-4:]}",
            "created": created if created is not None else 1_800_000_000 + next(self._seq),
            "due_date": due_date,
            "amount_due": amount,
            "amount_paid": amount if status == "paid" else 0,
            "amount_remaining": 0 if status == "paid" else amount,
            "total": amount,
            "currency": "usd",
            "hosted_invoice_url": f"https://invoice.stripe.com/i/{invoice_id}",
            "invoice_pdf": f"https://pay.stripe.com/invoice/{invoice_id}/pdf",
            "status_transitions": {"paid_at": None},
            "parent": (
                {
                    "type": "subscription_details",
                    "subscription_details": {"subscription": sub, "metadata": {}},
                }
                if sub
                else None
            ),
        }
        self.invoices[invoice_id] = row
        return row

    def add_paid_invoice(
        self,
        invoice_id: str,
        *,
        sub: str | None,
        pi: str,
        amount: int,
        refunded: bool | int = False,
        created: int | None = None,
        customer: str | None = None,
        payment_type: str = "payment_intent",
    ) -> dict:
        """``refunded`` True = fully refunded; an int = cents already refunded."""
        row = self._invoice(
            invoice_id,
            sub=sub,
            amount=amount,
            status="paid",
            created=created,
            due_date=None,
            customer=customer,
            collection_method="charge_automatically",
        )
        row["status_transitions"]["paid_at"] = row["created"] + 60
        payment: dict[str, Any] = {"type": payment_type}
        if payment_type == "payment_intent":
            payment["payment_intent"] = pi
        else:
            payment["charge"] = pi
        self.invoice_payments.setdefault(invoice_id, []).append(
            {
                "id": self._id("inpay"),
                "object": "invoice_payment",
                "invoice": invoice_id,
                "status": "paid",
                "amount_paid": amount,
                "is_default": True,
                "payment": payment,
            }
        )
        already = amount if refunded is True else int(refunded or 0)
        self.payment_intents[pi] = {"amount": amount, "amount_refunded": already}
        return row

    def add_open_invoice(
        self,
        invoice_id: str,
        *,
        sub: str | None,
        amount: int,
        created: int | None = None,
        due_date: int | None = None,
        customer: str | None = None,
        collection_method: str = "charge_automatically",
    ) -> dict:
        return self._invoice(
            invoice_id,
            sub=sub,
            amount=amount,
            status="open",
            created=created,
            due_date=due_date,
            customer=customer,
            collection_method=collection_method,
        )

    def add_session(
        self, session_id: str, *, status: str = "open", metadata: dict | None = None
    ) -> dict:
        row = {
            "id": session_id,
            "object": "checkout.session",
            "status": status,
            "url": f"https://checkout.stripe.com/c/pay/{session_id}",
            "metadata": dict(metadata or {}),
        }
        self.sessions[session_id] = row
        return row

    def add_portal_configuration(
        self, *, metadata: dict | None = None, active: bool = True, config_id: str | None = None
    ) -> dict:
        row = {
            "id": config_id or self._id("bpc"),
            "object": "billing_portal.configuration",
            "active": active,
            "is_default": False,
            "metadata": dict(metadata or {}),
            "features": {},
        }
        self.portal_configurations.append(row)
        return row

    def add_quote(
        self,
        quote_id: str,
        *,
        customer: str | None = None,
        status: str = "open",
        amount_total: int = 0,
        metadata: dict | None = None,
        number: str | None = None,
        created: int | None = None,
    ) -> dict:
        """A quote as if built elsewhere (``metadata`` defaults to NONE of
        ours, so the accept guard's refusal can be driven)."""
        row = {
            "id": quote_id,
            "object": "quote",
            "status": status,
            "number": number,
            "amount_total": amount_total,
            "customer": customer,
            "metadata": dict(metadata or {}),
            "created": created if created is not None else 1_800_000_000 + next(self._seq),
            "subscription": None,
        }
        self.quotes[quote_id] = row
        return row

    # ── views (dahlia shapes) ─────────────────────────────────────────────

    def _coupon_view(self, row: dict, expand: list[str]) -> dict:
        view = {k: v for k, v in row.items() if not k.startswith("_")}
        if "applies_to" in expand and row["_products"] is not None:
            view["applies_to"] = {"products": list(row["_products"])}
        return view

    def _sub_view(self, row: dict, expand: list[str]) -> dict:
        view = {**row, "items": {"object": "list", "data": [dict(i) for i in row["items"]["data"]]}}
        if "discounts" in expand:
            view["discounts"] = [dict(self._discount_rows[d]) for d in row["discounts"]]
        else:
            view["discounts"] = list(row["discounts"])
        return view

    def _customer_view(self, row: dict, expand: list[str]) -> dict:
        view = {**row, "invoice_settings": dict(row["invoice_settings"])}
        pm = view["invoice_settings"].get("default_payment_method")
        if "invoice_settings.default_payment_method" in expand and pm:
            view["invoice_settings"]["default_payment_method"] = dict(
                self.payment_methods.get(pm, {"id": pm})
            )
        return view

    def _page(self, rows: list[dict], params: dict) -> dict:
        after = params.get("starting_after")
        if after:
            ids = [r["id"] for r in rows]
            rows = rows[ids.index(after) + 1 :] if after in ids else []
        limit = int(params.get("limit") or 10)
        return {"object": "list", "data": rows[:limit], "has_more": len(rows) > limit}

    # ── the handler ───────────────────────────────────────────────────────

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers.get("Stripe-Version") == STRIPE_API_VERSION, (
            f"unpinned Stripe call: {request.method} {request.url.path} "
            f"Stripe-Version={request.headers.get('Stripe-Version')!r}"
        )
        method, path = request.method, request.url.path
        form = dict(parse_qsl(request.content.decode(), keep_blank_values=True))
        params: dict[str, Any] = {}
        for key in request.url.params.keys():
            values = request.url.params.get_list(key)
            params[key] = values if len(values) > 1 or key.endswith("[]") else values[0]
        self.tape.append(Req(method, path, form, params, httpx.Headers(request.headers)))
        self.urls.append(str(request.url))
        if request.url.host == "files.stripe.com":
            return self._files(method, path)
        expand = request.url.params.get_list("expand[]") + [
            v for k, v in form.items() if k.startswith("expand[")
        ]
        key = request.headers.get("Idempotency-Key")
        if method != "POST" or not key:
            return self._route(method, path, form, params, expand)

        # Stripe's idempotency, as it behaves: the first POST under a key is
        # SAVED (status + body, a 402 decline included) and every later POST
        # under it is answered from that record, with no second effect; a key
        # reused with a different path or different params is a 400. A 5xx is
        # not saved — that request never "began executing" as far as a retry
        # is concerned (Stripe's own rule for a request it could not run).
        fingerprint = (path, tuple(sorted(form.items())))
        saved = self.idempotency.get(key)
        if saved is not None:
            first, status, body = saved
            if first != fingerprint:
                return httpx.Response(
                    400,
                    json={
                        "error": {
                            "type": "idempotency_error",
                            "message": (
                                "Keys for idempotent requests can only be used with the "
                                "same parameters they were first used with. Try using a "
                                f"key other than '{key}' if you meant to execute a "
                                "different request."
                            ),
                        }
                    },
                )
            return httpx.Response(
                status,
                content=body,
                headers={"content-type": "application/json", "Idempotent-Replayed": "true"},
            )
        response = self._route(method, path, form, params, expand)
        if response.status_code < 500:
            self.idempotency[key] = (fingerprint, response.status_code, response.content)
        return response

    def _files(self, method: str, path: str) -> httpx.Response:
        """files.stripe.com — only a quote's PDF is served here."""
        m = re.fullmatch(r"/v1/quotes/([^/]+)/pdf", path)
        if method != "GET" or m is None:
            return _err(404, f"unrouted files {method} {path}")
        if m.group(1) not in self.quotes:
            return _no_such("quote", m.group(1))
        return httpx.Response(
            200, content=b"%PDF-1.7 fake", headers={"content-type": "application/pdf"}
        )

    def _route(
        self, method: str, path: str, form: dict, params: dict, expand: list[str]
    ) -> httpx.Response:
        parts = path.strip("/").split("/")[1:]  # drop "v1"

        # ── prices
        if method == "GET" and parts == ["prices"]:
            keys = params.get("lookup_keys[]") or []
            keys = [keys] if isinstance(keys, str) else keys
            rows = [p for k, p in self.prices.items() if k in keys]
            if params.get("active") == "true":
                rows = [p for p in rows if p["active"]]
            return httpx.Response(200, json={"object": "list", "data": rows})

        # ── coupons
        if parts == ["coupons"] and method == "POST":
            cid = form.get("id") or self._id("co")
            if cid in self.coupons:
                return _err(400, "Coupon already exists.", code="resource_already_exists")
            products = [v for k, v in sorted(form.items()) if k.startswith("applies_to[products]")]
            row = self.add_coupon(
                cid,
                amount_off=int(form.get("amount_off") or 0),
                duration=form.get("duration", "once"),
                currency=form.get("currency", "usd"),
                products=products or None,
                name=form.get("name"),
            )
            row["metadata"] = {k[9:-1]: v for k, v in form.items() if k.startswith("metadata[")}
            return httpx.Response(200, json=self._coupon_view(row, []))
        if len(parts) == 2 and parts[0] == "coupons" and method == "GET":
            row = self.coupons.get(parts[1])
            if row is None:
                return _no_such("coupon", parts[1])
            return httpx.Response(200, json=self._coupon_view(row, expand))

        # ── customers
        if parts == ["customers"] and method == "GET":
            rows = [c for c in self.customers.values() if c.get("email") == params.get("email")]
            return httpx.Response(200, json=self._page(rows, params))
        if parts == ["customers"] and method == "POST":
            cid = self._id("cus")
            row = self.add_customer(
                cid,
                email=form.get("email"),
                metadata={k[9:-1]: v for k, v in form.items() if k.startswith("metadata[")},
            )
            row["name"] = form.get("name")
            return httpx.Response(200, json=self._customer_view(row, []))
        if len(parts) == 2 and parts[0] == "customers":
            row = self.customers.get(parts[1])
            if row is None:
                return _no_such("customer", parts[1])
            if method == "POST":
                for k, v in form.items():
                    if k.startswith("metadata["):
                        row["metadata"][k[9:-1]] = v
                    elif k == "invoice_settings[default_payment_method]":
                        row["invoice_settings"]["default_payment_method"] = v or None
                    elif k in ("name", "email"):
                        row[k] = v
            return httpx.Response(200, json=self._customer_view(row, expand))

        # ── payment methods
        if len(parts) == 2 and parts[0] == "payment_methods" and method == "GET":
            row = self.payment_methods.get(parts[1])
            return httpx.Response(200, json=row) if row else _no_such("payment_method", parts[1])

        # ── subscriptions
        if parts == ["subscriptions", "search"] and method == "GET":
            query = params.get("query", "")
            m = re.search(r"metadata\['sponsor_id'\]:'([^']*)'", query)
            wanted = m.group(1) if m else None
            rows = [
                s
                for s in self.subscriptions.values()
                if wanted is not None and s["metadata"].get("sponsor_id") == wanted
            ]
            if "-status:'canceled'" in query:
                rows = [s for s in rows if s["status"] != "canceled"]
            return httpx.Response(
                200,
                json={
                    "object": "search_result",
                    "data": [self._sub_view(s, []) for s in rows],
                    "has_more": False,
                },
            )
        if len(parts) == 2 and parts[0] == "subscriptions":
            row = self.subscriptions.get(parts[1])
            if row is None:
                return _no_such("subscription", parts[1])
            if method == "GET":
                return httpx.Response(200, json=self._sub_view(row, expand))
            if method == "DELETE":
                if row["status"] == "canceled":
                    if self.cancel_canceled_mode == "return":
                        return httpx.Response(200, json=self._sub_view(row, []))
                    return _err(400, f"This subscription is already canceled: {row['id']}")
                row["status"] = "canceled"
                row["canceled_at"] = 1_850_000_000
                return httpx.Response(200, json=self._sub_view(row, []))
            if method == "POST":
                if row["status"] == "canceled" and any(not k.startswith("metadata[") for k in form):
                    return _err(400, "A canceled subscription can only update its metadata.")
                if "cancel_at_period_end" in form:
                    was = row["cancel_at_period_end"]
                    row["cancel_at_period_end"] = _truthy(form["cancel_at_period_end"])
                    if row["cancel_at_period_end"]:
                        row["cancel_at"] = max(
                            i["current_period_end"] for i in row["items"]["data"]
                        )
                    elif was:
                        # Undoing a period-end cancel clears the cancel_at it set;
                        # a bare cancel_at (flexible mode) survives until cleared.
                        row["cancel_at"] = None
                if "cancel_at" in form:
                    row["cancel_at"] = int(form["cancel_at"]) if form["cancel_at"] else None
                if "default_payment_method" in form:
                    row["default_payment_method"] = form["default_payment_method"] or None
                if not self.update_ignores_discounts:
                    if form.get("discounts", None) == "":
                        row["discounts"] = []
                    elif "discounts[0][coupon]" in form:
                        coupon = form["discounts[0][coupon]"]
                        if coupon not in self.coupons:
                            return _no_such("coupon", coupon)
                        row["discounts"] = [self._attach_discount(row["id"], coupon)]
                for k, v in form.items():
                    if k.startswith("metadata["):
                        row["metadata"][k[9:-1]] = v
                return httpx.Response(200, json=self._sub_view(row, expand))

        # ── invoices
        if parts == ["invoices", "create_preview"] and method == "POST":
            if self.preview_status:
                return _err(
                    self.preview_status,
                    "No upcoming invoices for customer",
                    code="invoice_upcoming_none",
                )
            row = self.subscriptions.get(form.get("subscription", ""))
            if row is None or row["status"] == "canceled":
                return _err(400, "No upcoming invoices for customer", code="invoice_upcoming_none")
            gross = sum(i["price"].get("unit_amount") or 0 for i in row["items"]["data"])
            off = sum(
                self.coupons[self._discount_rows[d]["source"]["coupon"]]["amount_off"]
                for d in row["discounts"]
                if self._discount_rows[d]["source"]["coupon"] in self.coupons
            )
            total = max(0, gross - off)
            return httpx.Response(
                200,
                json={
                    "object": "invoice",
                    "id": None,
                    "status": "draft",
                    "amount_due": total,
                    "total": total,
                    "subtotal": gross,
                    "currency": "usd",
                    "period_end": max(i["current_period_end"] for i in row["items"]["data"]),
                    "next_payment_attempt": max(
                        i["current_period_end"] for i in row["items"]["data"]
                    ),
                    "parent": {
                        "type": "subscription_details",
                        "subscription_details": {"subscription": row["id"]},
                    },
                },
            )
        if parts == ["invoices"] and method == "GET":
            rows = list(self.invoices.values())
            if "subscription" in params:
                rows = [
                    i
                    for i in rows
                    if (i.get("parent") or {}).get("subscription_details", {}).get("subscription")
                    == params["subscription"]
                ]
            if "customer" in params:
                rows = [i for i in rows if i.get("customer") == params["customer"]]
            if "status" in params:
                rows = [i for i in rows if i["status"] == params["status"]]
            if "collection_method" in params:
                rows = [i for i in rows if i["collection_method"] == params["collection_method"]]
            for op, keep in (
                ("lt", lambda d, v: d < v),
                ("lte", lambda d, v: d <= v),
                ("gt", lambda d, v: d > v),
                ("gte", lambda d, v: d >= v),
            ):
                if f"due_date[{op}]" in params:
                    bound = int(params[f"due_date[{op}]"])
                    # Stripe omits invoices with no due date from a due_date range.
                    rows = [
                        i
                        for i in rows
                        if i.get("due_date") is not None and keep(i["due_date"], bound)
                    ]
            rows.sort(key=lambda i: i["created"], reverse=True)  # Stripe lists newest first
            return httpx.Response(200, json=self._page(rows, params))
        if len(parts) >= 2 and parts[0] == "invoices":
            row = self.invoices.get(parts[1])
            if row is None:
                return _no_such("invoice", parts[1])
            if len(parts) == 2 and method == "GET":
                return httpx.Response(200, json=dict(row))
            if parts[2:] == ["void"] and method == "POST":
                if row["status"] != "open":
                    return _err(400, f"You can only void an open invoice (status {row['status']}).")
                row["status"] = "void"
                row["amount_remaining"] = 0
                return httpx.Response(200, json=dict(row))
            if parts[2:] == ["pay"] and method == "POST":
                if row["status"] != "open":
                    return _err(400, "Invoice is already paid", code="invoice_not_open")
                if self.pay_fails:
                    return _err(402, "Your card was declined.", code="card_declined")
                row["status"] = "paid"
                row["amount_paid"] = row["amount_due"]
                row["amount_remaining"] = 0
                pi = self._id("pi")
                self.invoice_payments.setdefault(row["id"], []).append(
                    {
                        "id": self._id("inpay"),
                        "object": "invoice_payment",
                        "invoice": row["id"],
                        "status": "paid",
                        "amount_paid": row["amount_due"],
                        "is_default": True,
                        "payment": {"type": "payment_intent", "payment_intent": pi},
                    }
                )
                self.payment_intents[pi] = {"amount": row["amount_due"], "amount_refunded": 0}
                return httpx.Response(200, json=dict(row))

        # ── invoice payments
        if parts == ["invoice_payments"] and method == "GET":
            rows = list(self.invoice_payments.get(params.get("invoice", ""), []))
            if "status" in params:
                rows = [p for p in rows if p["status"] == params["status"]]
            return httpx.Response(200, json=self._page(rows, params))

        # ── refunds
        if parts == ["refunds"] and method == "POST":
            pi = form.get("payment_intent", "")
            state = self.payment_intents.get(pi)
            if state is None:
                return _no_such("payment_intent", pi)
            remaining = state["amount"] - state["amount_refunded"]
            if remaining <= 0:
                return _err(
                    400,
                    f"Charge for {pi} has already been refunded.",
                    code="charge_already_refunded",
                )
            amount = int(form["amount"]) if form.get("amount") else remaining
            if amount > remaining:
                return _err(
                    400,
                    f"Refund amount (${amount / 100:.2f}) is greater than unrefunded "
                    f"amount on charge (${remaining / 100:.2f})",
                )
            state["amount_refunded"] += amount
            refund = {
                "id": self._id("re"),
                "object": "refund",
                "payment_intent": pi,
                "amount": amount,
                "status": "succeeded",
            }
            self.refunds.append(refund)
            return httpx.Response(200, json=refund)

        # ── checkout sessions
        if parts == ["checkout", "sessions"] and method == "POST":
            if self.session_create_status:
                return _err(self.session_create_status, "Stripe is having a moment.")
            sid = f"cs_test_{next(self._seq):024d}"
            row = self.add_session(
                sid, metadata={k[9:-1]: v for k, v in form.items() if k.startswith("metadata[")}
            )
            row["form"] = form
            return httpx.Response(200, json={k: v for k, v in row.items() if k != "form"})
        if len(parts) >= 3 and parts[:2] == ["checkout", "sessions"]:
            row = self.sessions.get(parts[2])
            if row is None:
                return _no_such("checkout.session", parts[2])
            if len(parts) == 3 and method == "GET":
                return httpx.Response(200, json={k: v for k, v in row.items() if k != "form"})
            if parts[3:] == ["expire"] and method == "POST":
                if row["status"] != "open":
                    return _err(
                        400, 'Only Checkout Sessions with a status in ["open"] can be expired.'
                    )
                row["status"] = "expired"
                return httpx.Response(200, json={k: v for k, v in row.items() if k != "form"})

        # ── billing portal
        if parts == ["billing_portal", "configurations"] and method == "GET":
            rows = list(self.portal_configurations)
            if "active" in params:
                rows = [r for r in rows if r["active"] == (params["active"] == "true")]
            return httpx.Response(200, json=self._page(rows, params))
        if parts == ["billing_portal", "configurations"] and method == "POST":
            row = self.add_portal_configuration(
                metadata={k[9:-1]: v for k, v in form.items() if k.startswith("metadata[")}
            )
            row["form"] = form
            return httpx.Response(200, json={k: v for k, v in row.items() if k != "form"})
        if parts == ["billing_portal", "sessions"] and method == "POST":
            if form.get("customer") not in self.customers:
                return _no_such("customer", form.get("customer", ""))
            row = {
                "id": self._id("bps"),
                "object": "billing_portal.session",
                "url": f"https://billing.stripe.com/p/session/{next(self._seq)}",
                "form": form,
            }
            self.portal_sessions.append(row)
            return httpx.Response(200, json={k: v for k, v in row.items() if k != "form"})

        # ── quotes (enough for the rep quote flow; totals are COMPUTED)
        if parts == ["quotes"] and method == "POST":
            qid = f"qt_{next(self._seq):014d}"
            prices = {p["id"]: p for p in self.prices.values()}
            gross = sum(
                prices.get(v, {}).get("unit_amount") or 0
                for k, v in form.items()
                if re.fullmatch(r"line_items\[\d+\]\[price\]", k)
            )
            coupon = self.coupons.get(form.get("discounts[0][coupon]", ""))
            self.quotes[qid] = {
                "id": qid,
                "object": "quote",
                "status": "draft",
                "number": None,
                "amount_total": gross - (coupon["amount_off"] if coupon else 0),
                "customer": form.get("customer"),
                "metadata": {k[9:-1]: v for k, v in form.items() if k.startswith("metadata[")},
                "created": 1_800_000_000 + next(self._seq),
                "subscription": None,
            }
            return httpx.Response(200, json=dict(self.quotes[qid]))
        if parts == ["quotes"] and method == "GET":
            rows = [q for q in self.quotes.values() if q["customer"] == params.get("customer")]
            return httpx.Response(200, json=self._page(rows, params))
        if len(parts) >= 2 and parts[0] == "quotes":
            row = self.quotes.get(parts[1])
            if row is None:
                return _no_such("quote", parts[1])
            action = parts[2:]
            if method == "GET" and not action:
                return httpx.Response(200, json=dict(row))
            if method == "POST" and action == ["finalize"]:
                row["status"], row["number"] = "open", f"QT-{parts[1][-4:]}"
                if self.quote_finalize_total is not None:
                    row["amount_total"] = self.quote_finalize_total
            elif method == "POST" and action == ["cancel"]:
                if self.quote_cancel_status:
                    return _err(self.quote_cancel_status, "cancel exploded")
                row["status"] = "canceled"
            elif method == "POST" and action == ["accept"]:
                row["status"] = "accepted"
                row["subscription"] = self._id("sub")
            return httpx.Response(200, json=dict(row))

        return _err(404, f"unrouted {method} {path}")
