"""The hourly billing sweep (spec §10, R5) — a daemon thread inside the api
process, like the category-cache warmer: no new container on the memory-short
box, and it can clear the in-process category cache when it expires a board.

Five duties, each row on its own so one failure never stops the others:

1. Lapsed ``open`` holds → ``expired`` (``checkout_intents.expire_lapsed``).
2. Post-activation follow-ups not done yet (§8.5) — the backstop for the
   webhook's background task, and the R14 card move for sponsors that
   predate it (057 backfilled their billing rows with no done stamp).
3. Unresolved conflicts: cancel → refund every paid invoice → resolved.
4. Dunning (D4): a ``charge_automatically`` subscription whose
   ``failing_since`` is older than ``BILLING_GRACE_DAYS`` costs ONE read of
   the live subscription. ``past_due``/``unpaid`` → cancelled, its open
   invoices voided, the sponsor ``Expired`` and audited ``dunning_cancelled``.
   ``active``/``trialing`` → recovered: its ``latest_invoice`` is re-mirrored
   (a lost ``invoice.paid`` is repaired) and ``failing_since`` recomputed from
   the mirror, so a later failure starts a fresh clock. ``canceled`` (someone
   else ended it; the webhook already expired the row) → open invoices voided
   only. ``send_invoice`` subscriptions (rep quotes: emailed invoices never
   "fail") cost ONE account-wide list of open ``send_invoice`` invoices due
   before now − grace, whatever their number; only the subscriptions that list
   names pay for the cancel + void. Stripe's own Smart Retries must be set to
   "leave past-due" for 3 weeks (an owner Dashboard step), so this sweep is
   the only thing that ends a sponsorship.
5. Voids queued by ``customer.subscription.deleted``.

``run_sweep(now=…)`` takes an injectable clock (the rehearsal lever is
``python -m app.jobs.billing_sweep --once --now <ISO>``) and survives a schema
the migration has not reached yet. Off under pytest (``BILLING_SWEEP_ENABLED``).
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import SessionLocal
from app.models import Sponsor
from app.models.sales import CheckoutIntent, SponsorBilling
from app.models.sponsor import exclusive_occupant_clause
from app.services import billing_followups, category_cache, stripe_billing, stripe_quotes
from app.services.billing_mirror import (
    audit,
    invoice_subscription_id,
    recompute_failing_since,
    upsert_payment_from_invoice,
)
from app.services.checkout_intents import CONFLICT, expire_lapsed
from app.services.stripe_quotes import _call

logger = logging.getLogger(__name__)

SWEEP_ACTOR = "system:sweep"
SWEEP_INTERVAL_SECONDS = 3600
LIVE_FAILING = ("past_due", "unpaid")
LIVE_RECOVERED = ("active", "trialing")

# Seam for tests (the suite binds its own engine), like category_cache's.
session_factory = SessionLocal

_sweeper: threading.Thread | None = None

_COUNTERS = (
    "expired_holds",
    "post_activation",
    "conflicts_resolved",
    "dunning_cancelled",
    "voids",
    "errors",
)


def _is_missing_schema(exc: Exception) -> bool:
    """Migration 057 has not run here yet (Postgres: ``… does not exist``;
    SQLite: ``no such table``) — the jobs' shared reading of that error."""
    text = str(getattr(exc, "orig", exc)).lower()
    return "does not exist" in text or "no such table" in text or "no such column" in text


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


async def _each(db: Session, counts: dict, counter: str, what: str, coro) -> None:
    """Run one row's work; count a True, count and swallow any failure."""
    try:
        if await coro:
            counts[counter] += 1
    except Exception:  # noqa: BLE001 - one row must never stop the sweep
        db.rollback()
        counts["errors"] += 1
        logger.exception("billing sweep: %s failed", what)


def _not_expired_billed(db: Session):
    return (
        db.query(SponsorBilling, Sponsor)
        .join(Sponsor, Sponsor.id == SponsorBilling.sponsor_id)
        .filter(SponsorBilling.stripe_subscription_id.isnot(None), exclusive_occupant_clause())
    )


async def _release(
    db: Session, client, billing: SponsorBilling, sponsor: Sponsor, reason: str
) -> None:
    """Cancel the subscription now, void its open invoices, expire the board."""
    sub_id = billing.stripe_subscription_id
    await stripe_billing.cancel_now(client, sub_id, f"dunning-cancel:{sub_id}")
    await stripe_billing.void_open_invoices(client, sub_id)
    sponsor.status = "Expired"
    billing.void_pending = False
    audit(db, SWEEP_ACTOR, "dunning_cancelled", sponsor_id=sponsor.id, detail=reason)
    db.commit()
    category_cache.clear()
    logger.warning("billing sweep: sponsor %s released — %s", sponsor.id, reason)


async def _repair_recovered(db: Session, client, sub: dict, sub_id: str) -> None:
    """A live ``active`` subscription whose row still says failing: re-mirror
    its latest invoice (repairs a lost ``invoice.paid``), then derive
    ``failing_since`` from the mirror again (F5)."""
    latest = sub.get("latest_invoice")
    if isinstance(latest, str) and latest:
        latest = await _call(
            client, "GET", f"/v1/invoices/{stripe_billing.checked_id('in', latest)}"
        )
    if isinstance(latest, dict) and invoice_subscription_id(latest) == sub_id:
        upsert_payment_from_invoice(db, latest)
    recompute_failing_since(db, sub_id)
    db.commit()


async def _dun_card(db: Session, client, billing: SponsorBilling, sponsor: Sponsor) -> bool:
    """A ``charge_automatically`` row failing past the grace: one read of the
    live subscription decides."""
    sub_id = billing.stripe_subscription_id
    sub = await stripe_billing.get_subscription(client, sub_id)
    status = sub.get("status")
    if status == "canceled":
        voided = await stripe_billing.void_open_invoices(client, sub_id)
        if voided:
            logger.info("billing sweep: voided %d open invoice(s) of canceled %s", voided, sub_id)
        return False
    if status in LIVE_RECOVERED:
        await _repair_recovered(db, client, sub, sub_id)
        return False
    if status not in LIVE_FAILING:
        return False
    since = _utc(billing.failing_since)
    reason = f"payments failing since {since.date().isoformat() if since else '?'} ({status})"
    await _release(db, client, billing, sponsor, reason)
    return True


async def _dun_invoiced(
    db: Session, client, billing: SponsorBilling, sponsor: Sponsor, oldest: dict
) -> bool:
    """A ``send_invoice`` row the overdue list named: no further reads."""
    due = oldest.get("due_date")
    due_on = datetime.fromtimestamp(due, UTC).date().isoformat() if isinstance(due, int) else "?"
    await _release(db, client, billing, sponsor, f"invoice {oldest.get('id')} due {due_on} unpaid")
    return True


def _oldest_overdue_by_subscription(invoices: list[dict]) -> dict[str, dict]:
    """Subscription id → its oldest-due overdue invoice."""
    found: dict[str, dict] = {}
    for invoice in invoices:
        sub_id = invoice_subscription_id(invoice)
        if not sub_id:
            continue
        key = (invoice.get("due_date") or 0, invoice.get("id") or "")
        held = found.get(sub_id)
        if held is None or key < (held.get("due_date") or 0, held.get("id") or ""):
            found[sub_id] = invoice
    return found


async def _stripe_duties(db: Session, key: str, now: datetime, counts: dict) -> None:
    async with stripe_quotes.make_client(key) as client:
        # 2. post-activation not done (live sponsors only).
        pending = [
            billing.sponsor_id
            for billing, _ in _not_expired_billed(db)
            .filter(SponsorBilling.post_activation_done_at.is_(None))
            .all()
        ]
        for sponsor_id in pending:
            await _each(
                db,
                counts,
                "post_activation",
                f"post-activation for {sponsor_id}",
                billing_followups.post_activation(db, client, sponsor_id),
            )

        # 3. conflicts still owed a cancel + refund.
        conflicts = [
            row.id
            for row in db.query(CheckoutIntent.id)
            .filter(CheckoutIntent.status == CONFLICT, CheckoutIntent.resolved_at.is_(None))
            .all()
        ]
        for intent_id in conflicts:
            await _each(
                db,
                counts,
                "conflicts_resolved",
                f"conflict {intent_id}",
                billing_followups.resolve_conflict(db, client, intent_id, actor=SWEEP_ACTOR),
            )

        # 4. dunning. Only rows that could be due cost a Stripe call: card rows
        # failing past the grace (one subscription read each), and invoiced
        # rows the ONE overdue-invoice list names (F14).
        cutoff = now - timedelta(days=settings.BILLING_GRACE_DAYS)
        card_rows = (
            _not_expired_billed(db)
            .filter(
                SponsorBilling.collection_method != "send_invoice",
                SponsorBilling.failing_since.isnot(None),
                SponsorBilling.failing_since < cutoff,
            )
            .all()
        )
        for billing, sponsor in card_rows:
            await _each(
                db,
                counts,
                "dunning_cancelled",
                f"dunning for sponsor {sponsor.id}",
                _dun_card(db, client, billing, sponsor),
            )

        invoiced = {
            billing.stripe_subscription_id: (billing, sponsor)
            for billing, sponsor in _not_expired_billed(db)
            .filter(SponsorBilling.collection_method == "send_invoice")
            .all()
        }
        if invoiced:
            try:
                overdue = _oldest_overdue_by_subscription(
                    await stripe_billing.list_overdue_send_invoice_invoices(client, cutoff)
                )
            except Exception:  # noqa: BLE001 - the list failing must not stop duty 5
                counts["errors"] += 1
                logger.exception("billing sweep: listing overdue invoices failed")
                overdue = {}
            for sub_id, oldest in overdue.items():
                if sub_id not in invoiced:
                    continue
                billing, sponsor = invoiced[sub_id]
                await _each(
                    db,
                    counts,
                    "dunning_cancelled",
                    f"dunning for invoiced sponsor {sponsor.id}",
                    _dun_invoiced(db, client, billing, sponsor, oldest),
                )

        # 5. voids queued by customer.subscription.deleted.
        queued = [
            row.sponsor_id
            for row in db.query(SponsorBilling.sponsor_id)
            .filter(SponsorBilling.void_pending.is_(True))
            .all()
        ]
        for sponsor_id in queued:
            await _each(
                db,
                counts,
                "voids",
                f"queued void for {sponsor_id}",
                billing_followups.void_pending(db, client, sponsor_id),
            )


def run_sweep(now: datetime | None = None) -> dict:
    """One pass over the five duties; returns a count per duty. Synchronous —
    the Stripe parts run under ``asyncio.run`` on this thread."""
    now = _utc(now) or datetime.now(UTC)
    counts: dict[str, int] = dict.fromkeys(_COUNTERS, 0)
    db = session_factory()
    try:
        try:
            counts["expired_holds"] = expire_lapsed(db, now)
            db.commit()
            key = (settings.STRIPE_SECRET_KEY or "").strip()
            if not key:
                counts["stripe_unconfigured"] = 1
                return counts
            asyncio.run(_stripe_duties(db, key, now, counts))
        except (ProgrammingError, OperationalError) as exc:
            db.rollback()
            if not _is_missing_schema(exc):
                raise
            logger.warning("billing sweep: the sales schema is not migrated yet (057) — skipped")
            counts["schema_missing"] = 1
    finally:
        db.close()
    logger.info("billing sweep: %s", counts)
    return counts


def start_sweeper() -> None:
    """Run the sweep now and then on every hour boundary, on a daemon thread.
    Idempotent per process; a no-op when ``BILLING_SWEEP_ENABLED`` is off."""
    global _sweeper
    if not settings.BILLING_SWEEP_ENABLED:
        return
    if _sweeper is not None and _sweeper.is_alive():
        return

    def loop() -> None:
        while True:
            try:
                run_sweep()
            except Exception:  # noqa: BLE001 - the thread must outlive any pass
                logger.exception("billing sweep: pass failed")
            # To the next hour BOUNDARY (the sync_costs rhythm), not "+1h".
            time.sleep(SWEEP_INTERVAL_SECONDS - (time.time() % SWEEP_INTERVAL_SECONDS))

    _sweeper = threading.Thread(target=loop, name="billing-sweep", daemon=True)
    _sweeper.start()
