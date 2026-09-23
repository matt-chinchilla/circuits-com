"""The hourly billing sweep (spec §10, T6) — its five duties, with an injected
clock, over the shared FakeStripe:

1. lapsed ``open`` holds → ``expired``;
2. post-activation follow-ups not yet done;
3. unresolved conflicts (cancel → refund every paid invoice → resolved);
4. dunning (D4): ``charge_automatically`` failing for more than 14 days AND
   live ``past_due``/``unpaid`` → cancel + void + ``Expired``; live
   ``active`` → the latest invoice re-mirrored and ``failing_since``
   recomputed (F5); ``send_invoice`` whose oldest open invoice is 14+ days past
   due → the same, found by ONE account-wide list (F14); live ``canceled`` →
   void only;
5. queued voids from ``customer.subscription.deleted``.

One bad row never stops the others, and an un-migrated schema is a warning.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.jobs import billing_sweep as sweep_cli
from app.models import Sponsor
from app.models.sales import BillingAudit, CheckoutIntent, SponsorBilling
from app.services import billing_sweep, category_cache, stripe_quotes
from tests.conftest import TestingSessionLocal
from tests.fake_stripe import FakeStripe

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


@pytest.fixture
def fake():
    return FakeStripe()


@pytest.fixture
def swept(db, fake, monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_sweep")
    monkeypatch.setattr(billing_sweep, "session_factory", TestingSessionLocal)
    monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)
    cleared: list[int] = []
    monkeypatch.setattr(category_cache, "clear", lambda: cleared.append(1))

    def go(now=NOW) -> dict:
        counts = billing_sweep.run_sweep(now)
        db.expire_all()
        return counts

    go.cleared = cleared
    return go


def _sponsor(
    db,
    seeded_db,
    *,
    sub: str,
    keyword: str,
    collection="charge_automatically",
    failing_days: int | None = None,
    status="Active",
    done=True,
    void_pending=False,
) -> Sponsor:
    sponsor = Sponsor(
        supplier_id=seeded_db["supplier1"].id,
        keyword=keyword,
        tier="Gold",
        status=status,
        amount=Decimal("2100"),
    )
    db.add(sponsor)
    db.flush()
    db.add(
        SponsorBilling(
            sponsor_id=sponsor.id,
            stripe_subscription_id=sub,
            stripe_customer_id="cus_sweep000001",
            collection_method=collection,
            channel="rep_code" if collection == "charge_automatically" else "quote",
            list_usd=2500,
            founder_usd=2100,
            price_usd=2100,
            failing_since=(NOW - timedelta(days=failing_days)) if failing_days else None,
            post_activation_done_at=NOW if done else None,
            void_pending=void_pending,
        )
    )
    db.commit()
    return sponsor


def _intent(db, *, status="open", expires_at, session=None, conflict=None) -> CheckoutIntent:
    row = CheckoutIntent(
        tier="gold",
        category_id=uuid.uuid4(),
        list_usd=2500,
        founder_usd=2100,
        price_usd=2100,
        channel="self_serve",
        company_name="Hold Co",
        email="ap@hold.example",
        status=status,
        conflict_reason=conflict,
        stripe_session_id=session,
        expires_at=expires_at,
    )
    db.add(row)
    db.commit()
    return row


# ── 1. holds ──────────────────────────────────────────────────────────────


def test_lapsed_holds_expire_and_live_ones_stay(db, swept):
    lapsed = _intent(db, expires_at=NOW - timedelta(minutes=1))
    live = _intent(db, expires_at=NOW + timedelta(minutes=20))
    counts = swept()
    assert counts["expired_holds"] == 1
    assert db.get(CheckoutIntent, lapsed.id).status == "expired"
    assert db.get(CheckoutIntent, live.id).status == "open"


# ── 2. post-activation ────────────────────────────────────────────────────


def test_pending_post_activation_is_retried(db, seeded_db, fake, swept):
    sponsor = _sponsor(db, seeded_db, sub="sub_pending00001", keyword="pending", done=False)
    fake.add_subscription(
        "sub_pending00001", customer="cus_sweep000001", default_payment_method="pm_card0000001"
    )
    counts = swept()
    assert counts["post_activation"] == 1
    assert db.get(SponsorBilling, sponsor.id).post_activation_done_at is not None


def test_an_expired_sponsor_gets_no_post_activation(db, seeded_db, fake, swept):
    _sponsor(db, seeded_db, sub="sub_gone0000001", keyword="gone", done=False, status="Expired")
    counts = swept()
    assert counts["post_activation"] == 0
    assert fake.tape == []


# ── 3. conflicts ──────────────────────────────────────────────────────────


def test_unresolved_conflicts_are_drained(db, fake, swept):
    intent = _intent(
        db,
        status="conflict",
        conflict="slot_taken",
        expires_at=NOW,
        session="cs_test_sweepconflict1",
    )
    fake.add_subscription("sub_loser000001", customer="cus_loser000001")
    fake.add_session("cs_test_sweepconflict1", status="complete")
    fake.sessions["cs_test_sweepconflict1"]["subscription"] = "sub_loser000001"
    fake.add_paid_invoice("in_loser000001", sub="sub_loser000001", pi="pi_l0001", amount=210000)
    counts = swept()
    assert counts["conflicts_resolved"] == 1
    assert db.get(CheckoutIntent, intent.id).resolved_at is not None
    audit = db.query(BillingAudit).filter_by(action="conflict_resolved").one()
    assert audit.actor == "system:sweep"


# ── 4. dunning ────────────────────────────────────────────────────────────


def test_fifteen_days_failing_and_past_due_is_cancelled(db, seeded_db, fake, swept):
    sponsor = _sponsor(db, seeded_db, sub="sub_dunned00001", keyword="dunned", failing_days=15)
    fake.add_subscription("sub_dunned00001", customer="cus_sweep000001", status="past_due")
    fake.add_open_invoice("in_dunned000001", sub="sub_dunned00001", amount=210000)
    counts = swept()

    assert counts["dunning_cancelled"] == 1
    assert fake.subscriptions["sub_dunned00001"]["status"] == "canceled"
    assert fake.invoices["in_dunned000001"]["status"] == "void"
    assert db.get(Sponsor, sponsor.id).status == "Expired"
    audit = db.query(BillingAudit).filter_by(action="dunning_cancelled").one()
    assert (audit.actor, audit.sponsor_id) == ("system:sweep", sponsor.id)
    assert swept.cleared, "an expired board must leave the category cache"


def test_unpaid_status_is_cancelled_too(db, seeded_db, fake, swept):
    _sponsor(db, seeded_db, sub="sub_unpaid00001", keyword="unpaid", failing_days=20)
    fake.add_subscription("sub_unpaid00001", customer="cus_sweep000001", status="unpaid")
    assert swept()["dunning_cancelled"] == 1


def test_a_recovered_payment_is_left_alone(db, seeded_db, fake, swept):
    sponsor = _sponsor(db, seeded_db, sub="sub_recover0001", keyword="recovered", failing_days=15)
    fake.add_subscription("sub_recover0001", customer="cus_sweep000001", status="active")
    counts = swept()
    assert counts["dunning_cancelled"] == 0
    assert fake.calls("DELETE", "/v1/subscriptions/sub_recover0001") == []
    assert db.get(Sponsor, sponsor.id).status == "Active"


def test_thirteen_days_is_inside_the_grace(db, seeded_db, fake, swept):
    _sponsor(db, seeded_db, sub="sub_grace000001", keyword="grace", failing_days=13)
    fake.add_subscription("sub_grace000001", customer="cus_sweep000001", status="past_due")
    counts = swept()
    assert counts["dunning_cancelled"] == 0
    assert fake.tape == [], "a row inside the grace window costs no Stripe call"


def test_an_invoiced_customer_fifteen_days_overdue_is_cancelled(db, seeded_db, fake, swept):
    sponsor = _sponsor(
        db, seeded_db, sub="sub_invoiced001", keyword="invoiced", collection="send_invoice"
    )
    fake.add_subscription(
        "sub_invoiced001", customer="cus_sweep000001", collection_method="send_invoice"
    )
    fake.add_open_invoice(
        "in_invoiced0001",
        sub="sub_invoiced001",
        amount=210000,
        created=int((NOW - timedelta(days=45)).timestamp()),
        due_date=int((NOW - timedelta(days=15)).timestamp()),
        collection_method="send_invoice",
    )
    assert swept()["dunning_cancelled"] == 1
    assert db.get(Sponsor, sponsor.id).status == "Expired"
    assert fake.invoices["in_invoiced0001"]["status"] == "void"


def test_an_invoiced_customer_ten_days_overdue_is_left_alone(db, seeded_db, fake, swept):
    sponsor = _sponsor(
        db, seeded_db, sub="sub_invoiced002", keyword="invoiced2", collection="send_invoice"
    )
    fake.add_subscription(
        "sub_invoiced002", customer="cus_sweep000001", collection_method="send_invoice"
    )
    fake.add_open_invoice(
        "in_invoiced0002",
        sub="sub_invoiced002",
        amount=210000,
        due_date=int((NOW - timedelta(days=10)).timestamp()),
        collection_method="send_invoice",
    )
    assert swept()["dunning_cancelled"] == 0
    assert db.get(Sponsor, sponsor.id).status == "Active"


def test_invoiced_customers_cost_one_list_call_not_two_per_row(db, seeded_db, fake, swept):
    """F14: the send_invoice check is ONE account-wide list of overdue open
    invoices; only a row that list names costs further calls (cancel + void)."""
    ts = lambda days: int((NOW - timedelta(days=days)).timestamp())  # noqa: E731
    overdue = _sponsor(
        db, seeded_db, sub="sub_manyinv0001", keyword="many1", collection="send_invoice"
    )
    for n, (sub, due) in enumerate(
        [("sub_manyinv0001", ts(15)), ("sub_manyinv0002", ts(10)), ("sub_manyinv0003", ts(-5))]
    ):
        if sub != "sub_manyinv0001":
            _sponsor(db, seeded_db, sub=sub, keyword=f"many{n + 1}", collection="send_invoice")
        fake.add_subscription(sub, customer="cus_sweep000001", collection_method="send_invoice")
        fake.add_open_invoice(
            f"in_manyinv000{n + 1}",
            sub=sub,
            amount=210000,
            created=ts(45),
            due_date=due,
            collection_method="send_invoice",
        )

    assert swept()["dunning_cancelled"] == 1

    lists = [r for r in fake.calls("GET", "/v1/invoices") if "subscription" not in r.params]
    assert len(lists) == 1
    assert lists[0].params == {
        "status": "open",
        "collection_method": "send_invoice",
        "due_date[lt]": str(ts(14)),
        "limit": "100",
    }
    assert fake.calls("GET", "/v1/subscriptions/sub_manyinv0001") == []
    touched = {r.path for r in fake.tape} | {r.params.get("subscription") for r in fake.tape}
    assert not any(
        "sub_manyinv0002" in (t or "") or "sub_manyinv0003" in (t or "") for t in touched
    )
    assert fake.subscriptions["sub_manyinv0001"]["status"] == "canceled"
    assert fake.subscriptions["sub_manyinv0002"]["status"] == "active"
    assert db.get(Sponsor, overdue.id).status == "Expired"
    assert (
        db.query(Sponsor)
        .filter(Sponsor.keyword.in_(["many2", "many3"]), Sponsor.status == "Active")
        .count()
        == 2
    )


def test_a_recovered_subscription_clears_failing_since_and_a_new_failure_starts_fresh(
    db, seeded_db, fake, swept
):
    """F5: live ``active`` → the sweep re-mirrors the latest invoice (repairing
    a lost invoice.paid) and recomputes failing_since. A later single failure
    then starts a FRESH clock — never an instant cancel on the next sweep."""
    from app.models.sales import SponsorPayment
    from app.services.stripe_webhook import apply_stripe_event

    sub = "sub_recover0002"
    old = NOW - timedelta(days=20)
    sponsor = _sponsor(db, seeded_db, sub=sub, keyword="recovered2", failing_days=20)
    db.add(
        SponsorPayment(
            stripe_invoice_id="in_lostpaid0001",
            stripe_subscription_id=sub,
            sponsor_id=sponsor.id,
            status="failed",
            amount_due_cents=210000,
            invoice_created_at=old,
        )
    )
    db.commit()
    fake.add_subscription(
        sub, customer="cus_sweep000001", status="active", latest_invoice="in_lostpaid0001"
    )
    fake.add_paid_invoice(
        "in_lostpaid0001", sub=sub, pi="pi_lostpaid01", amount=210000, created=int(old.timestamp())
    )

    assert swept()["dunning_cancelled"] == 0
    assert fake.calls("DELETE", f"/v1/subscriptions/{sub}") == []
    assert db.get(SponsorBilling, sponsor.id).failing_since is None
    assert db.query(SponsorPayment).filter_by(stripe_invoice_id="in_lostpaid0001").one().status == (
        "paid"
    )

    # One new failure a day before the next sweep.
    new_created = int((NOW - timedelta(days=1)).timestamp())
    apply_stripe_event(
        db,
        {
            "type": "invoice.payment_failed",
            "created": new_created + 60,
            "data": {
                "object": {
                    "id": "in_newfail00001",
                    "object": "invoice",
                    "customer": "cus_sweep000001",
                    "status": "open",
                    "attempted": True,
                    "amount_due": 210000,
                    "amount_paid": 0,
                    "created": new_created,
                    "parent": {
                        "type": "subscription_details",
                        "subscription_details": {"subscription": sub, "metadata": {}},
                    },
                }
            },
        },
    )
    db.expire_all()
    since = db.get(SponsorBilling, sponsor.id).failing_since
    assert since is not None
    assert (since if since.tzinfo else since.replace(tzinfo=UTC)).timestamp() == new_created

    fake.subscriptions[sub]["status"] = "past_due"
    assert swept(NOW + timedelta(hours=1))["dunning_cancelled"] == 0
    assert fake.subscriptions[sub]["status"] == "past_due"
    assert db.get(Sponsor, sponsor.id).status == "Active"


def test_a_subscription_canceled_elsewhere_only_voids(db, seeded_db, fake, swept):
    sponsor = _sponsor(db, seeded_db, sub="sub_elsewhere01", keyword="elsewhere", failing_days=20)
    fake.add_subscription("sub_elsewhere01", customer="cus_sweep000001", status="canceled")
    fake.add_open_invoice("in_elsewhere001", sub="sub_elsewhere01", amount=210000)
    counts = swept()
    assert counts["dunning_cancelled"] == 0
    assert fake.invoices["in_elsewhere001"]["status"] == "void"
    assert fake.calls("DELETE", "/v1/subscriptions/sub_elsewhere01") == []
    assert db.get(Sponsor, sponsor.id).status == "Active"


# ── 5. queued voids ───────────────────────────────────────────────────────


def test_queued_voids_are_voided_and_cleared(db, seeded_db, fake, swept):
    sponsor = _sponsor(
        db, seeded_db, sub="sub_deleted0001", keyword="deleted", status="Expired", void_pending=True
    )
    fake.add_subscription("sub_deleted0001", customer="cus_sweep000001", status="canceled")
    fake.add_open_invoice("in_deleted00001", sub="sub_deleted0001", amount=210000)
    assert swept()["voids"] == 1
    assert fake.invoices["in_deleted00001"]["status"] == "void"
    assert db.get(SponsorBilling, sponsor.id).void_pending is False


# ── resilience ────────────────────────────────────────────────────────────


def test_one_bad_row_does_not_stop_the_others(db, seeded_db, fake, swept):
    # The first row's subscription does not exist on Stripe (404).
    _sponsor(db, seeded_db, sub="sub_missing0001", keyword="missing", failing_days=20)
    good = _sponsor(db, seeded_db, sub="sub_dunned00002", keyword="dunned2", failing_days=20)
    fake.add_subscription("sub_dunned00002", customer="cus_sweep000001", status="past_due")
    counts = swept()
    assert counts["errors"] >= 1
    assert counts["dunning_cancelled"] == 1
    assert db.get(Sponsor, good.id).status == "Expired"


def test_an_unmigrated_schema_is_a_warning_not_a_crash(monkeypatch, caplog):
    bare = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    monkeypatch.setattr(billing_sweep, "session_factory", sessionmaker(bind=bare))
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_sweep")
    counts = billing_sweep.run_sweep(NOW)
    assert counts["schema_missing"] == 1
    assert "not migrated" in caplog.text


def test_without_a_stripe_key_only_the_holds_are_swept(db, fake, swept, monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", None)
    _intent(db, expires_at=NOW - timedelta(minutes=1))
    counts = swept()
    assert counts["expired_holds"] == 1
    assert counts["stripe_unconfigured"] == 1
    assert fake.tape == []


def test_the_sweeper_thread_never_starts_under_pytest(monkeypatch):
    assert settings.BILLING_SWEEP_ENABLED is False
    monkeypatch.setattr(billing_sweep, "_sweeper", None)
    billing_sweep.start_sweeper()
    assert billing_sweep._sweeper is None


def test_the_cli_runs_one_pass_at_the_given_clock(monkeypatch, capsys):
    seen: list[datetime] = []

    def fake_run(now=None):
        seen.append(now)
        return {"expired_holds": 2}

    monkeypatch.setattr(sweep_cli, "run_sweep", fake_run)
    assert sweep_cli.main(["--once", "--now", "2026-10-16T12:00:00"]) == 0
    assert seen == [datetime(2026, 10, 16, 12, 0, tzinfo=UTC)]
    assert json.loads(capsys.readouterr().out) == {"expired_holds": 2}
