"""Stripe webhook intake — signature verification, the billing mirror and the
sponsors.status writer.

Contract (CLAUDE.md, Stripe): a lifecycle event writes ``sponsors.status``
ONLY. Placement — tier, category_id, keyword — is decided by humans in the
admin or by a paid Checkout, and nothing else that arrives over the wire may
move a company to a different slot. ``checkout.session.completed`` is the one
creator.

Verification is hand-rolled on purpose: the app only ever CONSUMES webhooks,
so fifteen lines of HMAC beat a whole SDK dependency in the container. The
scheme is Stripe's documented one: ``Stripe-Signature: t=<unix>,v1=<hex>[,…]``
where each ``v1`` is HMAC-SHA256 over ``"<t>.<raw body>"`` keyed with the
endpoint's ``whsec_`` secret. Multiple ``v1`` entries are legitimate — Stripe
sends two while an endpoint's secret is being rolled — so ANY match passes.

Event → status map (everything else is acknowledged and ignored; R11: no new
event subscriptions):

    invoice.paid                     → "Active"
    customer.subscription.deleted    → "Expired" (+ its open invoices queued
                                       for voiding: a canceled subscription's
                                       open invoice can still be paid)
    invoice.payment_failed           → no status write; stamps
                                       ``sponsor_billing.failing_since``. The
                                       hourly sweep (services/billing_sweep)
                                       releases the slot 14 days later (D4).

MIRROR BEFORE GATES (spec §8, LU-F4). For every lifecycle event with a
subscription the billing mirror runs FIRST and commits on its own: the
invoice → ``sponsor_payments`` (keyed by invoice id, sponsor resolved
lazily), ``sponsor_billing`` (captured for a rep row the first time one of its
subscriptions speaks), ``failing_since`` set/cleared, ``void_pending``. None
of it writes the sponsor row, so the status gates below keep their meaning and
their early returns cannot lose a payment.

Sponsor resolution (R13): the STORED subscription id first (sponsors or
sponsor_billing — Stripe controls it), then the ``sponsor_id`` a rep stamped
in the subscription's metadata. Once a sponsor has a stored id, an event for a
DIFFERENT subscription naming that sponsor is ``foreign_subscription`` and
touches nothing — an old quote, a reused row's previous owner. (Subscription
metadata also carries ``intent_id`` on Checkout-born subscriptions; activation
stamps the subscription id on the sponsor, so the stored-id step already
covers every event after it, and an earlier invoice simply waits unattached
until activation hands it over.)

Then the status gates. An event ``created`` before the sponsor row's last
write is skipped ("stale_event") — delivery is unordered and at-least-once,
and a replayed invoice.paid must not resurrect a deliberately Expired sponsor.
A Paused sponsor stays Paused ("left_paused") — Paused is an admin lever over
a still-billing subscription. Every successful status write clears the
in-process category cache (R9: the boards otherwise lag up to an hour).

Every recognized-but-unactionable payload returns normally so the route can
200: a non-2xx makes Stripe retry for days and eventually disable the
endpoint. The outcome string is the audit trail — it lands in the response
body (visible in the Dashboard's delivery log) and in ours. Commits catch
``IntegrityError`` AND ``InternalError`` (the tier-matrix trigger raises the
latter) and roll back.

Stripe calls never happen here: the route schedules follow-ups
(``followup_for`` → ``services.billing_followups.run_followup``) as background
tasks, and the hourly sweep retries whatever they leave.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
import uuid
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError, InternalError
from sqlalchemy.orm import Session

from app.models import Sponsor

# The tz-normalizer lives with the calendar model, which faced the identical
# Postgres-aware / SQLite-naive split first; it is THE home, not a borrow.
from app.models.calendar_event import as_utc
from app.models.sales import CheckoutIntent, SalesCode, SponsorBilling
from app.models.sponsor import exclusive_occupant_clause, is_single_slot
from app.services import category_cache
from app.services.billing_mirror import (
    attach_payments,
    audit,
    upsert_billing,
    upsert_payment_from_invoice,
)
from app.services.checkout_intents import COMPLETED, CONFLICT
from app.services.stripe_quotes import QUOTE_LADDER

logger = logging.getLogger(__name__)

WEBHOOK_ACTOR = "system:webhook"

# Commit failures a webhook must survive: unique/FK violations, and the
# tier-matrix trigger's RAISE (Postgres reports it as InternalError).
_COMMIT_ERRORS = (IntegrityError, InternalError)

# Outcomes that leave Stripe-side work for a background task (spec §8.5).
FOLLOWUP_OUTCOMES = frozenset(
    {"checkout_activated", "checkout_conflict_refunding", "status_expired"}
)
# Where apply_stripe_event leaves the follow-up's reference on the event dict
# it was handed — the sponsor id of a self-serve sale is not in the event
# itself (the row postdates the subscription), so it is noted at the write.
_FOLLOWUP_KEY = "_circuits_followup"

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

    expected = (
        hmac.new(
            secret.encode("utf-8"),
            timestamp.encode("ascii") + b"." + payload,
            hashlib.sha256,
        )
        .hexdigest()
        .encode("ascii")
    )
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


def followup_for(event: dict, outcome: str) -> tuple[str, str] | None:
    """The Stripe follow-up an applied event leaves, or None.

    ``("post_activation", sponsor_id)`` after a sale activates (R14 card move,
    stamp the customer, mirror the first invoice); ``("conflict", intent_id)``
    after a paid checkout was refused (cancel + refund); ``("void", sponsor_id)``
    after a subscription was deleted (void its open invoices). Only a
    reference ``apply_stripe_event`` itself recorded counts — a key of that name
    inside a delivered payload parses as a list, never a tuple."""
    if outcome not in FOLLOWUP_OUTCOMES:
        return None
    ref = event.get(_FOLLOWUP_KEY)
    if isinstance(ref, tuple) and len(ref) == 2 and all(isinstance(part, str) for part in ref):
        return ref
    return None


def _note_followup(event: dict, kind: str, ref: object) -> None:
    event[_FOLLOWUP_KEY] = (kind, str(ref))


def _stripe_ref(value: object) -> str | None:
    """An id that may arrive as a string or an expanded ``{id: …}`` object."""
    if isinstance(value, dict):
        value = value.get("id")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _event_time(event: dict) -> datetime:
    created = event.get("created")
    if isinstance(created, int) and not isinstance(created, bool):
        return datetime.fromtimestamp(created, UTC)
    return datetime.now(UTC)


def _safe_commit(db: Session, what: str) -> bool:
    """Commit; on a constraint or trigger failure roll back, log, return False."""
    try:
        db.commit()
    except _COMMIT_ERRORS:
        db.rollback()
        logger.error("stripe: %s failed to commit — rolled back", what, exc_info=True)
        return False
    return True


# ── sponsor resolution + the billing mirror ────────────────────────────────


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
        return _stripe_ref(obj.get("id"))
    for value in (
        obj.get("subscription"),
        _dig(obj, "parent", "subscription_details", "subscription"),
        _dig(obj, "subscription_details", "subscription"),
    ):
        found = _stripe_ref(value)
        if found:
            return found
    return None


def _sponsor_by_subscription(db: Session, subscription_id: str) -> Sponsor | None:
    """The sponsor whose STORED subscription this is — the owner key on the
    sponsor row (self-serve) or the id captured beside it (rep rows)."""
    sponsor = db.query(Sponsor).filter(Sponsor.stripe_subscription_id == subscription_id).first()
    if sponsor is not None:
        return sponsor
    billing = (
        db.query(SponsorBilling.sponsor_id)
        .filter(SponsorBilling.stripe_subscription_id == subscription_id)
        .first()
    )
    if billing is None:
        return None
    return db.get(Sponsor, billing[0])


def _stored_subscription(db: Session, sponsor: Sponsor) -> str | None:
    if sponsor.stripe_subscription_id:
        return sponsor.stripe_subscription_id
    billing = db.get(SponsorBilling, sponsor.id)
    return billing.stripe_subscription_id if billing is not None else None


def _resolve_lifecycle_sponsor(
    db: Session, event: dict, subscription_id: str | None
) -> tuple[Sponsor | None, str | None, str | None]:
    """``(sponsor, refusal, raw_sponsor_id)``: exactly one of sponsor/refusal is
    set. Refusals are the existing outcome strings plus R13's
    ``foreign_subscription``."""
    if subscription_id:
        owned = _sponsor_by_subscription(db, subscription_id)
        if owned is not None:
            return owned, None, str(owned.id)

    raw_id = sponsor_id_from_event(event)
    if raw_id is None:
        # A one-off invoice, a subscription created without the stamp, or a
        # Checkout subscription whose sale has not activated yet.
        return None, "no_sponsor_id", None
    try:
        sponsor_uuid = uuid.UUID(raw_id)
    except ValueError:
        return None, "bad_sponsor_id", raw_id
    sponsor = db.get(Sponsor, sponsor_uuid)
    if sponsor is None:
        return None, "unknown_sponsor", raw_id
    stored = _stored_subscription(db, sponsor)
    if stored and subscription_id and stored != subscription_id:
        return None, "foreign_subscription", raw_id
    return sponsor, None, raw_id


def _list_price(tier: str | None) -> int | None:
    ladder = QUOTE_LADDER.get((tier or "").strip().lower())
    return ladder[0] if ladder else None


def _whole_dollars(amount: object) -> int | None:
    try:
        value = Decimal(str(amount))
    except (InvalidOperation, ValueError):
        return None
    return int(value) if value > 0 else None


def _capture_billing(
    db: Session, sponsor: Sponsor, subscription_id: str, obj: dict
) -> SponsorBilling:
    """The sponsor's billing row, created (or its subscription id captured) the
    first time one of its subscriptions speaks (F4/F9: rep rows had none, so
    dunning could never see them). A row that already names a subscription is
    left pointing at it — resolution above already refused any other."""
    billing = db.get(SponsorBilling, sponsor.id)
    customer = _stripe_ref(obj.get("customer"))
    if billing is None:
        list_usd = _list_price(sponsor.tier)
        price = _whole_dollars(sponsor.amount) or list_usd or 0
        collection = obj.get("collection_method")
        return upsert_billing(
            db,
            sponsor.id,
            stripe_subscription_id=subscription_id,
            stripe_customer_id=customer,
            collection_method=(
                collection
                if collection in ("charge_automatically", "send_invoice")
                else "charge_automatically"
            ),
            channel="self_serve" if sponsor.stripe_subscription_id else "quote",
            list_usd=list_usd or price,
            price_usd=price,
        )
    if not billing.stripe_subscription_id:
        billing.stripe_subscription_id = subscription_id
    if customer and not billing.stripe_customer_id:
        billing.stripe_customer_id = customer
    return billing


def _mirror(
    db: Session,
    event: dict,
    subscription_id: str | None,
    sponsor: Sponsor | None,
) -> None:
    """Spec §8 mirror-before-gates. Commits on its own (or rolls back); never
    writes the sponsor row and never raises past a commit failure."""
    event_type = event.get("type")
    obj = _dig(event, "data", "object")
    if not isinstance(obj, dict) or not subscription_id:
        return

    payment = None
    if event_type in ("invoice.paid", "invoice.payment_failed"):
        payment = upsert_payment_from_invoice(db, obj)

    if sponsor is not None:
        billing = _capture_billing(db, sponsor, subscription_id, obj)
        if payment is not None and payment.sponsor_id is None:
            payment.sponsor_id = sponsor.id
        if event_type == "invoice.paid":
            billing.failing_since = None
        elif event_type == "invoice.payment_failed" and billing.failing_since is None:
            billing.failing_since = _event_time(event)
        elif event_type == "customer.subscription.deleted":
            billing.void_pending = True

    _safe_commit(db, f"billing mirror for {event_type} on {subscription_id}")


# ── checkout.session.completed ─────────────────────────────────────────────


def _handle_checkout_completed(db: Session, event: dict) -> str:
    obj = _dig(event, "data", "object")
    if not isinstance(obj, dict):
        return "bad_checkout_metadata"
    meta = obj.get("metadata")
    if not isinstance(meta, dict):
        meta = {}
    if meta.get("managed_by") != "circuits-com":
        return "ignored_checkout"
    if meta.get("intent_id"):
        return _handle_intent_checkout(db, event, obj, str(meta["intent_id"]))
    if meta.get("self_serve") == "silver":
        return _handle_legacy_silver(db, event, obj, meta)
    return "ignored_checkout"


def _paid(obj: dict) -> bool:
    """checkout.session.completed fires for subscription sessions even when
    the first payment is still 'unpaid' (an incomplete subscription).
    Activating on that would put a never-paid company on the board."""
    return obj.get("payment_status") in ("paid", "no_payment_required")


def _handle_legacy_silver(db: Session, event: dict, obj: dict, meta: dict) -> str:
    """A Silver session minted BEFORE checkout intents existed (metadata
    ``self_serve=silver``, no ``intent_id``) — they keep completing after the
    deploy. Unchanged except that a MISSING total now fails the amount gate,
    and the gate is pinned to the Silver LIST price those sessions charged.

    Four gates, all acking 200: payment cleared; the subscription id exists to
    OWN the row; the total is the sticker; this subscription is not already
    recorded. A self-serve buyer ALWAYS gets a fresh supplier row — the
    buyer-typed name is a label, never an identity to match against the
    catalog ("pay, become 'Avnet'"). ``sold_by`` credits the onboarding rep.
    """
    from app.config import settings
    from app.models import Supplier

    if not _paid(obj):
        logger.info(
            "stripe: checkout session %s completed unpaid (%s) — not activated",
            obj.get("id"),
            obj.get("payment_status"),
        )
        return "checkout_unpaid"

    subscription_id = _stripe_ref(obj.get("subscription"))
    if not subscription_id:
        logger.warning("stripe: checkout session %s carried no subscription id", obj.get("id"))
        return "bad_checkout_metadata"

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

    # The sticker is the price — and a MISSING total is not a pass (R9).
    list_usd = QUOTE_LADDER["silver"][0]
    amount_total = obj.get("amount_total")
    if not isinstance(amount_total, int) or amount_total != list_usd * 100:
        logger.error(
            "stripe: checkout session %s totalled %s, expected %s — not activated",
            obj.get("id"),
            amount_total,
            list_usd * 100,
        )
        return "amount_mismatch"

    if _sponsor_by_subscription(db, subscription_id) is not None:
        logger.info("stripe: checkout for subscription %s already recorded", subscription_id)
        return "duplicate_checkout"

    raw_email = _dig(obj, "customer_details", "email")
    email = (
        str(raw_email).strip()[:200] if isinstance(raw_email, str) and raw_email.strip() else None
    )
    website = str(meta.get("website") or "").strip()[:200] or None

    supplier = Supplier(name=company, email=email, website=website)
    db.add(supplier)
    db.flush()

    sponsor = Sponsor(
        supplier_id=supplier.id,
        category_id=category_key,
        keyword=keyword,
        tier="Silver",
        status="Active",
        amount=Decimal(list_usd),
        sold_by=settings.SELF_SERVE_ONBOARDING_REP,
        stripe_subscription_id=subscription_id,
    )
    db.add(sponsor)
    db.flush()
    upsert_billing(
        db,
        sponsor.id,
        stripe_subscription_id=subscription_id,
        stripe_customer_id=_stripe_ref(obj.get("customer")),
        collection_method="charge_automatically",
        channel="self_serve",
        list_usd=list_usd,
        founder_usd=None,
        price_usd=list_usd,
    )
    attach_payments(db, subscription_id, sponsor.id)
    audit(
        db,
        WEBHOOK_ACTOR,
        "sale_activated",
        sponsor_id=sponsor.id,
        amount_cents=amount_total,
        detail=f"legacy Silver checkout {obj.get('id')}; subscription {subscription_id}",
    )
    if not _safe_commit(db, f"legacy Silver checkout for subscription {subscription_id}"):
        # Reaching here past the idempotency probe means an UNEXPECTED
        # integrity failure — a DISTINCT outcome so it is visible.
        return "checkout_conflict"
    category_cache.clear()
    _note_followup(event, "post_activation", sponsor.id)
    logger.info(
        "stripe: self-serve Silver activated — %s on %s (sub %s, onboarding: %s)",
        company,
        category_id or keyword,
        subscription_id,
        settings.SELF_SERVE_ONBOARDING_REP,
    )
    return "checkout_activated"


def _queue_conflict(
    db: Session, event: dict, intent: CheckoutIntent, reason: str, obj: dict
) -> str:
    """A PAID checkout the sale cannot honour (spec §8.3): the intent becomes a
    ``conflict`` the follow-up (and the hourly sweep) cancels and refunds, and
    it shows in Needs attention until that has happened."""
    subscription_id = _stripe_ref(obj.get("subscription"))
    amount_total = obj.get("amount_total")
    intent.status = CONFLICT
    intent.conflict_reason = reason
    intent.resolved_at = None
    audit(
        db,
        WEBHOOK_ACTOR,
        "sale_conflict",
        intent_id=intent.id,
        sales_code_id=intent.sales_code_id,
        amount_cents=amount_total if isinstance(amount_total, int) else None,
        detail=f"{reason}; session {obj.get('id')}; subscription {subscription_id or '-'}",
    )
    _safe_commit(db, f"conflict {reason} for intent {intent.id}")
    _note_followup(event, "conflict", intent.id)
    logger.error(
        "stripe: paid checkout %s for intent %s refused (%s) — queued for refund",
        obj.get("id"),
        intent.id,
        reason,
    )
    return "checkout_conflict_refunding"


def _placement_refusal(db: Session, intent: CheckoutIntent) -> str | None:
    """Gates 4-5 of §8.2 (category exists, matrix allows it, slot free by R16),
    pre-checked so the tier-matrix trigger never has to fire."""
    from app.models import Category

    tier = (intent.tier or "").strip().lower()
    if intent.category_id is not None:
        if intent.keyword:
            return "bad_metadata"
        category = db.get(Category, intent.category_id)
        if category is None:
            return "category_missing"
        is_top = category.parent_id is None
        if tier in ("gold", "platinum"):
            if not is_single_slot(tier, is_top):
                return "matrix"
            taken = (
                db.query(Sponsor.id)
                .filter(
                    Sponsor.category_id == intent.category_id,
                    func.lower(Sponsor.tier) == tier,
                    exclusive_occupant_clause(),
                )
                .first()
            )
            if taken is not None:
                return "slot_taken"
        elif tier == "silver":
            if is_top:
                return "matrix"
        else:
            return "bad_metadata"
        return None
    if intent.keyword:
        # Gold keyword placements are out of scope for self-serve (§15).
        return None if tier == "silver" else "matrix"
    return "bad_metadata"


def _handle_intent_checkout(db: Session, event: dict, obj: dict, raw_intent: str) -> str:
    """A session minted by the intent-backed checkout (all tiers; spec §8)."""
    from app.config import settings
    from app.models import Supplier

    try:
        intent_key = uuid.UUID(raw_intent)
    except ValueError:
        logger.warning("stripe: checkout session %s carried a bad intent id", obj.get("id"))
        return "bad_checkout_metadata"
    intent = db.get(CheckoutIntent, intent_key)
    if intent is None:
        logger.error(
            "stripe: checkout session %s names unknown intent %s", obj.get("id"), raw_intent
        )
        return "unknown_intent"

    session_id = _stripe_ref(obj.get("id"))
    if intent.stripe_session_id and session_id and intent.stripe_session_id != session_id:
        logger.error(
            "stripe: session %s claims intent %s, which belongs to %s — ignored",
            session_id,
            intent.id,
            intent.stripe_session_id,
        )
        return "intent_session_mismatch"
    if intent.status == COMPLETED:
        return "duplicate_checkout"
    if intent.status == CONFLICT:
        return "conflict_already_queued"
    if not intent.stripe_session_id and session_id:
        intent.stripe_session_id = session_id

    if not _paid(obj):
        _safe_commit(db, f"session id for intent {intent.id}")
        return "checkout_unpaid"

    # Every refusal from here on is AFTER payment → a conflict to refund.
    subscription_id = _stripe_ref(obj.get("subscription"))
    if not subscription_id:
        return _queue_conflict(db, event, intent, "bad_metadata", obj)
    if _sponsor_by_subscription(db, subscription_id) is not None:
        return "duplicate_checkout"

    amount_total = obj.get("amount_total")
    if (
        not isinstance(amount_total, int)
        or isinstance(amount_total, bool)
        or amount_total != intent.price_usd * 100
    ):
        return _queue_conflict(db, event, intent, "amount_mismatch", obj)

    refusal = _placement_refusal(db, intent)
    if refusal:
        return _queue_conflict(db, event, intent, refusal, obj)

    # R7: a code bound to an existing company. Never a second row beside a
    # live one; an Expired row is reused (its stored subscription is replaced,
    # so the old subscription can no longer act on it — R13).
    reuse: Sponsor | None = None
    supplier_id: uuid.UUID | None = None
    if intent.supplier_id is not None:
        bound = db.get(Supplier, intent.supplier_id)
        if bound is None:
            return _queue_conflict(db, event, intent, "bad_metadata", obj)
        placement = (
            Sponsor.category_id == intent.category_id
            if intent.category_id is not None
            else Sponsor.keyword == intent.keyword
        )
        rows = db.query(Sponsor).filter(Sponsor.supplier_id == bound.id, placement).all()
        if any(row.status != "Expired" for row in rows):
            return _queue_conflict(db, event, intent, "already_sponsor", obj)
        reuse = rows[0] if rows else None
        supplier_id = bound.id

    code = db.get(SalesCode, intent.sales_code_id) if intent.sales_code_id else None
    sold_by = intent.sold_by or (code.rep if code else None) or settings.SELF_SERVE_ONBOARDING_REP
    tier = (intent.tier or "").strip().lower()

    if supplier_id is None:
        # Fresh supplier, always: the buyer-typed name is a label, never an
        # identity to match against the catalog.
        supplier = Supplier(
            name=(intent.company_name or "").strip()[:200],
            email=(intent.email or "").strip()[:200] or None,
            website=(intent.website or "").strip()[:200] or None,
        )
        db.add(supplier)
        db.flush()
        supplier_id = supplier.id

    sponsor = reuse or Sponsor(
        supplier_id=supplier_id, category_id=intent.category_id, keyword=intent.keyword
    )
    sponsor.tier = tier.title()
    sponsor.status = "Active"
    sponsor.amount = Decimal(intent.price_usd)
    sponsor.sold_by = sold_by
    sponsor.stripe_subscription_id = subscription_id
    if reuse is None:
        db.add(sponsor)
    db.flush()

    upsert_billing(
        db,
        sponsor.id,
        stripe_subscription_id=subscription_id,
        stripe_customer_id=_stripe_ref(obj.get("customer")),
        collection_method="charge_automatically",
        channel=intent.channel,
        list_usd=intent.list_usd,
        founder_usd=intent.founder_usd,
        price_usd=intent.price_usd,
        sales_code_id=intent.sales_code_id,
        failing_since=None,
        post_activation_done_at=None,
        # A reused row's queued void belonged to its OLD subscription; left
        # set, the sweep would void the new one's open invoices.
        void_pending=False,
    )
    attach_payments(db, subscription_id, sponsor.id)
    if code is not None:
        code.uses = (code.uses or 0) + 1
    intent.status = COMPLETED
    audit(
        db,
        WEBHOOK_ACTOR,
        "sale_activated",
        sponsor_id=sponsor.id,
        intent_id=intent.id,
        sales_code_id=intent.sales_code_id,
        amount_cents=amount_total,
        detail=(
            f"{tier} via {intent.channel}; session {session_id}; "
            f"subscription {subscription_id}; sold_by {sold_by}"
        )[:500],
    )

    try:
        db.commit()
    except _COMMIT_ERRORS as exc:
        db.rollback()
        logger.error("stripe: activating intent %s failed to commit", intent.id, exc_info=True)
        if _sponsor_by_subscription(db, subscription_id) is not None:
            return "duplicate_checkout"  # a concurrent redelivery won the race
        intent = db.get(CheckoutIntent, intent_key)
        if intent is None or intent.status in (COMPLETED, CONFLICT):
            return "duplicate_checkout" if intent is not None else "unknown_intent"
        if not intent.stripe_session_id and session_id:
            intent.stripe_session_id = session_id
        # The trigger (tier matrix) raises InternalError; a unique violation
        # is the 016 slot index or uq_sponsor_supplier_category losing a race.
        reason = "matrix" if isinstance(exc, InternalError) else "slot_taken"
        return _queue_conflict(db, event, intent, reason, obj)

    category_cache.clear()
    _note_followup(event, "post_activation", sponsor.id)
    logger.info(
        "stripe: %s sale activated — sponsor %s (sub %s, intent %s, sold by %s)",
        tier,
        sponsor.id,
        subscription_id,
        intent.id,
        sold_by,
    )
    return "checkout_activated"


# ── the lifecycle writer ───────────────────────────────────────────────────


def apply_stripe_event(db: Session, event: dict) -> str:
    """Apply one verified event; returns the outcome."""
    event_type = event.get("type")

    if event_type == "checkout.session.completed":
        return _handle_checkout_completed(db, event)

    if event_type == "invoice.paid":
        new_status: str | None = "Active"
    elif event_type == "customer.subscription.deleted":
        new_status = "Expired"
    elif event_type == "invoice.payment_failed":
        new_status = None
    else:
        return "ignored_event_type"

    subscription_id = _subscription_id_from_event(event)
    sponsor, refusal, raw_id = _resolve_lifecycle_sponsor(db, event, subscription_id)
    _mirror(db, event, subscription_id, sponsor)

    if new_status is None:
        if refusal == "foreign_subscription":
            return refusal
        # No status write: the 14-day sweep decides (D4). Loud enough to be
        # found when someone asks why a delinquent sponsor is still up.
        logger.warning(
            "stripe: payment failed for sponsor_id=%s invoice=%s — failing_since stamped",
            raw_id,
            _dig(event, "data", "object", "id"),
        )
        return "logged_payment_failed"

    if refusal is not None:
        log = logger.warning if refusal != "no_sponsor_id" else logger.info
        log("stripe: %s for %s/%s — %s", event_type, subscription_id, raw_id, refusal)
        return refusal
    assert sponsor is not None

    # Ordering gate. Stripe delivery is at-least-once and unordered (retries
    # run for days; the Dashboard has a Resend button), so "the event in hand"
    # and "the current truth" can disagree: a replayed invoice.paid must not
    # resurrect a sponsor someone deliberately Expired after it was minted.
    # The row's last write outranks any event created before it. The mirror
    # above never writes the sponsor row, so it cannot trip this gate.
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
            sponsor.id,
        )
        return "stale_event"

    # Paused is an ADMIN state: "hide the board, keep billing". A routine
    # monthly invoice.paid must not undo it — only the human who paused it.
    if new_status == "Active" and (sponsor.status or "").strip().lower() == "paused":
        logger.info(
            "stripe: %s left sponsor %s Paused — un-pausing is admin-only", event_type, sponsor.id
        )
        return "left_paused"

    if (sponsor.status or "") == new_status:
        return "unchanged"

    sponsor_id, tier = sponsor.id, sponsor.tier
    sponsor.status = new_status
    try:
        db.commit()
    except _COMMIT_ERRORS:
        # Migration 016's partial unique indexes: the slot was re-sold while
        # this subscription lapsed, and reactivating would seat two sponsors.
        # A human must pick the winner — retrying cannot.
        db.rollback()
        logger.error(
            "stripe: %s would reactivate sponsor %s into an occupied %s slot — "
            "left as it was; resolve in /admin/sponsors",
            event_type,
            sponsor_id,
            tier,
        )
        return "slot_conflict"
    category_cache.clear()
    if new_status == "Expired":
        _note_followup(event, "void", sponsor_id)
    return f"status_{new_status.lower()}"
