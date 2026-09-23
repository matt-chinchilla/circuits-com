"""Checkout intents — the core helpers T4 builds the public routes on (spec §6/§7)."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from app.config import settings
from app.models import CheckoutIntent
from app.services import checkout_intents as ci

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


def _intent(db, *, status=ci.OPEN, expires_at, tier="gold") -> CheckoutIntent:
    row = CheckoutIntent(
        tier=tier,
        category_id=uuid.uuid4(),
        list_usd=2500,
        founder_usd=2100,
        price_usd=2100,
        channel="self_serve",
        sold_by="Daniel",
        company_name="Acme",
        email="a@acme.test",
        status=status,
        expires_at=expires_at,
    )
    db.add(row)
    db.commit()
    return row


def test_status_literals_and_timings():
    assert (ci.OPEN, ci.COMPLETED, ci.EXPIRED, ci.RELEASED, ci.CONFLICT) == (
        "open",
        "completed",
        "expired",
        "released",
        "conflict",
    )
    assert ci.STRIPE_SESSION_MINUTES == 35 and ci.HOLD_GRACE_MINUTES == 10


def test_expire_lapsed_flips_only_open_rows_past_their_expiry(db):
    lapsed = _intent(db, expires_at=NOW - timedelta(seconds=1))
    lapsed_silver = _intent(db, expires_at=NOW - timedelta(minutes=5), tier="silver")
    live = _intent(db, expires_at=NOW + timedelta(minutes=1))
    at_the_instant = _intent(db, expires_at=NOW)
    completed = _intent(db, status=ci.COMPLETED, expires_at=NOW - timedelta(hours=1))
    conflict = _intent(db, status=ci.CONFLICT, expires_at=NOW - timedelta(hours=1))
    released = _intent(db, status=ci.RELEASED, expires_at=NOW - timedelta(hours=1))

    assert ci.expire_lapsed(db, now=NOW) == 2
    db.commit()
    for row in (lapsed, lapsed_silver, live, at_the_instant, completed, conflict, released):
        db.refresh(row)
    assert lapsed.status == ci.EXPIRED and lapsed_silver.status == ci.EXPIRED
    assert live.status == ci.OPEN and at_the_instant.status == ci.OPEN
    assert completed.status == ci.COMPLETED
    assert conflict.status == ci.CONFLICT
    assert released.status == ci.RELEASED


def test_expire_lapsed_does_not_commit(db):
    row = _intent(db, expires_at=NOW - timedelta(seconds=1))
    assert ci.expire_lapsed(db, now=NOW) == 1
    db.rollback()
    db.refresh(row)
    assert row.status == ci.OPEN


def test_expire_lapsed_frees_the_slot_in_the_same_transaction(db):
    """Spec §6: the transaction that takes a hold first expires the lapsed one."""
    cat = uuid.uuid4()
    old = _intent(db, expires_at=NOW - timedelta(minutes=1))
    old.category_id = cat
    db.commit()
    ci.expire_lapsed(db, now=NOW)
    db.add(
        CheckoutIntent(
            tier="gold",
            category_id=cat,
            list_usd=2500,
            founder_usd=2100,
            price_usd=2100,
            channel="self_serve",
            company_name="Beta",
            email="b@beta.test",
            status=ci.OPEN,
            expires_at=NOW + timedelta(minutes=45),
        )
    )
    db.commit()  # no IntegrityError from uq_live_exclusive_intent


def test_expire_lapsed_defaults_to_the_wall_clock(db):
    row = _intent(db, expires_at=datetime.now(UTC) - timedelta(seconds=5))
    assert ci.expire_lapsed(db) == 1
    db.commit()
    db.refresh(row)
    assert row.status == ci.EXPIRED


def test_hash_token_is_stable_sha256_hex():
    assert ci.hash_token("abc") == hashlib.sha256(b"abc").hexdigest()
    assert ci.hash_token("abc") == ci.hash_token("abc")
    assert ci.hash_token("abc") != ci.hash_token("abd")
    assert len(ci.hash_token("x")) == 64


def test_client_ip_hash_is_keyed_and_truncated():
    expected = hashlib.sha256(("203.0.113.9" + settings.ADMIN_SECRET_KEY).encode()).hexdigest()
    assert ci.client_ip_hash("203.0.113.9") == expected[:32]
    assert len(ci.client_ip_hash("::1")) == 32
    assert ci.client_ip_hash("203.0.113.9") != ci.client_ip_hash("203.0.113.10")
