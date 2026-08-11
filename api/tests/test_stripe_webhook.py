"""POST /api/stripe/webhook — the signature gate and the sponsors.status writer.

Two layers, tested at their own altitude:

* ``verify_stripe_signature`` — pure function, exercised directly with
  hand-built ``Stripe-Signature`` headers (Stripe's documented scheme:
  HMAC-SHA256 over ``"<t>.<body>"``, hex, possibly several ``v1`` entries).
* The route + ``apply_stripe_event`` — through the TestClient, asserting on
  the sponsor ROW, because the whole contract is "webhooks write
  sponsors.status only".

The slot-conflict path is ORGANIC: SQLite supports partial unique indexes, so
the test recreates migration 016's real predicate and lets the database raise,
proving the handler's rollback is load-bearing rather than asserting around a
monkeypatched commit.
"""

import hashlib
import hmac
import json
import time
import uuid

import pytest
from sqlalchemy import text

from app.config import settings
from app.models import Sponsor
from app.services.stripe_webhook import (
    SIGNATURE_TOLERANCE_SECONDS,
    sponsor_id_from_event,
    verify_stripe_signature,
)

SECRET = "whsec_test_0123456789abcdef"
URL = "/api/stripe/webhook"


def _sign(payload: bytes, secret: str = SECRET, t: int | None = None) -> str:
    t = int(time.time()) if t is None else t
    mac = hmac.new(secret.encode(), f"{t}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={t},v1={mac}"


_SIGN_FRESH = "sign-with-the-test-secret"  # sentinel: build a valid header


def _post(client, event: dict, header: str | None = _SIGN_FRESH):
    payload = json.dumps(event).encode()
    headers = {}
    resolved = _sign(payload) if header == _SIGN_FRESH else header
    if resolved is not None:
        headers["stripe-signature"] = resolved
    return client.post(URL, content=payload, headers=headers)


def _fresh_created() -> int:
    """A minute ahead: comfortably AFTER the fixture row's updated_at, so the
    ordering gate sees these builder events as current truth. Second-granular
    clocks would otherwise make 'created now' vs 'written now' a coin flip."""
    return int(time.time()) + 60


def _sub_deleted(sponsor_id: str) -> dict:
    return {
        "type": "customer.subscription.deleted",
        "created": _fresh_created(),
        "data": {"object": {"id": "sub_1", "metadata": {"sponsor_id": sponsor_id}}},
    }


def _invoice_event(event_type: str, sponsor_id: str, shape: str) -> dict:
    """An invoice event in either metadata location Stripe has shipped."""
    details = {"subscription": "sub_1", "metadata": {"sponsor_id": sponsor_id}}
    obj: dict = {"id": "in_1", "metadata": {}}
    if shape == "parent":  # API 2025-03-31 and later
        obj["parent"] = {"subscription_details": details}
    else:  # API 2022-11-15 through 2025-02
        obj["subscription_details"] = details
    return {"type": event_type, "created": _fresh_created(), "data": {"object": obj}}


@pytest.fixture
def webhook_secret(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", SECRET)


@pytest.fixture
def sponsor(db, seeded_db):
    """A KEYWORD sponsor on purpose: keyword placements are multi-occupant
    (never single-slot), so activating this row is legal under migration 016.
    conftest's seeded_db already holds the child category's one Gold slot with
    status NULL — which counts as active in the index predicate — so a second
    category-Gold row here would let the happy-path tests assert an outcome
    production's partial unique index forbids."""
    row = Sponsor(
        supplier_id=seeded_db["supplier1"].id,
        keyword="stripe-webhook-test",
        tier="Gold",
        status="Expired",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ── The signature scheme itself ─────────────────────────────────────────────


def test_valid_signature_verifies():
    body = b'{"type":"x"}'
    assert verify_stripe_signature(body, _sign(body), SECRET)


def test_tampered_body_fails():
    assert not verify_stripe_signature(b'{"evil":1}', _sign(b'{"good":1}'), SECRET)


def test_wrong_secret_fails():
    body = b"{}"
    assert not verify_stripe_signature(body, _sign(body, secret="whsec_other"), SECRET)


def test_stale_timestamp_fails_even_with_valid_mac():
    body = b"{}"
    old = int(time.time()) - SIGNATURE_TOLERANCE_SECONDS - 60
    assert not verify_stripe_signature(body, _sign(body, t=old), SECRET)


def test_future_timestamp_verifies_one_sided():
    """Stripe's SDK only refuses OLD timestamps: a receiver whose clock runs
    behind Stripe must keep verifying, or clock drift silently kills billing."""
    body = b"{}"
    assert verify_stripe_signature(body, _sign(body, t=int(time.time()) + 3600), SECRET)


def test_long_digit_timestamp_fails_closed_not_valueerror():
    """CPython ≥3.11 caps int() at 4,300 digits — a 5,000-digit t= passes
    isdigit() and must return False, never raise (pre-auth 500 otherwise)."""
    header = "t=" + "9" * 5000 + ",v1=" + "0" * 64
    assert not verify_stripe_signature(b"{}", header, SECRET)


def test_long_digit_timestamp_via_route_is_400(client, webhook_secret):
    resp = client.post(
        URL,
        content=b"{}",
        headers={"stripe-signature": "t=" + "9" * 5000 + ",v1=" + "0" * 64},
    )
    assert resp.status_code == 400


def test_secret_roll_second_v1_still_verifies():
    """During a secret roll Stripe signs with old AND new — any match passes."""
    body = b"{}"
    t = int(time.time())
    good = _sign(body, t=t).split("v1=")[1]
    assert verify_stripe_signature(body, f"t={t},v1={'0' * 64},v1={good}", SECRET)


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "v1=abc",  # no timestamp
        "t=123",  # no v1
        "t=notdigits,v1=abc",
        "t=123é,v1=abc",  # non-ASCII digits must not int() or crash
    ],
)
def test_malformed_headers_fail_closed(header):
    assert not verify_stripe_signature(b"{}", header, SECRET)


def test_non_ascii_v1_returns_false_not_typeerror():
    """compare_digest raises TypeError on non-ASCII str — the calendar 500 bug
    class. A hostile header byte must yield False, never a traceback."""
    assert not verify_stripe_signature(b"{}", f"t={int(time.time())},v1=café", SECRET)


def test_metadata_shapes_both_resolve():
    for shape in ("parent", "flat"):
        assert sponsor_id_from_event(_invoice_event("invoice.paid", "abc", shape)) == "abc"


# ── The route: transport gates ──────────────────────────────────────────────


def test_unconfigured_secret_is_404(client):
    # No webhook_secret fixture: the shipped default. The door does not exist.
    assert _post(client, {"type": "invoice.paid"}).status_code == 404


def test_missing_header_is_400(client, webhook_secret):
    assert _post(client, {"type": "invoice.paid"}, header=None).status_code == 400


def test_bad_signature_is_400(client, webhook_secret):
    resp = _post(client, {"type": "invoice.paid"}, header=f"t={int(time.time())},v1={'0' * 64}")
    assert resp.status_code == 400


def test_signed_garbage_json_is_400(client, webhook_secret):
    payload = b"not json"
    resp = client.post(URL, content=payload, headers={"stripe-signature": _sign(payload)})
    assert resp.status_code == 400


def test_oversize_body_is_400_from_the_cap_itself(client, webhook_secret):
    payload = b"0" * (256 * 1024 + 1)
    resp = client.post(URL, content=payload, headers={"stripe-signature": _sign(payload)})
    assert resp.status_code == 400
    # The detail pins WHICH gate fired: json.loads would also 400 this body
    # (leading zeros), which once let this test pass with the cap deleted.
    assert resp.json()["detail"] == "payload_too_large"


def test_realistic_multi_kb_event_clears_the_cap(client, webhook_secret, db, sponsor):
    """Real invoice.paid payloads run several KB. A mistyped cap would 400
    every genuine delivery — Stripe then retries for days and disables the
    endpoint — while every other test here posts a few hundred bytes."""
    event = _invoice_event("invoice.paid", str(sponsor.id), "parent")
    event["data"]["object"]["lines"] = {
        "data": [{"id": f"il_{i}", "description": "x" * 180} for i in range(30)]
    }
    resp = _post(client, event)
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "status_active"


# ── The writer: sponsors.status and nothing else ────────────────────────────


@pytest.mark.parametrize("shape", ["parent", "flat"])
def test_invoice_paid_activates_the_sponsor(client, webhook_secret, db, sponsor, shape):
    resp = _post(client, _invoice_event("invoice.paid", str(sponsor.id), shape))
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "status_active"
    db.refresh(sponsor)
    assert sponsor.status == "Active"
    assert sponsor.tier == "Gold"  # placement untouched, always


def test_subscription_deleted_expires_the_sponsor(client, webhook_secret, db, sponsor):
    sponsor.status = "Active"
    db.commit()
    resp = _post(client, _sub_deleted(str(sponsor.id)))
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "status_expired"
    db.refresh(sponsor)
    assert sponsor.status == "Expired"


def test_payment_failed_changes_nothing(client, webhook_secret, db, sponsor):
    """Grace period is an undecided business question — a failed charge must
    not release the slot on its own."""
    sponsor.status = "Active"
    db.commit()
    resp = _post(client, _invoice_event("invoice.payment_failed", str(sponsor.id), "parent"))
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "logged_payment_failed"
    db.refresh(sponsor)
    assert sponsor.status == "Active"


def test_unknown_sponsor_acks_without_retry_bait(client, webhook_secret):
    """A 4xx/5xx would make Stripe retry for days and then disable the
    endpoint; no retry conjures the missing row."""
    resp = _post(client, _sub_deleted(str(uuid.uuid4())))
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "unknown_sponsor"


def test_malformed_sponsor_id_acks(client, webhook_secret):
    resp = _post(client, _sub_deleted("not-a-uuid"))
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "bad_sponsor_id"


def test_missing_sponsor_id_acks(client, webhook_secret):
    resp = _post(client, {"type": "invoice.paid", "data": {"object": {"id": "in_1"}}})
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "no_sponsor_id"


def test_unhandled_event_type_acks(client, webhook_secret):
    resp = _post(client, {"type": "charge.refunded", "data": {"object": {}}})
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "ignored_event_type"


def test_already_current_status_is_a_noop(client, webhook_secret, db, sponsor):
    sponsor.status = "Active"
    db.commit()
    resp = _post(client, _invoice_event("invoice.paid", str(sponsor.id), "parent"))
    assert resp.json()["outcome"] == "unchanged"


def test_slot_conflict_rolls_back_and_still_acks(client, webhook_secret, db, seeded_db):
    """ORGANIC conflict through migration 016's real predicate, recreated in
    SQLite (partial unique indexes work there too). seeded_db's Gold sponsor
    already holds the child's slot with status NULL — NULL counts as active in
    the index — so activating a rival category-Gold must raise from the
    database itself. The handler must roll back (without it, the post-conflict
    logger access raises PendingRollbackError → 500 → Stripe retry spiral),
    keep 'Expired', and still 200 — a human resolves it in /admin/sponsors."""
    db.execute(
        text(
            "CREATE UNIQUE INDEX uq_active_gold_per_category ON sponsors (category_id) "
            "WHERE category_id IS NOT NULL AND lower(tier) = 'gold' "
            "AND (status = 'Active' OR status IS NULL)"
        )
    )
    db.commit()
    rival = Sponsor(
        supplier_id=seeded_db["supplier1"].id,
        category_id=seeded_db["child"].id,
        tier="Gold",
        status="Expired",
    )
    db.add(rival)
    db.commit()
    db.refresh(rival)

    resp = _post(client, _invoice_event("invoice.paid", str(rival.id), "parent"))
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "slot_conflict"
    db.refresh(rival)
    assert rival.status == "Expired"


# ── The ordering + Paused gates ─────────────────────────────────────────────


def test_stale_event_cannot_resurrect_an_expired_sponsor(client, webhook_secret, db, sponsor):
    """Replay / out-of-order delivery: an invoice.paid minted BEFORE the row's
    last write (a deliberate Expire, a cancellation) must be skipped — Stripe
    redelivers for days and the Dashboard has a Resend button."""
    sponsor.status = "Expired"
    db.commit()
    event = _invoice_event("invoice.paid", str(sponsor.id), "parent")
    event["created"] = int(time.time()) - 3600
    resp = _post(client, event)
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "stale_event"
    db.refresh(sponsor)
    assert sponsor.status == "Expired"


def test_stale_deleted_cannot_expire_a_reactivated_sponsor(client, webhook_secret, db, sponsor):
    """The gate cuts both ways: a replayed deletion must not expire a sponsor
    an admin has since re-activated."""
    sponsor.status = "Active"
    db.commit()
    event = _sub_deleted(str(sponsor.id))
    event["created"] = int(time.time()) - 3600
    resp = _post(client, event)
    assert resp.json()["outcome"] == "stale_event"
    db.refresh(sponsor)
    assert sponsor.status == "Active"


def test_event_without_created_still_applies(client, webhook_secret, db, sponsor):
    """The gate is tolerant: a payload missing `created` (never true of real
    Stripe events) falls through to the write rather than being dropped."""
    event = _invoice_event("invoice.paid", str(sponsor.id), "parent")
    del event["created"]
    resp = _post(client, event)
    assert resp.json()["outcome"] == "status_active"


def test_invoice_paid_leaves_a_paused_sponsor_paused(client, webhook_secret, db, sponsor):
    """Paused = admin-only visibility lever over a still-billing subscription
    ('Active' | 'Paused' | 'Expired' in the admin form). The monthly
    invoice.paid must not un-pause it."""
    sponsor.status = "Paused"
    db.commit()
    resp = _post(client, _invoice_event("invoice.paid", str(sponsor.id), "parent"))
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "left_paused"
    db.refresh(sponsor)
    assert sponsor.status == "Paused"


def test_subscription_deleted_does_expire_a_paused_sponsor(client, webhook_secret, db, sponsor):
    """The Paused gate protects only against un-pausing: when the underlying
    subscription is genuinely gone, Expired is the truer state."""
    sponsor.status = "Paused"
    db.commit()
    resp = _post(client, _sub_deleted(str(sponsor.id)))
    assert resp.json()["outcome"] == "status_expired"
    db.refresh(sponsor)
    assert sponsor.status == "Expired"
