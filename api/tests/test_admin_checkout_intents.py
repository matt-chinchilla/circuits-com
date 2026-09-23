"""Needs attention — /api/admin/checkout-intents (spec §9, LU-F14a/b).

The staff list of what billing needs a human for (unresolved conflicts, live
holds, failing payments) and the two actions that keep reps out of the Stripe
dashboard: retry a conflict's cancel + refund, and release a live hold.
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.config import settings
from app.models import Category, Sponsor
from app.models.sales import BillingAudit, CheckoutIntent, SponsorBilling
from app.services import stripe_quotes
from tests.fake_stripe import FakeStripe

URL = "/api/admin/checkout-intents"


@pytest.fixture
def fake(monkeypatch):
    stripe = FakeStripe()
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_attention")
    monkeypatch.setattr(stripe_quotes, "make_client", stripe.make_client)
    return stripe


def _intent(db, category, **overrides) -> CheckoutIntent:
    fields = {
        "tier": "gold",
        "category_id": category.id,
        "list_usd": 2500,
        "founder_usd": 2100,
        "price_usd": 2100,
        "channel": "self_serve",
        "sold_by": "Daniel",
        "company_name": "Needs Co",
        "email": "ap@needs.example",
        "status": "open",
        "expires_at": datetime.now(UTC) + timedelta(minutes=30),
    }
    fields.update(overrides)
    row = CheckoutIntent(**fields)
    db.add(row)
    db.commit()
    return row


@pytest.fixture
def child(seeded_db):
    return seeded_db["child"]


def test_attention_lists_conflicts_holds_and_failing(
    client, db, seeded_db, child, fake, auth_header
):
    other = Category(
        id=uuid.uuid4(),
        name="Crystals",
        slug="crystals-attn",
        icon="diamond",
        parent_id=seeded_db["parent"].id,
    )
    db.add(other)
    db.commit()
    hold = _intent(db, child)
    conflict = _intent(
        db,
        other,
        status="conflict",
        conflict_reason="slot_taken",
        stripe_session_id="cs_test_attention0001",
    )
    _intent(
        db,
        other,
        status="conflict",
        conflict_reason="amount_mismatch",
        resolved_at=datetime.now(UTC),
    )
    _intent(db, other, status="expired")  # neither a hold nor a conflict
    failing = Sponsor(
        supplier_id=seeded_db["supplier1"].id,
        keyword="failing-attn",
        tier="Gold",
        status="Active",
        amount=Decimal("2100"),
    )
    db.add(failing)
    db.flush()
    since = datetime.now(UTC) - timedelta(days=3)
    db.add(
        SponsorBilling(
            sponsor_id=failing.id,
            stripe_subscription_id="sub_failing0001",
            channel="rep_code",
            list_usd=2500,
            price_usd=2100,
            failing_since=since,
        )
    )
    db.commit()

    resp = client.get(f"{URL}/attention", headers=auth_header())
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert [c["id"] for c in body["conflicts"]] == [str(conflict.id)]
    row = body["conflicts"][0]
    assert row["conflict_reason"] == "slot_taken"
    assert row["category_name"] == "Crystals"
    assert (row["company_name"], row["email"], row["price_usd"]) == (
        "Needs Co",
        "ap@needs.example",
        2100,
    )

    assert [h["id"] for h in body["holds"]] == [str(hold.id)]
    assert body["holds"][0]["category_name"] == child.name
    assert body["holds"][0]["expires_at"]

    assert [f["sponsor_id"] for f in body["failing"]] == [str(failing.id)]
    f = body["failing"][0]
    assert f["supplier_name"] == seeded_db["supplier1"].name
    cancels = datetime.fromisoformat(f["cancels_on"])
    assert cancels.date() == (since + timedelta(days=settings.BILLING_GRACE_DAYS)).date()


def test_attention_lists_overdue_invoiced_customers(client, db, seeded_db, fake, auth_header):
    """F4: a rep-quoted (send_invoice) customer never "fails" a charge, so it
    is found by ONE list of overdue open invoices — failing since the due date,
    cancelled by the sweep a grace later."""
    now = datetime.now(UTC)
    rows = {}
    for key, due_in_days in (("overdue", -10), ("notdue", 5)):
        sponsor = Sponsor(
            supplier_id=seeded_db["supplier1"].id,
            keyword=f"invoiced-{key}",
            tier="Gold",
            status="Active",
            amount=Decimal("1850"),
        )
        db.add(sponsor)
        db.flush()
        sub = f"sub_attn{key}0001"
        db.add(
            SponsorBilling(
                sponsor_id=sponsor.id,
                stripe_subscription_id=sub,
                collection_method="send_invoice",
                channel="quote",
                list_usd=2500,
                price_usd=1850,
            )
        )
        due = int((now + timedelta(days=due_in_days)).timestamp())
        fake.add_subscription(sub, collection_method="send_invoice")
        fake.add_open_invoice(
            f"in_attn{key}0001",
            sub=sub,
            amount=185000,
            due_date=due,
            collection_method="send_invoice",
        )
        rows[key] = (sponsor, due)
    db.commit()

    resp = client.get(f"{URL}/attention", headers=auth_header())
    assert resp.status_code == 200, resp.text
    failing = resp.json()["failing"]
    sponsor, due = rows["overdue"]
    assert [f["sponsor_id"] for f in failing] == [str(sponsor.id)]
    row = failing[0]
    assert row["collection_method"] == "send_invoice"
    due_at = datetime.fromtimestamp(due, UTC)
    assert datetime.fromisoformat(row["failing_since"]) == due_at
    assert datetime.fromisoformat(row["cancels_on"]) == due_at + timedelta(
        days=settings.BILLING_GRACE_DAYS
    )
    lists = fake.calls("GET", "/v1/invoices")
    assert len(lists) == 1
    assert lists[0].params["collection_method"] == "send_invoice"
    assert lists[0].params["status"] == "open"


def test_attention_404s_without_stripe(client, seeded_db, auth_header, monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", None)
    assert client.get(f"{URL}/attention", headers=auth_header()).status_code == 404


def test_resolve_retries_the_cancel_and_refund(client, db, child, fake, auth_header):
    intent = _intent(
        db,
        child,
        status="conflict",
        conflict_reason="slot_taken",
        stripe_session_id="cs_test_attention0002",
    )
    fake.add_subscription("sub_loser000009", customer="cus_loser000009")
    fake.add_session("cs_test_attention0002", status="complete")
    fake.sessions["cs_test_attention0002"]["subscription"] = "sub_loser000009"
    fake.add_paid_invoice("in_loser000009", sub="sub_loser000009", pi="pi_l9", amount=210000)
    fake.add_paid_invoice("in_loser000010", sub="sub_loser000009", pi="pi_l10", amount=210000)

    resp = client.post(f"{URL}/{intent.id}/resolve", headers=auth_header())
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"resolved": True}
    db.refresh(intent)
    assert intent.resolved_at is not None
    assert fake.subscriptions["sub_loser000009"]["status"] == "canceled"
    # Every paid invoice is refunded in full, each under its own
    # conflict-refund key — not just "a" refund happened.
    refunds = fake.calls("POST", "/v1/refunds")
    assert sorted(r.form["payment_intent"] for r in refunds) == ["pi_l10", "pi_l9"]
    assert all("amount" not in r.form for r in refunds)
    assert {r.headers["Idempotency-Key"] for r in refunds} == {
        f"conflict-refund:{intent.id}:in_loser000009",
        f"conflict-refund:{intent.id}:in_loser000010",
    }
    assert fake.payment_intents["pi_l9"]["amount_refunded"] == 210000
    assert fake.payment_intents["pi_l10"]["amount_refunded"] == 210000
    audit = db.query(BillingAudit).filter_by(action="conflict_resolved").one()
    assert audit.actor == "admin"


def test_resolve_reports_a_failure_without_raising(client, db, child, fake, auth_header):
    intent = _intent(
        db,
        child,
        status="conflict",
        conflict_reason="slot_taken",
        stripe_session_id="cs_test_attention0003",
    )
    # The session is unknown to Stripe (404) → not resolved, still listed.
    resp = client.post(f"{URL}/{intent.id}/resolve", headers=auth_header())
    assert resp.status_code == 200
    assert resp.json() == {"resolved": False}


def test_resolve_refuses_what_is_not_a_conflict(client, db, child, fake, auth_header):
    hold = _intent(db, child)
    assert client.post(f"{URL}/{hold.id}/resolve", headers=auth_header()).status_code == 409
    assert (
        client.post(f"{URL}/{hold.id}/resolve", headers=auth_header()).json()["detail"]
        == "not_a_conflict"
    )
    assert client.post(f"{URL}/{uuid.uuid4()}/resolve", headers=auth_header()).status_code == 404
    assert client.post(f"{URL}/not-a-uuid/resolve", headers=auth_header()).status_code == 404


def test_release_expires_the_session_and_frees_the_hold(client, db, child, fake, auth_header):
    fake.add_session("cs_test_attention0004", status="open")
    hold = _intent(db, child, stripe_session_id="cs_test_attention0004")
    resp = client.post(f"{URL}/{hold.id}/release", headers=auth_header())
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"released": True}
    assert fake.sessions["cs_test_attention0004"]["status"] == "expired"
    db.refresh(hold)
    assert hold.status == "released"
    audit = db.query(BillingAudit).filter_by(action="hold_released").one()
    assert (audit.actor, audit.intent_id) == ("admin", hold.id)


@pytest.mark.parametrize(
    ("status", "payment_status"),
    [("complete", "paid"), ("complete", "unpaid"), ("open", "paid")],
)
def test_release_refuses_a_hold_whose_buyer_already_paid(
    client, db, child, fake, auth_header, status, payment_status
):
    """F1: the webhook may not have landed yet — releasing now would free the
    slot under a paying customer (and the activation would then refund them
    as a conflict). The session is READ before anything is expired."""
    sid = "cs_test_attention0014"
    fake.add_session(sid, status=status)
    fake.sessions[sid]["payment_status"] = payment_status
    hold = _intent(db, child, stripe_session_id=sid)

    resp = client.post(f"{URL}/{hold.id}/release", headers=auth_header())
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == "already_paid"
    db.refresh(hold)
    assert hold.status == "open"
    assert fake.sessions[sid]["status"] == status
    assert fake.calls("POST", f"/v1/checkout/sessions/{sid}/expire") == []
    assert db.query(BillingAudit).filter_by(action="hold_released").count() == 0


def test_release_reads_an_open_session_before_expiring_it(client, db, child, fake, auth_header):
    sid = "cs_test_attention0015"
    fake.add_session(sid, status="open")
    fake.sessions[sid]["payment_status"] = "unpaid"
    hold = _intent(db, child, stripe_session_id=sid)

    assert client.post(f"{URL}/{hold.id}/release", headers=auth_header()).json() == {
        "released": True
    }
    paths = [(r.method, r.path) for r in fake.tape]
    assert paths.index(("GET", f"/v1/checkout/sessions/{sid}")) < paths.index(
        ("POST", f"/v1/checkout/sessions/{sid}/expire")
    )
    assert fake.sessions[sid]["status"] == "expired"
    db.refresh(hold)
    assert hold.status == "released"


def test_release_of_an_already_expired_session_frees_the_hold(client, db, child, fake, auth_header):
    sid = "cs_test_attention0016"
    fake.add_session(sid, status="expired")
    fake.sessions[sid]["payment_status"] = "unpaid"
    hold = _intent(db, child, stripe_session_id=sid)

    assert client.post(f"{URL}/{hold.id}/release", headers=auth_header()).json() == {
        "released": True
    }
    assert fake.calls("POST", f"/v1/checkout/sessions/{sid}/expire") == []
    db.refresh(hold)
    assert hold.status == "released"


def test_release_reports_stripe_being_unreachable_and_keeps_the_hold(
    client, db, child, fake, auth_header
):
    # The session is unknown to Stripe (404): nothing is known about payment,
    # so the hold is NOT freed.
    hold = _intent(db, child, stripe_session_id="cs_test_attention0017")
    resp = client.post(f"{URL}/{hold.id}/release", headers=auth_header())
    assert resp.status_code == 502
    db.refresh(hold)
    assert hold.status == "open"


def test_release_of_a_hold_without_a_session_still_frees_it(client, db, child, fake, auth_header):
    hold = _intent(db, child)
    assert client.post(f"{URL}/{hold.id}/release", headers=auth_header()).json() == {
        "released": True
    }
    assert fake.tape == []


def test_release_of_something_not_held_is_a_no(client, db, child, fake, auth_header):
    done = _intent(db, child, status="completed")
    assert client.post(f"{URL}/{done.id}/release", headers=auth_header()).json() == {
        "released": False
    }


def test_a_viewer_cannot_act(client, db, child, fake, viewer_header):
    viewer = viewer_header()
    hold = _intent(db, child)
    resp = client.post(f"{URL}/{hold.id}/release", headers=viewer)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "read_only"
    assert client.post(f"{URL}/{hold.id}/resolve", headers=viewer).status_code == 403


def test_a_customer_is_refused(client, db, child, fake, seeded_db, auth_header):
    customer = auth_header(email="kennedy_user@test.example")
    resp = client.get(f"{URL}/attention", headers=customer)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "staff_only"
    hold = _intent(db, child)
    assert client.post(f"{URL}/{hold.id}/release", headers=customer).status_code == 403


def test_a_viewer_cannot_read_the_attention_list(client, db, fake, viewer_header):
    """R6: the list names paying customers and their failing charges — a view-only
    outsider is refused it like every other billing read."""
    resp = client.get(f"{URL}/attention", headers=viewer_header())
    assert resp.status_code == 403
    assert resp.json()["detail"] == "no_billing_access"
