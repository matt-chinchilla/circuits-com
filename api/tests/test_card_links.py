"""Card-update links (spec §9, R14): the token, the rep's mint route, and the
customer's two public routes.

* The token signs (sponsor, version, expiry); a NEW link bumps the version,
  so the old one is dead (410) without any table of issued tokens.
* Opening a link moves the card Checkout saved on the SUBSCRIPTION to the
  customer BEFORE minting the portal session — else a portal card update
  would never be charged.
* ``/done`` pays the oldest open invoice once and lands on /join?card=updated.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.config import settings
from app.models import Sponsor
from app.models.sales import BillingAudit, SponsorBilling, SponsorPayment
from app.services import card_links, stripe_quotes
from tests.fake_stripe import FakeStripe

SUB = "sub_000000000001"
CUS = "cus_000000000001"


# ── the token ───────────────────────────────────────────────────────────────


def test_token_round_trip():
    sid = uuid.uuid4()
    token = card_links.make_token(sid, 3, datetime.now(UTC) + timedelta(days=7))
    assert card_links.read_token(token) == (sid, 3)
    assert "/" not in token and "?" not in token and "#" not in token


def test_an_expired_token_reads_as_nothing():
    token = card_links.make_token(uuid.uuid4(), 1, datetime.now(UTC) - timedelta(seconds=1))
    assert card_links.read_token(token) is None


def test_a_tampered_token_reads_as_nothing():
    sid = uuid.uuid4()
    token = card_links.make_token(sid, 1, datetime.now(UTC) + timedelta(days=7))
    body, sig = token.split(".")
    forged_payload = card_links.make_token(sid, 2, datetime.now(UTC) + timedelta(days=7))
    assert card_links.read_token(f"{forged_payload.split('.')[0]}.{sig}") is None
    assert card_links.read_token(f"{body}.{'0' * len(sig)}") is None
    for junk in ("", "abc", "a.b.c", "x" * 400, f"{body}"):
        assert card_links.read_token(junk) is None


def test_the_signing_key_is_the_admin_secret(monkeypatch):
    token = card_links.make_token(uuid.uuid4(), 1, datetime.now(UTC) + timedelta(days=7))
    monkeypatch.setattr(settings, "ADMIN_SECRET_KEY", "a-different-secret")
    assert card_links.read_token(token) is None


def test_links_last_the_configured_days(monkeypatch):
    monkeypatch.setattr(settings, "SALES_CARD_LINK_DAYS", 7)
    now = datetime(2026, 9, 23, tzinfo=UTC)
    assert card_links.link_expiry(now) == now + timedelta(days=7)


# ── the routes ──────────────────────────────────────────────────────────────


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_cards")
    stripe = FakeStripe()
    monkeypatch.setattr(stripe_quotes, "make_client", stripe.make_client)
    return stripe


@pytest.fixture
def billed(db, seeded_db, fake):
    """A Checkout-sold Gold whose card still sits on the SUBSCRIPTION."""
    sponsor = db.get(Sponsor, seeded_db["sponsor"].id)
    sponsor.status = "Active"
    sponsor.stripe_subscription_id = SUB
    db.add(
        SponsorBilling(
            sponsor_id=sponsor.id,
            stripe_customer_id=CUS,
            stripe_subscription_id=SUB,
            channel="self_serve",
            list_usd=2500,
            founder_usd=2100,
            price_usd=2100,
        )
    )
    db.commit()
    fake.add_customer(CUS, email="info@kennedy.com")
    fake.add_subscription(SUB, customer=CUS, tier="gold", default_payment_method="pm_sub_card1")
    return sponsor


def _mint(client, sponsor, headers):
    return client.post(f"/api/admin/sponsors/{sponsor.id}/billing/card-link", headers=headers)


def _path(url: str) -> str:
    base = settings.APP_BASE_URL.rstrip("/")
    assert url.startswith(f"{base}/api/billing/card/")
    return url[len(base) :]


def test_rep_mints_a_link_with_the_billing_email(client, db, billed, fake, auth_header):
    resp = _mint(client, billed, auth_header())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["email"] == "info@kennedy.com"
    expires = datetime.fromisoformat(body["expires_at"])
    assert timedelta(days=6, hours=23) < expires - datetime.now(UTC) <= timedelta(days=7)
    assert db.get(SponsorBilling, billed.id).card_link_version == 1
    assert db.query(BillingAudit).filter(BillingAudit.action == "card_link_created").count() == 1
    assert fake.posts() == []  # minting touches no Stripe state


def test_opening_the_link_moves_the_card_then_opens_the_portal(
    client, db, billed, fake, auth_header
):
    url = _mint(client, billed, auth_header()).json()["url"]
    resp = client.get(_path(url), follow_redirects=False)
    assert resp.status_code == 302, resp.text
    assert resp.headers["location"].startswith("https://billing.stripe.com/p/session/")
    assert resp.headers["cache-control"] == "no-store"

    posts = [(r.method, r.path) for r in fake.posts()]
    move_customer = posts.index(("POST", f"/v1/customers/{CUS}"))
    move_sub = posts.index(("POST", f"/v1/subscriptions/{SUB}"))
    portal = posts.index(("POST", "/v1/billing_portal/sessions"))
    assert move_customer < move_sub < portal  # R14 BEFORE the portal
    assert fake.customers[CUS]["invoice_settings"]["default_payment_method"] == "pm_sub_card1"
    assert fake.subscriptions[SUB]["default_payment_method"] is None

    session = fake.last("POST", "/v1/billing_portal/sessions").form
    assert session["customer"] == CUS
    assert session["flow_data[type]"] == "payment_method_update"
    assert session["flow_data[after_completion][type]"] == "redirect"
    done = f"{url}/done"
    assert session["return_url"] == done
    assert session["flow_data[after_completion][redirect][return_url]"] == done
    # the card-only configuration was created once, for this app
    config = fake.last("POST", "/v1/billing_portal/configurations").form
    assert config["features[payment_method_update][enabled]"] == "true"
    assert config["metadata[managed_by]"] == "circuits-com"


def test_a_new_link_revokes_the_old_one(client, db, billed, fake, auth_header):
    h = auth_header()
    old = _mint(client, billed, h).json()["url"]
    new = _mint(client, billed, h).json()["url"]
    gone = client.get(_path(old), follow_redirects=False)
    assert gone.status_code == 410
    assert gone.json()["detail"] == "This link has expired — ask your rep for a new one."
    assert client.get(_path(new), follow_redirects=False).status_code == 302
    assert client.get(_path(old) + "/done", follow_redirects=False).status_code == 410


def test_a_tampered_or_expired_token_is_410(client, db, billed, fake):
    db.get(SponsorBilling, billed.id).card_link_version = 1
    db.commit()
    expired = card_links.make_token(billed.id, 1, datetime.now(UTC) - timedelta(minutes=1))
    assert client.get(f"/api/billing/card/{expired}", follow_redirects=False).status_code == 410
    good = card_links.make_token(billed.id, 1, datetime.now(UTC) + timedelta(days=1))
    tampered = good[:-1] + ("0" if good[-1] != "0" else "1")
    assert client.get(f"/api/billing/card/{tampered}", follow_redirects=False).status_code == 410
    assert fake.tape == []


def test_the_public_routes_404_without_stripe(client, db, billed, monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "")
    token = card_links.make_token(billed.id, 0, datetime.now(UTC) + timedelta(days=1))
    assert client.get(f"/api/billing/card/{token}", follow_redirects=False).status_code == 404
    assert client.get(f"/api/billing/card/{token}/done", follow_redirects=False).status_code == 404


def test_done_pays_an_open_invoice_once_and_lands_on_join(client, db, billed, fake, auth_header):
    fake.add_open_invoice("in_000000000031", sub=SUB, amount=210000)
    url = _mint(client, billed, auth_header()).json()["url"]
    first = client.get(_path(url) + "/done", follow_redirects=False)
    assert first.status_code == 302
    assert first.headers["location"] == f"{settings.APP_BASE_URL.rstrip('/')}/join?card=updated"
    pays = fake.calls("POST", "/v1/invoices/in_000000000031/pay")
    assert len(pays) == 1
    assert pays[0].headers["Idempotency-Key"] == f"card-done:{billed.id}:1"
    assert fake.invoices["in_000000000031"]["status"] == "paid"
    row = db.query(SponsorPayment).filter_by(stripe_invoice_id="in_000000000031").one()
    assert row.status == "paid" and row.sponsor_id == billed.id

    again = client.get(_path(url) + "/done", follow_redirects=False)
    assert again.status_code == 302
    assert len(fake.calls("POST", "/v1/invoices/in_000000000031/pay")) == 1
    assert db.query(BillingAudit).filter(BillingAudit.action == "card_updated").count() == 1


def test_done_with_a_declined_card_still_lands_on_join(client, db, billed, fake, auth_header):
    fake.add_open_invoice("in_000000000032", sub=SUB, amount=210000)
    fake.pay_fails = True
    url = _mint(client, billed, auth_header()).json()["url"]
    resp = client.get(_path(url) + "/done", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"].endswith("/join?card=updated")


def test_send_invoice_subscriptions_get_no_card_link(client, db, billed, fake, auth_header):
    fake.subscriptions[SUB]["collection_method"] = "send_invoice"
    resp = _mint(client, billed, auth_header())
    assert resp.status_code == 409
    assert resp.json()["detail"] == (
        "This customer pays by emailed invoice — share the invoice link instead."
    )
    assert db.get(SponsorBilling, billed.id).card_link_version == 0
