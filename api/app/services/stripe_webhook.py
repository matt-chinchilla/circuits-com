"""Stripe webhook intake — signature verification + the sponsors.status writer.

Contract (CLAUDE.md, Stripe): a billing event writes ``sponsors.status`` ONLY.
Placement — tier, category_id, keyword — is decided by humans in the admin,
and nothing that arrives over the wire may move a company to a different slot.

Verification is hand-rolled on purpose: the app only ever CONSUMES webhooks
(subscriptions are created sales-side, in the Dashboard), so fifteen lines of
HMAC beat a whole SDK dependency in the container. The scheme is Stripe's
documented one: ``Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`` where each
``v1`` is HMAC-SHA256 over ``"<t>.<raw body>"`` keyed with the endpoint's
``whsec_`` secret. Multiple ``v1`` entries are legitimate — Stripe sends two
while an endpoint's secret is being rolled — so ANY match passes.

Event → status map (everything else is acknowledged and ignored):

    invoice.paid                     → "Active"
    customer.subscription.deleted    → "Expired"
    invoice.payment_failed           → log only. How long a delinquent sponsor
                                       keeps an exclusive slot is a business
                                       decision nobody has made yet (the grace
                                       -period open question); until someone
                                       does, a failed charge must not silently
                                       release a Platinum placement.

Two gates run before any write. An event ``created`` before the sponsor row's
last write is skipped ("stale_event") — Stripe delivery is unordered and
at-least-once, and a replayed invoice.paid must not resurrect a deliberately
Expired sponsor. And a Paused sponsor stays Paused ("left_paused") — Paused is
an admin visibility lever over a still-billing subscription, so only the human
who set it may clear it.

The sponsor is resolved through ``sponsor_id`` in the SUBSCRIPTION's metadata,
which the sales rep stamps when creating the subscription. On invoice events
that metadata surfaces at a spot that moved across Stripe API versions —
``parent.subscription_details.metadata`` (2025-03-31+) vs
``subscription_details.metadata`` (2022-11-15 …) — so both are read.

Every recognized-but-unactionable payload (no sponsor_id, unknown sponsor,
slot conflict) returns normally so the route can 200: a non-2xx makes Stripe
retry for days and eventually disable the endpoint, and no amount of retrying
fixes a row that isn't there. The outcome string is the audit trail — it lands
in the response body (visible in the Dashboard's delivery log) and in ours.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Sponsor

# The tz-normalizer lives with the calendar model, which faced the identical
# Postgres-aware / SQLite-naive split first; it is THE home, not a borrow.
from app.models.calendar_event import as_utc

logger = logging.getLogger(__name__)

# Stripe's own SDK default. Outside it a replayed capture is rejected even
# with a valid signature.
SIGNATURE_TOLERANCE_SECONDS = 300


def verify_stripe_signature(
    payload: bytes, header: str | None, secret: str, *, now: int | None = None
) -> bool:
    """True iff ``header`` proves Stripe signed exactly ``payload`` recently.

    The signed message uses the timestamp STRING as it appears in the header,
    not a re-serialized int — re-formatting (leading zero, whitespace) would
    change the bytes and break verification of a legitimately signed request.
    """
    if not header or not secret:
        return False

    timestamp: str | None = None
    candidates: list[str] = []
    for element in header.split(","):
        key, _, value = element.strip().partition("=")
        if key == "t" and timestamp is None:
            timestamp = value
        elif key == "v1" and value:
            candidates.append(value)

    if timestamp is None or not timestamp.isascii() or not timestamp.isdigit():
        return False
    # Length-bound BEFORE int(): CPython ≥3.11 raises ValueError past 4,300
    # digits, and isdigit() happily passes a 5,000-digit run — an anonymous
    # caller could 500 this route with a fat header. 20 digits outlives the sun.
    if len(timestamp) > 20:
        return False
    if not candidates:
        return False

    # One-sided, like Stripe's own SDK: only OLD timestamps are refused. A
    # future timestamp just means OUR clock runs behind Stripe's — rejecting it
    # (abs()) would silently kill every webhook after clock drift, and blocks
    # no attack: nobody can mint a valid MAC over a chosen timestamp anyway.
    current = int(time.time()) if now is None else now
    if current - int(timestamp) > SIGNATURE_TOLERANCE_SECONDS:
        return False

    expected = hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("ascii") + b"." + payload,
        hashlib.sha256,
    ).hexdigest().encode("ascii")
    # Bytes on both sides (the calendar gotcha): compare_digest raises
    # TypeError on str args with any character above U+007F, and headers
    # arrive latin-1-decoded, so a hostile header could otherwise 500.
    return any(
        hmac.compare_digest(expected, candidate.encode("latin-1", "replace"))
        for candidate in candidates
    )


def _dig(mapping: object, *keys: str) -> object:
    for key in keys:
        if not isinstance(mapping, dict):
            return None
        mapping = mapping.get(key)
    return mapping


def sponsor_id_from_event(event: dict) -> str | None:
    """The ``sponsor_id`` the sales rep stamped on the subscription, or None.

    Checked in order: the object's own metadata (subscription events carry the
    subscription itself), then the two invoice-event locations that differ by
    Stripe API version. An invoice's OWN metadata is empty in this flow, so
    reading it first is harmless — the loop only stops on a hit.
    """
    obj = _dig(event, "data", "object")
    for path in (
        ("metadata",),
        ("parent", "subscription_details", "metadata"),
        ("subscription_details", "metadata"),
    ):
        meta = _dig(obj, *path)
        if isinstance(meta, dict):
            sponsor_id = meta.get("sponsor_id")
            if isinstance(sponsor_id, str) and sponsor_id.strip():
                return sponsor_id.strip()
    return None


def _handle_checkout_completed(db: Session, event: dict) -> str:
    """Self-serve Silver purchase: create the supplier + the ACTIVE sponsor.

    Four gates before anything is written, all acking 200 (a non-2xx makes
    Stripe retry for days then disable the endpoint): payment actually cleared;
    the subscription id exists to OWN the row; the total is the sticker price;
    and this subscription has not already been recorded (idempotency). A
    self-serve buyer ALWAYS gets a fresh supplier row — the buyer-typed name is
    a label, never an identity to match against the catalog. The subscription
    id is stamped on the row so later renew/cancel events resolve by it, not by
    the public, forgeable company name.

    ``sold_by`` is stamped with the onboarding rep so the dashboard's sales-reps
    chart credits the desk for deals it onboards, not only deals it closes.
    """
    from decimal import Decimal

    from app.config import settings
    from app.models import Supplier

    from .stripe_checkout import silver_monthly_usd

    obj = _dig(event, "data", "object")
    if not isinstance(obj, dict):
        return "bad_checkout_metadata"
    meta = obj.get("metadata")
    if not isinstance(meta, dict):
        meta = {}
    if meta.get("self_serve") != "silver" or meta.get("managed_by") != "circuits-com":
        return "ignored_checkout"

    # GATE 1 — money actually cleared. checkout.session.completed fires for
    # subscription sessions even when the first payment is still 'unpaid'
    # (an incomplete subscription). Activating on that would put a
    # never-paid company on the board. Only 'paid' (or the no-charge case)
    # may activate.
    if obj.get("payment_status") not in ("paid", "no_payment_required"):
        logger.info(
            "stripe: checkout session %s completed unpaid (%s) — not activated",
            obj.get("id"),
            obj.get("payment_status"),
        )
        return "checkout_unpaid"

    # GATE 2 — the subscription id is the row's OWNER. Without it there is no
    # safe way to resolve later renew/cancel events, so refuse rather than
    # create an unowned row.
    subscription_id = obj.get("subscription")
    if not isinstance(subscription_id, str) or not subscription_id.strip():
        logger.warning("stripe: checkout session %s carried no subscription id", obj.get("id"))
        return "bad_checkout_metadata"
    subscription_id = subscription_id.strip()

    company = str(meta.get("company_name") or "").strip()[:200]
    category_id = str(meta.get("category_id") or "").strip() or None
    keyword = str(meta.get("keyword") or "").strip() or None
    if not company or bool(category_id) == bool(keyword):
        logger.warning("stripe: checkout session %s carried unusable metadata", obj.get("id"))
        return "bad_checkout_metadata"
    category_key: uuid.UUID | None = None
    if category_id:
        try:
            category_key = uuid.UUID(category_id)
        except ValueError:
            logger.warning("stripe: checkout session %s carried bad category id", obj.get("id"))
            return "bad_checkout_metadata"

    # GATE 3 — the sticker is the price. Tax-inclusive Silver bills exactly
    # $100; anything else means a misconfigured price, not a sale to publish.
    expected_cents = silver_monthly_usd() * 100
    amount_total = obj.get("amount_total")
    if isinstance(amount_total, int) and amount_total != expected_cents:
        logger.error(
            "stripe: checkout session %s totalled %s, expected %s — not activated",
            obj.get("id"),
            amount_total,
            expected_cents,
        )
        return "amount_mismatch"

    # Idempotency by the OWNER id, not by (supplier, placement): a redelivered
    # event resolves to the exact row this subscription already created.
    if (
        db.query(Sponsor.id)
        .filter(Sponsor.stripe_subscription_id == subscription_id)
        .first()
        is not None
    ):
        logger.info("stripe: checkout for subscription %s already recorded", subscription_id)
        return "duplicate_checkout"

    raw_email = _dig(obj, "customer_details", "email")
    email = str(raw_email).strip()[:200] if isinstance(raw_email, str) and raw_email.strip() else None
    website = str(meta.get("website") or "").strip()[:200] or None

    # A self-serve buyer ALWAYS gets a fresh supplier row. Matching the
    # buyer-typed name against the catalog let an anonymous payer publish an
    # existing distributor's identity ("pay $100, become 'Avnet'"). Name is a
    # label here, never an identity; deduping real duplicates is an admin
    # concern, and merging on an unverified string is the vulnerability.
    supplier = Supplier(name=company, email=email, website=website)
    db.add(supplier)
    db.flush()

    sponsor = Sponsor(
        supplier_id=supplier.id,
        category_id=category_key,
        keyword=keyword,
        tier="Silver",
        status="Active",
        amount=Decimal(silver_monthly_usd()),
        sold_by=settings.SELF_SERVE_ONBOARDING_REP,
        stripe_subscription_id=subscription_id,
    )
    db.add(sponsor)
    try:
        db.commit()
    except IntegrityError:
        # The only expected conflict is uq_sponsor_stripe_subscription under a
        # race with a redelivered event — already handled above, so reaching
        # here means an UNEXPECTED integrity failure. Roll back, log the real
        # error, ack 200 (a non-2xx makes Stripe retry-storm) with a DISTINCT
        # outcome so it is visible rather than hidden as "duplicate".
        db.rollback()
        logger.error(
            "stripe: checkout for subscription %s failed to commit — needs a human",
            subscription_id,
            exc_info=True,
        )
        return "checkout_conflict"
    logger.info(
        "stripe: self-serve Silver activated — %s on %s (sub %s, onboarding: %s)",
        company,
        category_id or keyword,
        subscription_id,
        settings.SELF_SERVE_ONBOARDING_REP,
    )
    return "checkout_activated"


def _subscription_id_from_event(event: dict) -> str | None:
    """The subscription id a lifecycle event concerns, wherever Stripe put it.

    ``customer.subscription.*`` → the object IS the subscription (``id``).
    ``invoice.*`` → the invoice's ``subscription`` (legacy) or
    ``parent.subscription_details.subscription`` (2025+ API).
    """
    obj = _dig(event, "data", "object")
    if not isinstance(obj, dict):
        return None
    event_type = event.get("type") or ""
    if event_type.startswith("customer.subscription."):
        sub = obj.get("id")
        return sub if isinstance(sub, str) and sub else None
    for value in (
        obj.get("subscription"),
        _dig(obj, "parent", "subscription_details", "subscription"),
        _dig(obj, "subscription_details", "subscription"),
    ):
        if isinstance(value, str) and value:
            return value
    return None


def _resolve_self_serve_sponsor(db: Session, event: dict) -> Sponsor | None:
    """Find the sponsor a self-serve subscription's LATER events belong to.

    Resolved STRICTLY by the subscription id Stripe controls — never by the
    buyer-typed company name, which is public on the board and forgeable. An
    unknown subscription id simply matches nothing, so a stranger's checkout
    can never address someone else's placement.
    """
    subscription_id = _subscription_id_from_event(event)
    if not subscription_id:
        return None
    return (
        db.query(Sponsor)
        .filter(Sponsor.stripe_subscription_id == subscription_id)
        .first()
    )


def apply_stripe_event(db: Session, event: dict) -> str:
    """Apply one verified event to the sponsors table; returns the outcome."""
    event_type = event.get("type")

    if event_type == "checkout.session.completed":
        return _handle_checkout_completed(db, event)

    if event_type == "invoice.paid":
        new_status = "Active"
    elif event_type == "customer.subscription.deleted":
        new_status = "Expired"
    elif event_type == "invoice.payment_failed":
        # Deliberately no status write — see the module docstring. Loud enough
        # to be found when someone asks why a delinquent sponsor is still up.
        logger.warning(
            "stripe: payment failed for sponsor_id=%s invoice=%s — status left as-is "
            "(grace period undecided)",
            sponsor_id_from_event(event),
            _dig(event, "data", "object", "id"),
        )
        return "logged_payment_failed"
    else:
        return "ignored_event_type"

    raw_id = sponsor_id_from_event(event)
    sponsor: Sponsor | None = None
    if raw_id is None:
        # Self-serve subscriptions exist BEFORE their sponsor row, so they
        # can never carry sponsor_id — but they carry the checkout metadata,
        # which addresses the row the webhook created just as uniquely.
        sponsor = _resolve_self_serve_sponsor(db, event)
        if sponsor is None:
            # A one-off invoice, or a subscription created without the stamp.
            logger.info("stripe: %s carried no sponsor_id — ignored", event_type)
            return "no_sponsor_id"
    else:
        try:
            sponsor_uuid = uuid.UUID(raw_id)
        except ValueError:
            logger.warning("stripe: %s carried malformed sponsor_id %r", event_type, raw_id)
            return "bad_sponsor_id"
        sponsor = db.query(Sponsor).filter(Sponsor.id == sponsor_uuid).first()

    if sponsor is None:
        logger.warning("stripe: %s names unknown sponsor %s", event_type, raw_id)
        return "unknown_sponsor"

    # Ordering gate. Stripe delivery is at-least-once and unordered (retries
    # run for days; the Dashboard has a Resend button), so "the event in hand"
    # and "the current truth" can disagree: a replayed invoice.paid must not
    # resurrect a sponsor someone deliberately Expired after it was minted.
    # The row's last write outranks any event created before it. Costs one
    # edge: an unrelated admin edit while an event is in retry skips that
    # event (visible, fixable in /admin/sponsors) — the alternative was
    # silent resurrection. A processed-event ledger would be the complete
    # fix if this ever needs to be airtight.
    event_created = event.get("created")
    row_written = as_utc(sponsor.updated_at)
    if (
        isinstance(event_created, int)
        and row_written is not None
        and event_created < row_written.timestamp()
    ):
        logger.info(
            "stripe: %s (created %s) predates sponsor %s's last write — skipped",
            event_type,
            event_created,
            raw_id,
        )
        return "stale_event"

    # Paused is an ADMIN state ('Active' | 'Paused' | 'Expired' in the admin
    # form): "hide the board, keep billing". A routine monthly invoice.paid
    # must not undo it — only the human who paused it un-pauses it.
    if new_status == "Active" and (sponsor.status or "").strip().lower() == "paused":
        logger.info(
            "stripe: %s left sponsor %s Paused — un-pausing is admin-only",
            event_type,
            raw_id,
        )
        return "left_paused"

    if (sponsor.status or "") == new_status:
        return "unchanged"

    sponsor.status = new_status
    try:
        db.commit()
    except IntegrityError:
        # Migration 016's partial unique indexes: the slot was re-sold while
        # this subscription lapsed, and reactivating would seat two sponsors.
        # A human must pick the winner — retrying cannot.
        db.rollback()
        logger.error(
            "stripe: %s would reactivate sponsor %s into an occupied %s slot — "
            "left %s; resolve in /admin/sponsors",
            event_type,
            raw_id,
            sponsor.tier,
            sponsor.status,
        )
        return "slot_conflict"
    return f"status_{new_status.lower()}"
