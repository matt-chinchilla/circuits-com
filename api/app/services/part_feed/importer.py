"""Turns FeedParts into catalog rows: Part + PartListing + PriceBreaks.

Idempotent by construction: parts keyed by MPN, listings keyed by
(part, supplier), price breaks reconciled rung-by-rung per sync. Never overwrites
a value a human/API already set with something emptier — image/datasheet fill
only when missing, stock/lead/prices refresh on every run.

The bottom of the file owns the RUN REGISTRY — the small piece of machinery
that makes a run outlive the socket that asked for it. It lives here rather
than in the route because the generators above are the work: the route only
decides whether a run may start and who gets to watch.
"""

import logging
import queue
import re
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session, noload

from app.db.session import SessionLocal
from app.models import (
    Category,
    Manufacturer,
    ManufacturerAlias,
    Part,
    PartListing,
    PriceBreak,
    Supplier,
    SupplierFeed,
)
from app.services.activity import IMPORT_EVENT_KINDS, record_stream_event
from app.services.feed_lock import supplier_feed_lock
from app.services.manufacturer_canon import canon
from app.services.part_feed.base import FeedPart, PartFeedProvider
from app.services.part_feed.mouser import FeedFatalError
from app.services.part_feed.specmap import map_lifecycle, normalize_mount
from app.services.part_identity import find_part, get_or_create_part
from app.services.part_pricing import refresh_best_prices
from app.services.part_pricing import storable_price as _storable_price
from app.services.search_service import invalidate_catalog_caches
from app.utils.image_url import validate_optional_image_url

logger = logging.getLogger(__name__)


# ── scoping a provider query ────────────────────────────────────────────────


class FeedScopeUnsupported(RuntimeError):
    """This provider cannot honour the narrowing this scope asks for.

    Raised, never swallowed, and that is the entire point. The alternative —
    dropping a filter the provider does not understand and issuing the bare
    keyword search — is the worst failure available here: it spends a
    rate-limited call, comes back with plausible-looking parts, and lands
    prices belonging to manufacturers nobody asked about, with nothing
    anywhere saying a filter went missing. A loud stop is recoverable; a quiet
    wrong price on a comparison page is not.
    """


@dataclass(frozen=True)
class FeedScope:
    """ONE question to put to a distributor: a keyword, optionally narrowed.

    `keyword` is never empty. Measured against the live DigiKey API: an empty
    `Keywords` value is a 400 that STILL decrements `x-ratelimit-remaining`, so
    an empty scope is a call thrown away, and at 1,000 a day shared between the
    nightly sweep and the operator's clicks that is worth refusing at
    construction rather than discovering per unit.

    `manufacturer_id` is a PROVIDER-OPAQUE token. The importer only ever asks
    whether one is present (to decide whether a provider can honour the scope);
    it never parses it. DigiKey's token happens to be a comma-separated list of
    its own manufacturer ids, because `ManufacturerFilter` takes an array and 16
    of the 454 mapped makers have more than one. Keeping it opaque is what stops
    the sweep from learning a second distributor's id grammar.

    `label` is what the operator reads in the console — a category name for the
    category sweep, "maker · prefix" for the family sweep.

    NOTE ON ITS HOME: this belongs in `base.py` alongside `FeedPart`, as part of
    the provider protocol. It lives here because `base.py` was outside the remit
    of the change that introduced it; the move is a one-line import edit.
    """

    keyword: str
    manufacturer_id: str | None = None
    label: str | None = None

    def __post_init__(self):
        if not (self.keyword or "").strip():
            raise ValueError("FeedScope needs a non-empty keyword — an empty one is a paid 400")


def search_scoped(
    provider: PartFeedProvider, scope: FeedScope, limit: int = 50, start_at: int = 0
) -> list[FeedPart]:
    """Run `scope` against `provider`, or refuse.

    Three cases, and the third is the one that matters:

    * the provider implements `search_scoped` — hand it the whole scope and let
      it decide how to express the narrowing;
    * it does not, and the scope asks for nothing but a keyword — this is
      Mouser, whose search takes a keyword and nothing else, so a plain
      `search()` IS the scope, faithfully honoured;
    * it does not, and the scope DOES narrow — raise. See
      :class:`FeedScopeUnsupported`.
    """
    scoped = getattr(provider, "search_scoped", None)
    if callable(scoped):
        return scoped(scope, limit, start_at)
    if scope.manufacturer_id is None:
        return provider.search(scope.keyword, limit, start_at)
    raise FeedScopeUnsupported(
        f"{type(provider).__name__} has no scoped search, so it cannot narrow "
        f"{scope.keyword!r} to a manufacturer — refusing to issue the query unscoped"
    )


def _slugify_sku(sku: str) -> str:
    # Same derivation as routes/parts.slugify_sku — duplicated (4 lines)
    # rather than importing a route module from a service.
    slug = re.sub(r"[^a-z0-9]+", "-", sku.lower())
    return re.sub(r"-+", "-", slug).strip("-")


def _search_keyword(cat: Category) -> str:
    """The query a category is filled with — its display name.

    One home so the import sweep and `fill_category` can never drift into
    asking the distributor two different questions about the same shelf."""
    return cat.name


def _new_part(
    fp: FeedPart,
    category_id: uuid.UUID | None,
    sub_slug: str | None,
    *,
    manufacturer_id: uuid.UUID,
) -> Part:
    """The Part row a new feed hit becomes — constructed, NOT added: the
    caller owns the transaction.

    Single home for `fill_category` and `grow_catalog`: the same MPN must land
    identically whichever entry point found it first (slug derivation and
    `sub_slug` especially — the category page filters on `sub_slug`).

    Takes the category's two SCALARS rather than the Category row: the import
    sweep commits per part, which EXPIRES that row, and an ORM attribute read
    in here would re-SELECT the category once per created part."""
    return Part(
        id=uuid.uuid4(),
        sku=fp.mpn,
        slug=_slugify_sku(fp.mpn),
        manufacturer_name=fp.manufacturer,
        # Half of the identity key, resolved through canon by the caller. It
        # used to be left NULL here and backfilled by the seed at the NEXT
        # container start, which meant every feed-created part was unkeyable
        # until a deploy happened to run — 3,229 of them on production.
        manufacturer_id=manufacturer_id,
        description=fp.description,
        category_id=category_id,
        sub_slug=sub_slug,
    )


def _safe_image(url: str | None) -> str | None:
    # parts.image_url is String(500) — the validator allows longer values
    # (data URLs) that this column cannot hold, so bound it here too.
    if not url or len(url) > 500:
        return None
    try:
        return validate_optional_image_url(url)
    except ValueError:
        return None


def _fill_part_media(part: Part, fp: FeedPart) -> bool:
    """Fill image/datasheet ONLY where the part has none. Returns True if it
    wrote anything.

    Never overwrites a value a human or an earlier feed already set, and both
    URLs are bounded by their String(500) columns (image via `_safe_image`,
    which also rejects hostile schemes)."""
    changed = False
    if not part.image_url:
        image = _safe_image(fp.image_url)
        if image:
            part.image_url = image
            changed = True
    # datasheet fills on its own merits — an imageless part with a real
    # datasheet must not be refetched forever.
    if not part.datasheet_url and fp.datasheet_url and len(fp.datasheet_url) <= 500:
        part.datasheet_url = fp.datasheet_url
        changed = True
    return changed


def _stamp_feed_facts(part: Part, fp: FeedPart) -> bool:
    """Copy feed-confirmed facts onto the row. lifecycle_verified_at is stamped
    ONLY when the feed actually said something we could map (spec D6)."""
    changed = False
    if fp.package:
        token = fp.package.strip()[:60]
        if token and part.package != token:
            part.package = token
            changed = True
    mapped = map_lifecycle(fp.lifecycle)
    if mapped is not None:
        # Inside the guard, like every other field here. Stamping the timestamp
        # on every pass made a re-sync rewrite each row it touched even when the
        # feed confirmed exactly what we already stored: 139,056 UPDATEs per
        # Mouser import, 2.8% of them HOT, so ~97% also rewrote all eight of the
        # table's indexes (~3 GB of WAL for a no-op pass). Safe because nothing
        # reads the timestamp's VALUE — every consumer asks only whether it is
        # NULL — so the column now means "when a feed established the lifecycle
        # this row currently claims" rather than "when we last looked". If you
        # ever want a real freshness signal, it belongs on the run
        # (`supplier_feeds.last_synced_at`), not here.
        if part.lifecycle_status != mapped or part.lifecycle_verified_at is None:
            part.lifecycle_status = mapped
            part.lifecycle_verified_at = datetime.now(UTC)
            changed = True
    # Spec fields (migration 039) — `is not None`, NEVER truthiness: rohs=False
    # is a value and must be stored; feed absence (None) leaves values alone.
    # normalize_mount, not fp.mount raw: `FeedPart.mount` is a bare str, so
    # the clamp belongs at the WRITE boundary as well as at map_mount's exit —
    # a provider that fills the field itself must not reach a String(8) column
    # with "Surface Mount". Unrecognized clamps to None = "the feed said
    # nothing", which leaves the stored value alone.
    mount = normalize_mount(fp.mount)
    if mount is not None and part.mount != mount:
        part.mount = mount
        changed = True
    if fp.rohs is not None and part.rohs != fp.rohs:
        part.rohs = fp.rohs
        changed = True
    if fp.lead_time_days is not None and part.lead_time_days != fp.lead_time_days:
        part.lead_time_days = fp.lead_time_days
        changed = True
    return changed


def _existing_manufacturer_id(db: Session, name: str | None) -> uuid.UUID | None:
    """The manufacturer this raw feed name already names, or None. NEVER creates.

    `resolve_manufacturer_id` is the sibling of this and mints a PROVISIONAL
    row on a miss, which is right where it is used — the category import is
    creating a part, `parts.manufacturer_id` is half of the identity key and
    cannot be NULL, so an unknown maker has to become a real row rather than a
    hole. It is wrong for the overlap sweep, which creates no parts at all: an
    unattended nightly pass that can invent manufacturers would fill the
    review queue with one distributor's spelling variants, each attached to
    nothing.

    Making that structurally impossible beats forbidding it by policy, which is
    why this is a separate function and not a keyword argument threaded through
    the shared one — a caller cannot forget to pass what does not exist.

    Resolution order mirrors `resolve_manufacturer_id` exactly (alias table
    first, then the canonical key) and truncates the key the same way, so the
    two agree about which row a name means. They must: this decides whether a
    feed row is off-scope, and that one disagrees would silently drop every
    part a maker sells.
    """
    key = canon(name or "")[:220]
    if not key:
        return None
    alias = (
        db.query(ManufacturerAlias.manufacturer_id)
        .filter(ManufacturerAlias.alias_canon == key)
        .first()
    )
    if alias is not None:
        return alias[0]
    row = db.query(Manufacturer.id).filter(Manufacturer.canonical_key == key).first()
    return row[0] if row is not None else None


def _get_or_create_supplier(db: Session, provider: PartFeedProvider) -> Supplier:
    supplier = db.query(Supplier).filter(Supplier.name == provider.supplier_name).first()
    if supplier is None:
        supplier = Supplier(
            id=uuid.uuid4(),
            name=provider.supplier_name,
            website=provider.supplier_website,
        )
        db.add(supplier)
        db.flush()
    return supplier


def _supplier_already_lists(db: Session, part_id: uuid.UUID, supplier_id: uuid.UUID) -> bool:
    """Does this supplier already carry an offer for this part?

    The one question that separates Import from Sync — see `grow_catalog`.
    Scalar existence only: never load the PartListing, whose `price_breaks` is
    `lazy="selectin"` and would fire a second SELECT for rows this is about to
    decline to touch.
    """
    return (
        db.query(PartListing.id)
        .filter(PartListing.part_id == part_id, PartListing.supplier_id == supplier_id)
        .first()
        is not None
    )


# `_storable_price` — a feed can quote finer than the column can hold: the
# captured DigiKey payload prices a reel at 0.03909 against a Numeric(10, 4)
# column, which stores 0.0391. The incoming value is rounded to the column's
# OWN scale before anything compares it, or a confirming pass differs every
# time and rewrites the row forever.
#
# It is IMPORTED from `services/part_pricing` rather than defined here, and the
# direction is deliberate. The denormalized `parts.best_price*` columns are the
# same Numeric(10, 4) and have to compare through the identical rounding; two
# copies of "what the database will actually hold" is how the phantom diff
# comes back on one path only, with the other path's tests still green.
# `part_pricing` is the lower-level module (models and nothing else), so it
# owns the constant and this one consumes it.


def _sync_price_breaks(db: Session, listing_id: uuid.UUID, feed_breaks) -> bool:
    """Reconcile one listing's price ladder against the feed, writing only the
    rungs that actually differ. Returns whether any rung actually moved.

    That return value is what lets the denormalized `parts.best_price*` columns
    stay true without a second scan: the reconciler is the only code that knows
    whether this pass changed a price, and asking the database again afterwards
    would put a read on the confirming path — the one path this whole design
    exists to make free.

    This used to be `DELETE WHERE listing_id = ?` plus an INSERT per rung, on
    every pass, whether or not a price had moved. `pg_stat_user_tables` showed
    what that cost: 846,167 live rows carrying 2,760,938 inserts and 2,080,759
    deletes, with `n_tup_upd = 0` — no row had ever been updated, because
    nothing ever tried.

    The natural key inside a listing is `min_quantity`, so the diff keys on it.
    Repricing in place is worth more than the saved row count suggests:
    `unit_price` is the table's only unindexed column, so an UPDATE touching
    just that one can be HOT and skip all three indexes, where the old
    delete-and-reinsert wrote every one of them twice.
    """
    wanted = {pb.min_quantity: _storable_price(pb.unit_price) for pb in feed_breaks}
    # Sessions run autoflush=False, so breaks a previous pass over this same
    # listing merely staged would be invisible to the SELECT below and the
    # whole ladder would be inserted a second time. No caller does that today
    # (grow_catalog dedupes per page, the others commit per part) and the
    # wholesale-delete code this replaced duplicated identically — but a
    # function that documents itself as reconciling duplicate quantities should
    # not depend on its callers to avoid creating them.
    db.flush()
    stored = db.execute(
        select(PriceBreak.id, PriceBreak.min_quantity, PriceBreak.unit_price).where(
            PriceBreak.listing_id == listing_id
        )
    ).all()

    seen: set[int] = set()
    stale: list[uuid.UUID] = []
    # Collected rather than executed in the loop: a supplier-wide reprice moves
    # every rung, and a real Mouser listing carries up to ten of them, so
    # per-rung statements would trade the old single DELETE for ten round trips
    # on exactly the path this is supposed to make cheaper.
    repriced: list[dict] = []
    for pk, qty, price in stored:
        # `qty in seen` is the duplicate case. Nothing in the schema forbids two
        # rows at one quantity — only separate indexes on the two columns — so a
        # diff that updated one copy would strand the other, leaving the listing
        # quoting two prices for the same break permanently.
        if qty not in wanted or qty in seen:
            stale.append(pk)
            continue
        seen.add(qty)
        if price != wanted[qty]:
            repriced.append({"id": pk, "unit_price": wanted[qty]})
    if repriced:
        # ORM bulk UPDATE by primary key: no explicit WHERE, so SQLAlchemy
        # derives the criteria from `id` and still synchronizes the session.
        # Spelling it as `update(...).where(id == bindparam(...))` instead
        # raises InvalidRequestError on the executemany path.
        db.execute(update(PriceBreak), repriced)
    if stale:
        db.execute(delete(PriceBreak).where(PriceBreak.id.in_(stale)))
    arrived = wanted.keys() - seen
    for qty in arrived:
        db.add(
            PriceBreak(
                id=uuid.uuid4(),
                listing_id=listing_id,
                min_quantity=qty,
                unit_price=wanted[qty],
            )
        )
    return bool(repriced or stale or arrived)


def _upsert_listing(db: Session, part: Part, supplier: Supplier, fp: FeedPart) -> bool:
    """Create/refresh this supplier's listing for `part`.

    Returns whether the feed row was USABLE — True means it carried a price and
    this listing now reflects it; False means it did not, so there was nothing
    worth storing and callers report that honestly instead of claiming an
    update. It deliberately does NOT mean "rows were written": since the ladder
    became a reconciliation, a pass that confirms an unchanged listing writes
    nothing and still returns True. Narrowing it to "changed" would silently
    reshape the operator-facing `synced`/`updated` counters and the
    activity_events they persist, which is a product decision rather than a
    consequence of how the writes are batched.
    """
    if not fp.price_breaks:
        return False  # a listing without a price is not a comparison row
    lowest_qty_break = min(fp.price_breaks, key=lambda b: b.min_quantity)
    listing = (
        db.query(PartListing)
        # PartListing.price_breaks is lazy="selectin", so loading the listing
        # would fire a second SELECT and hydrate full ORM objects for every
        # break on it. _sync_price_breaks reads the ladder itself, as three
        # columns for this ONE listing; without noload that targeted read is
        # additive to a fan-out this function never uses. noload, not
        # raiseload: the collection is genuinely unused here, and a hard error
        # would only move the cost to whoever next touches the attribute.
        .options(noload(PartListing.price_breaks))
        .filter(PartListing.part_id == part.id, PartListing.supplier_id == supplier.id)
        .first()
    )
    # Rounded to the column's scale for the same reason the price breaks are:
    # assigning raw feed precision to a Numeric(10, 4) makes every confirming
    # pass look like a change and rewrite the row — four indexes here, plus an
    # `updated_at` bump. (Nothing reads `part_listings.updated_at`; the column
    # the BOM tool's price provenance reads is `last_updated`, which has no
    # onupdate and is stamped once at INSERT. See the note in _sync_price_breaks
    # — a confirming pass now writes nothing, so feed freshness needs a home
    # that is not a per-row write.)
    unit_price = _storable_price(lowest_qty_break.unit_price)
    # Tracked separately from the "usable" return value below, and narrower
    # than "this row was touched": it is true only when something that can move
    # a MINIMUM moved. A stock or lead-time refresh writes the listing but
    # cannot change `parts.best_price*`, so it must not drag a part row into
    # the write set behind it.
    prices_moved = False
    if listing is None:
        # EVERY field on the constructor. Setting only the identity columns and
        # assigning the rest afterwards cost an INSERT plus an immediate UPDATE
        # of the row just inserted — two row versions and two sets of index
        # writes to create one listing, thousands of times per grow_catalog
        # sweep.
        listing = PartListing(
            id=uuid.uuid4(),
            part_id=part.id,
            supplier_id=supplier.id,
            sku=fp.supplier_sku,
            stock_quantity=fp.stock_quantity,
            lead_time_days=fp.lead_time_days,
            unit_price=unit_price,
            currency=fp.currency,
        )
        db.add(listing)
        # Sessions run autoflush=False — without this flush the NEXT
        # existence query in the same run cannot see this row, and a
        # repeated MPN mints a duplicate (part, supplier) listing
        # (review-caught, reproduced).
        db.flush()
        # A distributor's FIRST offer on this part can only lower the minimum
        # (or supply the only one there is).
        prices_moved = True
    else:
        listing.sku = fp.supplier_sku or listing.sku
        listing.stock_quantity = fp.stock_quantity
        listing.lead_time_days = fp.lead_time_days
        prices_moved = listing.unit_price != unit_price
        listing.unit_price = unit_price
        listing.currency = fp.currency
    if _sync_price_breaks(db, listing.id, fp.price_breaks):
        prices_moved = True
    if prices_moved:
        # The denormalized best prices are refreshed in the SAME transaction as
        # the offer that moved them, so the caller's per-part commit still
        # persists one consistent unit of work: a run killed mid-sweep never
        # leaves a part advertising a price its listings do not support.
        #
        # Gated on `prices_moved` rather than run unconditionally because the
        # confirming pass is the common case — a nightly Mouser sweep re-reads
        # ~130k listings and moves few of them — and an ungated call would put
        # three SELECTs per part back onto exactly that path. `refresh_best_
        # prices` would still write nothing, but the reads are the cost here.
        refresh_best_prices(db, [part.id])
    return True


def resolve_single(
    db: Session,
    provider: PartFeedProvider,
    supplier: Supplier,
    query: str,
    mpn: str | None,
) -> Part | None:
    """One BOM miss → at most one persisted Part. Persistence is IDENTICAL to
    a daytime import click (part + listing + breaks + media + fact stamping,
    per-row commit); category_id stays None — a live-resolved part is findable
    by search and part page, and category curation is a separate act."""
    if mpn:
        fp = provider.lookup_mpn(mpn)
    else:
        results = provider.search(query, limit=1)
        fp = results[0] if results else None
    if fp is None:
        return None
    try:
        part, _created = get_or_create_part(
            db,
            sku=fp.mpn,
            manufacturer_name=fp.manufacturer,
            build=lambda mid: _new_part(fp, None, None, manufacturer_id=mid),
        )
    except ValueError:
        # The feed returned a row with no usable manufacturer, so it cannot be
        # keyed. That is a miss, not a failure — this runs behind the PUBLIC
        # /api/bom/resolve stream, which catches only FeedFatalError, and an
        # escaping ValueError would break an anonymous visitor's NDJSON
        # mid-flight.
        logger.info("feed row for %r has no identifiable manufacturer — skipped", fp.mpn)
        return None
    db.flush()
    _upsert_listing(db, part, supplier, fp)
    _fill_part_media(part, fp)
    _stamp_feed_facts(part, fp)
    db.commit()
    return part


def sync_event(
    kind: str,
    supplier_id: str,
    title: str,
    detail: str | None = None,
    image_url: str | None = None,
    action: str | None = None,
) -> dict:
    """One wire event. Serialized verbatim as NDJSON by the streaming route —
    keep the key set stable (`counts` is added by `sync_finished` alone)."""
    return {
        "kind": kind,
        "supplier_id": supplier_id,
        "title": title,
        "detail": detail,
        "image_url": image_url,
        "action": action,
    }


def _category_names(db: Session, parts: list[Part]) -> dict:
    """id -> name for the candidate set, in ONE query (no per-part lookup)."""
    ids = {p.category_id for p in parts if p.category_id is not None}
    if not ids:
        return {}
    rows = db.query(Category.id, Category.name).filter(Category.id.in_(ids)).all()
    return {row[0]: row[1] for row in rows}


def sync_supplier_listings(
    db: Session,
    provider: PartFeedProvider,
    supplier: Supplier,
    limit: int = 25,
) -> Iterator[dict]:
    """Refresh one supplier's own listings from the provider, event per part.

    Identity rule: every listing attaches to the PASSED supplier row — the one
    the admin clicked. `_get_or_create_supplier` is deliberately NOT called
    here: a row named "Mouser" would not match the provider's own
    "Mouser Electronics" and a twin supplier would split the catalog.

    Commits PER PART, before the event is yielded, so a client disconnect or
    the quota wall never discards work already reported as done. A
    FeedFatalError is the wall, not a bug: it ends the stream with an error
    event plus the counts so far instead of raising out of the generator.
    """
    supplier_id = str(supplier.id)
    supplier_name = supplier.name
    parts = (
        db.query(Part)
        # EXISTS, not a JOIN. Migration 041's UNIQUE(part_id, supplier_id)
        # now makes a duplicate impossible, so this is no longer about
        # correctness — but EXISTS still short-circuits on the first match
        # while a join materialises the pairing, so it stays.
        .filter(
            db.query(PartListing.id)
            .filter(
                PartListing.part_id == Part.id,
                PartListing.supplier_id == supplier.id,
            )
            .exists()
        )
        # imageless parts first — they are what a sync visibly fixes
        .order_by(Part.image_url.is_(None).desc(), Part.sku)
        .limit(limit)
        .all()
    )
    category_names = _category_names(db, parts)
    synced = media_filled = not_found = no_data = 0

    def _finished() -> dict:
        detail = f"{synced} synced · {media_filled} images filled · {not_found} not found"
        if no_data:
            detail += f" · {no_data} no data"
        event = sync_event("sync_finished", supplier_id, supplier_name, detail)
        event["counts"] = {
            "synced": synced,
            "media_filled": media_filled,
            "not_found": not_found,
            "no_data": no_data,
            # A sync creates nothing — only `grow_catalog` does. The key is
            # here anyway so every run reports the same five counters and the
            # console never has to guess whether a number is missing or zero.
            "created": 0,
            "listing_added": 0,
        }
        return event

    yield sync_event("sync_started", supplier_id, supplier_name, f"{len(parts)} parts queued")
    try:
        for part in parts:
            sku = part.sku
            category = category_names.get(part.category_id)
            fp = provider.lookup_mpn(sku)
            if fp is None:
                not_found += 1
                yield sync_event("part_synced", supplier_id, sku, category, action="not_found")
                continue
            wrote_listing = _upsert_listing(db, part, supplier, fp)
            media = _fill_part_media(part, fp)
            # Facts are a real write, but not a MEDIA one — fold them into the
            # "updated" bucket so the counts keep meaning what they say.
            wrote_listing = _stamp_feed_facts(part, fp) or wrote_listing
            image_url = part.image_url
            db.commit()
            if media:
                # media IS a real write, priced feed row or not
                action = "media_filled"
                synced += 1
                media_filled += 1
            elif wrote_listing:
                action = "updated"
                synced += 1
            else:
                # found, but the feed carried no price and no new media —
                # counting it as synced would overstate what the run did
                action = "no_data"
                no_data += 1
            yield sync_event(
                "part_synced",
                supplier_id,
                f"{sku} — {fp.manufacturer}",
                category,
                image_url,
                action,
            )
    except FeedFatalError as exc:
        # str(exc) carries no API key — mouser.py never puts one in a message.
        db.rollback()
        yield sync_event("sync_error", supplier_id, "Feed unavailable", str(exc))
        yield _finished()
        return
    yield _finished()


IMPORT_CURSOR_EXHAUSTED = -1
"""`import_cursor` value meaning "this work unit has no more rows to read"."""

IMPORT_CURSOR_TOO_WIDE = -2
"""`import_cursor` value meaning "this query matched more rows than the
distributor will serve — narrow it before reading it".

Deliberately distinct from EXHAUSTED, because the two lead somewhere different.
Exhausted means the unit is finished and stays finished until its namespace
wraps. Too-wide means the unit was never READABLE at this width, and its longer
children are the real work — `_FamilySweep.units` expands it on the next
enumeration instead of re-probing it. Measured live on 2026-08-24: `SN74LV`
scoped to Texas Instruments matches 3,689 products against a 300-record window,
so paging it reads 8% of it and the other 3,389 are unreachable at that keyword
however many calls are spent. Lengthening the prefix opens a NEW window over a
different slice, which is the only reason this strategy has anywhere to go.
"""

# ── cursor namespaces ───────────────────────────────────────────────────────
#
# `supplier_feeds.import_cursor` is ONE flat JSON map per supplier, and it now
# has to hold two kinds of key. The collision is not hypothetical — verified
# against the live database on 2026-08-24:
#
#     SELECT e.key, e.value FROM supplier_feeds f,
#            json_each_text(f.import_cursor::json) e WHERE e.key = 'diodes';
#     -> diodes | 300
#
#     SELECT canonical_key, name, catalog_part_count FROM manufacturers
#      WHERE canonical_key = 'diodes';
#     -> diodes | Diodes Inc. | 1312
#
# `diodes` is BOTH a category slug carrying a live cursor of 300 AND a
# manufacturer holding 1,312 parts. In one key space the family sweep would
# open at record 300 of a query it has never issued, and the category sweep
# would be retired by a manufacturer it has never heard of.
#
# Keys are COMPOSED and never parsed back out. The reverse direction is where a
# manufacturer whose canonical key contains a colon would quietly split wrong.
CURSOR_NS_CATEGORY = "cat"
CURSOR_NS_FAMILY = "fam"

_LEGACY_CURSOR_KEY = re.compile(r"^[a-z0-9-]+$")
"""A pre-namespace key: a bare category slug.

Production holds 189 of them, 60 already marked exhausted. Dropping them would
restart every one of those categories at page 1 — a full re-read of the catalog
at one call per 50 parts, against a ~1,000/day quota. The shim is unambiguous
because no slug can be mistaken for a namespaced key:
`SELECT count(*) FROM categories WHERE slug !~ '^[a-z0-9-]+$'` returns 0 across
all 189.
"""


def category_cursor_key(slug: str) -> str:
    """The cursor key for one category shelf."""
    return f"{CURSOR_NS_CATEGORY}:{slug}"


def family_cursor_key(canonical_key: str, prefix: str) -> str:
    """The cursor key for one (manufacturer, MPN-prefix) family."""
    return f"{CURSOR_NS_FAMILY}:{canonical_key}:{prefix}"


def _cursor_get(cursor: dict, key: str) -> int | None:
    """This unit's stored depth, honouring the pre-namespace spelling.

    None means "never swept", which is what a fresh unit and an unknown key
    both are. The legacy fallback applies ONLY to the category namespace: a
    bare `diodes` written before namespacing was a category slug, and reading
    it as a family cursor is precisely the collision above.
    """
    if key in cursor:
        return cursor[key]
    namespace, _, rest = key.partition(":")
    if namespace == CURSOR_NS_CATEGORY and _LEGACY_CURSOR_KEY.match(rest):
        return cursor.get(rest)
    return None


def _cursor_set(cursor: dict, key: str, value: int) -> None:
    """Write the namespaced key and RETIRE the legacy twin.

    Leaving the bare key behind would be harmless for exactly one run and then
    permanent dead weight: `_cursor_get` prefers the namespaced value, so the
    old one is read never and written never, and it would sit in every
    supplier's JSON forever looking like live state.
    """
    cursor[key] = value
    namespace, _, rest = key.partition(":")
    if namespace == CURSOR_NS_CATEGORY and _LEGACY_CURSOR_KEY.match(rest):
        cursor.pop(rest, None)


def _cursor_clear_namespace(cursor: dict, namespace: str) -> dict:
    """A NEW map with `namespace`'s keys dropped — the wrap, per strategy.

    Per strategy because a wrap means "this sweep has read everything it can
    reach, start again"; clearing the whole map would throw away the OTHER
    distributor's paging depth for nothing. The category namespace also takes
    its legacy twins with it, or a wrapped category would immediately be
    resumed from the bare key the wrap was meant to forget.
    """
    prefix = f"{namespace}:"
    drop_legacy = namespace == CURSOR_NS_CATEGORY
    return {
        key: value
        for key, value in cursor.items()
        if not key.startswith(prefix)
        and not (drop_legacy and ":" not in key and _LEGACY_CURSOR_KEY.match(key))
    }


def _load_import_cursor(db: Session, supplier_id) -> dict[str, int]:
    """This supplier's sweep depth per work unit: {cursor_key: next start_at}.

    No row, or no stored value, is a FRESH catalog — which is exactly what the
    first import of every supplier sees, so run 1 behaves as it always did.
    """
    row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier_id).first()
    if row is None or not row.import_cursor:
        return {}
    return dict(row.import_cursor)


# How many work units may pass between cursor flushes.
#
# `_save_import_cursor` reassigns the WHOLE map and commits, so its cost is
# linear in the number of keys — and the family sweep's map grows toward 56,689
# and persists across runs. Measured on the local Postgres: 1.03 ms at 100 keys,
# 9.26 ms at 20,000, 29.24 ms and 1.67 MB of row rewrite at 56,689. Saving per
# page therefore made a run quadratic and slower every night, which is the
# "starts fast, gets slower and slower" report.
#
# Batching is safe because the WORK is already durable — `absorb` commits per
# part — so an ungraceful stop loses only paging DEPTH. Re-reading a page costs
# ONE provider call, so this number is a bound on wasted calls after a crash,
# not on lost data: 25 of a ~1,000/day budget, against a 25x cut in bookkeeping
# cost. Every exit path flushes, so a clean finish loses nothing at all.
CURSOR_FLUSH_EVERY = 25


def _save_import_cursor(db: Session, supplier_id, cursor: dict[str, int]) -> None:
    """Persist the whole cursor map, creating the feed row if it is missing.

    Re-queries instead of holding the row across the run's per-part commits
    (each of which expires it) — the same shape as the nightly job's
    `_stamp_run`. Creation mirrors the feed-settings PATCH upsert: `supplier_id`
    IS the primary key, so the two writers converge on ONE row, and
    `auto_import_enabled` is left at its default False — a cursor write must
    never switch a nightly job on.

    The value is REASSIGNED, never mutated in place: SQLAlchemy does not track
    mutations inside a plain JSON column, so an in-place edit would be dropped
    at commit without a word.
    """
    row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier_id).first()
    if row is None:
        row = SupplierFeed(supplier_id=supplier_id)
        db.add(row)
    row.import_cursor = dict(cursor)
    db.commit()


def _thinnest_subcategories(db: Session) -> list[Category]:
    """Every subcategory, emptiest first.

    A call spent on a bare shelf adds a whole page to the site; the same call
    spent on a full one adds a few rows nobody was missing. Name breaks ties so
    two runs over the same data sweep in the same order.
    """
    return (
        db.query(Category)
        .outerjoin(Part, Part.category_id == Category.id)
        .filter(Category.parent_id.isnot(None))
        .group_by(Category.id)
        .order_by(func.count(Part.id).asc(), Category.name.asc())
        .all()
    )


CONTINUOUS_CALL_CEILING = 5000
"""Runaway guard for a continuous import — NOT a budget.

The real ceiling is the provider's own quota: Mouser's ~1,000-calls/day tier
walls first and `grow_catalog` ends the run cleanly on that wall (the owner's
decision — "run until the well is dry"). This number exists only so a
pathological provider that never runs short and never refuses cannot sweep
forever: at the provider's ~2.1 s throttle it bounds such a run at ~3 hours
instead of at nothing.
"""


# ── work units and their counters ───────────────────────────────────────────


@dataclass(frozen=True)
class WorkUnit:
    """One thing a sweep asks about, once per page, under one cursor key.

    `payload` is the strategy's own business — a category's two scalars, or a
    family's (manufacturer, prefix). It holds SCALARS and never an ORM row: the
    sweep commits per part, which expires every instance, so a row read here
    would re-SELECT itself on the next attribute touch.
    """

    cursor_key: str
    scope: FeedScope
    label: str
    payload: object = None
    can_narrow: bool = False


@dataclass
class _SweepCounts:
    """Everything a run tallies, in one place.

    The first six are the WIRE contract (`counts` on `sync_finished`) and the
    console reads them by name — six keys always, so a reader never has to tell
    a missing counter from a zero one. The rest are detail-line only: a
    fully-covered page would emit 50 identical `already listed` events, which
    is noise a human cannot act on.
    """

    created: int = 0
    synced: int = 0
    media_filled: int = 0
    not_found: int = 0
    no_data: int = 0
    listing_added: int = 0
    # detail-only
    skipped_elsewhere: int = 0
    already_listed: int = 0
    off_scope: int = 0
    absent: int = 0

    def wire(self) -> dict[str, int]:
        return {
            "synced": self.synced,
            "media_filled": self.media_filled,
            "not_found": self.not_found,
            "no_data": self.no_data,
            "created": self.created,
            "listing_added": self.listing_added,
        }


def _absorb_feed_part(
    db: Session, supplier: Supplier, part: Part, fp: FeedPart, *, is_new: bool, counts: _SweepCounts
) -> tuple[str, str | None]:
    """Write one feed row onto one part and classify what happened.

    THE ONE COPY of the write block, shared by every strategy — the reason the
    sweep skeleton was extracted at all. Two near-identical copies of this
    ordering (flush, listing, media, facts, commit, THEN classify) is how the
    counters drift apart until `created` means one thing on one path and
    something else on the other.

    NOTHING here increments `synced`, and that is a load-bearing absence: an
    import that declines every part it already lists cannot have refreshed
    anything, so `synced == 0` on an import run is an invariant the operator
    can rely on and a test asserts. If it ever moves, a sweep is doing Sync
    Inventory's job again.

    The commit is per part and lands BEFORE the caller yields its event, so a
    client disconnect or a quota wall never discards work already reported as
    done.
    """
    # autoflush=False — the listing needs a real part.id, and the next
    # existence query has to see this row.
    db.flush()
    wrote_listing = _upsert_listing(db, part, supplier, fp)
    media = _fill_part_media(part, fp)
    # Facts are a real write, but not a MEDIA one — fold them into the
    # listing bucket so the counts keep meaning what they say.
    wrote_listing = _stamp_feed_facts(part, fp) or wrote_listing
    image_url = part.image_url
    db.commit()
    if is_new:
        # A new catalog row IS the win, priced or not: the part page exists now
        # and the next run can price it.
        counts.created += 1
        return "created", image_url
    if wrote_listing:
        # This supplier's FIRST offer on a part we already had — new inventory,
        # not a refresh. It used to report `updated` and tick `synced`, which
        # is what made an import look like a sync: 45,000 parts have no Mouser
        # listing, so this is the common path, not an edge case.
        counts.listing_added += 1
        if media:
            counts.media_filled += 1
        return "listing_added", image_url
    if media:
        # An image on a part this supplier has no price for. Still a fill,
        # still not a refresh.
        counts.media_filled += 1
        return "media_filled", image_url
    # found, but nothing changed — counting it as updated would overstate
    # what the run did
    counts.no_data += 1
    return "no_data", image_url


# ── the two strategies ──────────────────────────────────────────────────────


class SweepStrategy:
    """What differs between two imports; everything else is `_sweep_run`.

    Four things, and only four: which WORK UNITS exist and in what order, what
    to do with one returned FeedPart, where the cursor lands after a page, and
    what the operator is told. The counters, the wrap detection, the `want`
    arithmetic, the continuous loop's three exit conditions, the per-part
    commit ordering and the FeedFatalError handler are shared, because a fourth
    hand-copied version of the continuous-loop exit conditions in a file that
    already carries five sweep-shaped functions is how two of them silently
    stop agreeing.
    """

    namespace: str = CURSOR_NS_CATEGORY
    unit_noun: str = "units"

    def units(self, db, provider, supplier_pk, cursor, call_budget) -> list[WorkUnit]:
        raise NotImplementedError

    def is_wrapped(self, cursor, units) -> bool:
        """Has this strategy finished a full pass over its own universe?

        A hook rather than a rule `_sweep_run` applies for everyone, because
        the two strategies disagree about what `units()` returns.
        `_CategorySweep` returns EVERY category, so "all of them exhausted" is
        readable off the returned list. `_FamilySweep` returns candidates —
        it must not hand back 56,689 exhausted groups, and it filters them so
        they cannot occupy the `keep` budget ahead of live work — so the same
        expression reads False in BOTH of its terminal states and the namespace
        never cleared. The strategy that owns the filter is the one that can
        answer the question.
        """
        return bool(units) and all(
            _cursor_get(cursor, unit.cursor_key) == IMPORT_CURSOR_EXHAUSTED for unit in units
        )

    def absorb(self, db, supplier, unit, fp, counts) -> dict | None:
        raise NotImplementedError

    def next_cursor(self, provider, unit, start_at, raw_rows, want) -> int:
        raise NotImplementedError

    def started_detail(self, pending, call_budget, continuous) -> str:
        raise NotImplementedError

    def finished_detail(self, counts, provider) -> str:
        raise NotImplementedError


class _CategorySweep(SweepStrategy):
    """Fill the thinnest shelves — the original `grow_catalog`, unchanged.

    Byte-for-byte unchanged is the point: this is what Mouser's nightly run
    does, and the extraction is only defensible if it did not move.
    """

    namespace = CURSOR_NS_CATEGORY
    unit_noun = "categories"

    def units(self, db, provider, supplier_pk, cursor, call_budget) -> list[WorkUnit]:
        return [
            WorkUnit(
                cursor_key=category_cursor_key(cat.slug),
                scope=FeedScope(keyword=_search_keyword(cat), label=cat.name),
                label=cat.name,
                # Scalars, read ONCE: every per-part commit expires `cat`, and
                # touching it inside the page loop would re-SELECT it per row.
                payload=(cat.id, cat.slug),
            )
            for cat in _thinnest_subcategories(db)
        ]

    def absorb(self, db, supplier, unit, fp, counts) -> dict | None:
        cat_id, cat_slug = unit.payload
        try:
            part, is_new = get_or_create_part(
                db,
                sku=fp.mpn,
                manufacturer_name=fp.manufacturer,
                # Loop variables bound as defaults, not captured: the closure is
                # invoked inside this call today, but a late-binding lambda over a
                # loop variable is a bug waiting for the day get_or_create_part
                # defers it.
                build=lambda mid, fp=fp, cat_id=cat_id, cat_slug=cat_slug: _new_part(
                    fp, cat_id, cat_slug, manufacturer_id=mid
                ),
            )
        except ValueError:
            # No usable manufacturer, so the row cannot be keyed. One bad row
            # must not end the night: this generator's only caller-side handler
            # is the nightly job's blanket `except Exception`, which abandons
            # every remaining category for this supplier.
            logger.info("feed row for %r has no identifiable manufacturer — skipped", fp.mpn)
            counts.skipped_elsewhere += 1
            return None
        if not is_new and part.category_id != cat_id:
            # An MPN that already lives in ANOTHER category is never hijacked
            # into this one, and yields NO event — a stream of skips a human
            # cannot act on is noise; the finish line carries the tally.
            counts.skipped_elsewhere += 1
            return None
        # IMPORT IS NOT SYNC. A keyword page returns whatever the distributor
        # ranks highest for this shelf, which is more and more of what we
        # already hold as a category fills up — and refreshing those is
        # precisely what the Sync Inventory button does
        # (`sync_supplier_listings` selects exactly the parts this supplier
        # already lists). Import takes the complement, so the two buttons
        # partition every (part, supplier) pair between them with no overlap
        # and no gap.
        #
        # Note this is NOT "skip every part we already have": a part we hold
        # from a DIFFERENT distributor falls through to the write below and
        # gains this supplier's offer. Sync can never reach that part (its
        # EXISTS filter excludes it), and one part with two prices is the
        # entire point of the catalog.
        if not is_new and _supplier_already_lists(db, part.id, supplier.id):
            counts.already_listed += 1
            return None
        action, image_url = _absorb_feed_part(db, supplier, part, fp, is_new=is_new, counts=counts)
        return sync_event(
            "part_synced",
            str(supplier.id),
            f"{fp.mpn} — {fp.manufacturer}",
            unit.label,
            image_url,
            action,
        )

    def next_cursor(self, provider, unit, start_at, raw_rows, want) -> int:
        # Advance by the RAW rows the provider consumed, not by the parts kept:
        # rows that failed to decode still took their place in the result set,
        # and advancing by the survivors would re-fetch the junk every run.
        # Short of what was asked for = the shelf ran out.
        return IMPORT_CURSOR_EXHAUSTED if raw_rows < want else start_at + raw_rows

    def started_detail(self, pending, call_budget, continuous) -> str:
        if continuous:
            return (
                "growing catalog · continuous — sweeping until the feed is "
                "exhausted or its quota is reached"
            )
        return f"growing catalog · budget {call_budget} calls · {len(pending)} categories to sweep"

    def finished_detail(self, counts, provider) -> str:
        return (
            f"{counts.created} created · {counts.listing_added} listings added · "
            f"{counts.already_listed} already listed · "
            f"{counts.skipped_elsewhere} already elsewhere · {provider.calls_made} calls used"
        )


FAMILY_PREFIX_MIN = 6
"""How many leading MPN characters the first family query asks about.

Measured over the live catalog (175,728 parts, every one of them covered at
every length): 3 characters yields 23,047 (maker, prefix) groups, 4 yields
36,310, 6 yields 71,170. Shorter means fewer units but a taller narrowing tree,
and every level of that tree costs one call per lineage; longer means more
units, each already narrow. Six is a starting point, NOT a law — the right
value is whatever night one's ProductsCount histogram says, and it is a
one-line change because nothing else depends on it.
"""

FAMILY_PREFIX_MAX = 12
"""Where narrowing gives up and pages the window it can reach.

A prefix cannot grow forever: past this the query is nearly the MPN itself and
each unit is one call for a handful of records. A family still too wide here
gets its 300 reachable records read and is then retired — an honest partial
answer rather than an unbounded recursion.
"""

FAMILY_SEARCH_WINDOW = 300
"""Fallback for a provider that does not declare its own `search_window`.

DigiKey's measured `Offset + Limit <= 300`. Read off the provider so a
distributor with a different ceiling needs no change here.
"""

_FAMILY_UNIT_SLACK = 4
"""How many candidate units to build per call of budget, before stopping.

A unit costs at least one call, so `call_budget` units is the true bound; the
slack covers the ones that turn out too wide (they spend their call and are
replaced by children on the next pass).

The enumeration is ordered thickest-first IN SQL, so capping construction keeps
the units that matter. What it saves is objects, not rows: the query returns
every group either way. Measured against the live catalog on 2026-08-24 —
71,170 level-6 groups over 175,728 parts, of which 56,689 groups / 145,120
parts are scopeable by the committed DigiKey map — one `units()` call costs
~1.0 s end to end (~0.8 s of it the aggregate itself). That is nothing beside
850 calls at 0.55 s apiece, but building a WorkUnit and a FeedScope for all
seventy thousand on every pass of a continuous run, for the sake of the first
few hundred, is worth not doing.

The cap is on CONSTRUCTION ONLY and never on the scan, and never on the
children of a too-wide parent — see the comment at the `continue`. Breaking out
of the scan instead left narrowing permanently starved: `kept` fills within the
first few hundred of those 56,689 base units, so no prefix would ever have
grown.
"""


def _unit_rank(row: tuple[int, str, "WorkUnit"]) -> tuple[int, str]:
    """Order candidate work units: most unlisted parts first, then by key.

    Key-second is for DETERMINISM, not taste — two runs over the same data must
    probe in the same order or the cursor map means something different each
    night.
    """
    return row[0], row[1]


@dataclass(frozen=True)
class _Family:
    """One (manufacturer, MPN-prefix) group, all scalars."""

    canonical_key: str
    manufacturer_id: uuid.UUID
    manufacturer_name: str
    prefix: str
    unlisted: int
    has_longer: bool = False
    """Does any part in this group have an SKU LONGER than the prefix?

    i.e. would a narrower prefix actually split it. Read off the group's own
    rows because this is a fact about OUR catalog, and the level counter
    (`level < FAMILY_PREFIX_MAX`) cannot stand in for it: a family whose SKUs
    all stop at the prefix has room left in the arithmetic and no children to
    find, so narrowing returns the same group, it is marked too wide again, and
    the cursor oscillates while re-reading the same first page for a call each
    time."""


class _FamilySweep(SweepStrategy):
    """The overlap sweep: find a SECOND price for parts we already hold.

    The question is the inverse of the category sweep's. A category asks "what
    does this distributor sell on this shelf" and is answered mostly with parts
    we do not have; this asks "of the parts we HAVE, which does this
    distributor also sell", and the answer is a comparison row — the thing the
    site's whole premise rests on and currently cannot show.

    Work units come from OUR OWN SKUs, at zero API cost, ordered by how many
    parts this supplier does not yet list under them. Each is narrowed by the
    distributor's manufacturer id, which is what makes a six-character prefix a
    precise question instead of a catalog-wide one.

    IT ALSO CREATES — Phase 4, shipped 2026-08-29, without the taxonomy map
    the original deferral assumed. A family window is derived from parts we
    ALREADY hold, and those members know where they live: when the family's
    categorised parts agree on one category by a two-thirds share, an unheld
    sibling on the same page is filed there (`SN74LV @ TI` siblings are logic
    parts; the measured cost of NOT creating was 23,530 brand-new parts read
    and discarded in one 850-call night). A family whose members disagree — or
    carry no category at all — still declines: an uncategorised part is a page
    no visitor can reach, and a coin-flip category is worse than absence.
    """

    namespace = CURSOR_NS_FAMILY
    unit_noun = "part families"

    def __init__(self) -> None:
        # Anchor cache, per run: {(canonical_key, prefix): (cat_id, sub_slug) | None}.
        # Resolved lazily at absorb time — only families that actually meet an
        # unheld part pay the query, and a 50-row page pays it once.
        self._anchors: dict[tuple[str, str], tuple[uuid.UUID, str | None] | None] = {}

    # Set by `units()` on every scan: True when the scan saw families but every
    # one of them was already exhausted. `units()` filters those out (they must
    # not occupy the `keep` budget ahead of live work), so the returned list
    # cannot carry the terminal state and `_sweep_run` cannot read it off one.
    _exhausted_everything: bool = False

    def is_wrapped(self, cursor, units) -> bool:
        """Wrapped when the last scan found families and none of them had work.

        Deliberately NOT `not units`: an empty catalog, an unmapped-manufacturer
        map, or a scope the provider refuses all produce zero units too, and
        clearing the namespace for those would spin a pointless restart every
        run forever. Only "we looked, they were all finished" is a wrap.
        """
        return bool(self._exhausted_everything)

    def units(self, db, provider, supplier_pk, cursor, call_budget) -> list[WorkUnit]:
        scope_for = getattr(provider, "manufacturer_scope", None)
        if not callable(scope_for):
            raise FeedScopeUnsupported(
                f"{type(provider).__name__} declares the family import strategy but has "
                "no manufacturer_scope() — without a manufacturer id every family query "
                "is a catalog-wide question"
            )
        keep = max(1, call_budget) * _FAMILY_UNIT_SLACK
        # Split, because the cap applies to only ONE of them. `base` is the
        # level-6 floor — tens of thousands of groups, of which a pass can
        # afford a few hundred. `narrowed` holds the children of families the
        # API refused to page, and those are NEVER capped: they are the only
        # query that can reach the parts underneath such a parent.
        base: list[tuple[int, str, WorkUnit]] = []
        narrowed: list[tuple[int, str, WorkUnit]] = []
        # (canonical_key, prefix) pairs whose cursor says "too wide" — their
        # LONGER children are the NEXT level's work.
        parents: set[tuple[str, str]] | None = None
        level = FAMILY_PREFIX_MIN
        # ABOVE the narrowing loop, not inside it. Initialising them per
        # iteration meant only the LAST pass was remembered: a first pass that
        # found plenty of work followed by a final narrowing pass that found
        # none reported a completed sweep, cleared the family cursor namespace,
        # and sent the next run back to page one of everything.
        #
        # `saw_sweepable` is families this distributor CAN be asked about;
        # `saw_unfinished` is those with work left. A family with no scope is
        # neither — counting it as outstanding would mean never wrapping while
        # any maker is unmapped (592 of them, 30,608 parts), and counting it as
        # swept would report a full pass over a catalog we never touched.
        saw_sweepable = False
        saw_unfinished = False
        while True:
            groups = self._groups(db, supplier_pk, level, parents)
            if parents is not None:
                # A too-wide parent that produced NO child at this level has
                # nowhere narrower to go — every part under it IS the prefix.
                # Re-emit it so the 300 records it CAN reach get read instead
                # of being silently abandoned. Checked here, one level down,
                # and never in the same iteration that discovered the parent:
                # doing it there re-emits every too-wide unit alongside its own
                # children, spending a call to re-ask the exact question that
                # was already answered "too wide".
                produced = {parent for _, parent in groups if parent is not None}
                for orphan in parents - produced:
                    self._reemit(db, supplier_pk, orphan, scope_for, narrowed)
            expand: set[tuple[str, str]] = set()
            for family, _parent in groups:
                key = family_cursor_key(family.canonical_key, family.prefix)
                state = _cursor_get(cursor, key)
                if state == IMPORT_CURSOR_EXHAUSTED:
                    # Swept to the end: ours, and finished.
                    saw_sweepable = True
                    continue
                _sweepable_before, _unfinished_before = saw_sweepable, saw_unfinished
                saw_sweepable = True
                saw_unfinished = True
                if state == IMPORT_CURSOR_TOO_WIDE:
                    expand.add((family.canonical_key, family.prefix))
                    continue
                if parents is None and len(base) >= keep:
                    # Enough BASE units to spend the budget several times over,
                    # and `groups` is ordered thickest-first, so everything
                    # below this point is worth strictly less than what is
                    # already held.
                    #
                    # `continue`, NOT `break`, and this is the whole point:
                    # the scan has to keep going to collect `expand`, because
                    # the too-wide entries it finds below here are the ONLY
                    # route to the parts underneath them. Breaking out instead
                    # left narrowing permanently starved — measured on the live
                    # catalog, `base` fills inside the first few hundred of
                    # 56,689 scopeable groups, so no prefix would ever grow.
                    continue
                scope = scope_for(family.canonical_key, family.prefix)
                if scope is None:
                    # This distributor has no id for that maker, so the query
                    # cannot be narrowed. Running it unfiltered would spend
                    # calls reading somebody else's catalog.
                    #
                    # Unwind the two flags set above: an unsweepable family is
                    # neither outstanding work nor a family we swept. Leaving
                    # `saw_unfinished` set here would block the wrap forever on
                    # any catalog holding an unmapped maker.
                    saw_sweepable = _sweepable_before
                    saw_unfinished = _unfinished_before
                    continue
                (base if parents is None else narrowed).append(
                    (
                        -family.unlisted,
                        key,
                        WorkUnit(
                            cursor_key=key,
                            scope=scope,
                            label=f"{family.manufacturer_name} · {family.prefix}",
                            payload=family,
                            # The family's OWN answer, not the level counter —
                            # see `_Family.has_longer`. Still bounded by the
                            # arithmetic: no children are reachable past the max.
                            can_narrow=family.has_longer and level < FAMILY_PREFIX_MAX,
                        ),
                    )
                )
            if not expand:
                break
            if level >= FAMILY_PREFIX_MAX:
                # Out of room to narrow. These can only ever be read as far as
                # the window reaches, so read them.
                for orphan in expand:
                    self._reemit(db, supplier_pk, orphan, scope_for, narrowed)
                break
            parents = expand
            level += 1
        # The cap lands on `base` alone and BEFORE the merge. A final slice
        # over the union would cut the children straight back out: with one
        # unlisted part each, a narrowed `SN74LVC` ties with a base `AAAAAA`
        # and loses on the alphabet.
        #
        # Sorted on the SCALARS only. WorkUnit is a frozen dataclass without
        # `order=True`, so a comparison reaching the third element would raise
        # TypeError — unreachable today because the cursor key is unique per
        # (maker, prefix), which is the kind of "unreachable" that stops being
        # true the moment someone adds a second emit path.
        base.sort(key=_unit_rank)
        selected = narrowed + base[:keep]
        selected.sort(key=_unit_rank)
        # Recorded HERE because it is the only place that saw the unfiltered
        # scan. `selected` has had the exhausted families removed, so nothing
        # downstream can tell "every family is finished, restart the pass" from
        # "there was nothing to sweep" — and treating the second as a wrap would
        # clear the namespace on every run of an empty catalog, forever.
        self._exhausted_everything = saw_sweepable and not saw_unfinished and not selected
        return [unit for _, _, unit in selected]

    def _reemit(self, db, supplier_pk, orphan, scope_for, kept) -> None:
        """A too-wide family with no longer children: page what we can reach."""
        canonical_key, prefix = orphan
        family = self._one_group(db, supplier_pk, canonical_key, prefix)
        if family is None:
            return
        scope = scope_for(canonical_key, prefix)
        if scope is None:
            return
        kept.append(
            (
                -family.unlisted,
                family_cursor_key(canonical_key, prefix),
                WorkUnit(
                    cursor_key=family_cursor_key(canonical_key, prefix),
                    scope=scope,
                    label=f"{family.manufacturer_name} · {prefix}",
                    payload=family,
                    can_narrow=False,
                ),
            )
        )

    def _base_query(self, db: Session, supplier_pk):
        """Parts we hold that THIS supplier does not list, by manufacturer.

        The NOT EXISTS is the sweep's whole subject: a part this supplier
        already carries is Sync Inventory's, and asking about it here would
        spend a rate-limited call to re-derive a row we already have.
        """
        return (
            db.query(Manufacturer, Part.sku)
            .join(Part, Part.manufacturer_id == Manufacturer.id)
            .filter(
                ~db.query(PartListing.id)
                .filter(
                    PartListing.part_id == Part.id,
                    PartListing.supplier_id == supplier_pk,
                )
                .exists()
            )
        )

    def _groups(
        self, db: Session, supplier_pk, level: int, parents: set[tuple[str, str]] | None
    ) -> list[tuple[_Family, tuple[str, str] | None]]:
        """(family, parent) rows at `level`, thickest first.

        `substr`, never Postgres' `left`: the suite runs on SQLite and this is
        the one query in the sweep whose dialect could diverge silently — a
        SQLite-only failure here would look like "the family sweep finds
        nothing", which is also what a correctly-empty catalog looks like.
        """
        prefix_col = func.upper(func.substr(Part.sku, 1, level)).label("prefix")
        columns = [
            Manufacturer.canonical_key,
            Manufacturer.id,
            Manufacturer.name,
            prefix_col,
            func.count(Part.id).label("unlisted"),
            # `length`, never `octet_length`: `substr` above is character-based
            # on both engines and the two must measure the same units, or a
            # multi-byte SKU reports children it does not have.
            func.max(func.length(Part.sku)).label("longest"),
        ]
        group_by = [Manufacturer.canonical_key, Manufacturer.id, Manufacturer.name, prefix_col]
        parent_col = None
        query = self._base_query(db, supplier_pk)
        if parents is not None:
            parent_col = func.upper(func.substr(Part.sku, 1, level - 1)).label("parent")
            columns.insert(3, parent_col)
            group_by.insert(3, parent_col)
            # Filtered by MAKER, not by (maker, prefix) pair: one small IN list
            # instead of a thousand-term OR, with the pair check done in Python
            # below. The maker set is bounded by what actually went too wide.
            query = query.filter(Manufacturer.canonical_key.in_({key for key, _ in parents}))
        rows = (
            query.with_entities(*columns)
            .group_by(*group_by)
            .order_by(func.count(Part.id).desc(), Manufacturer.canonical_key.asc(), prefix_col)
            .all()
        )
        out: list[tuple[_Family, tuple[str, str] | None]] = []
        for row in rows:
            if parents is None:
                key, mid, name, prefix, unlisted, longest = row
                parent = None
            else:
                key, mid, name, parent_prefix, prefix, unlisted, longest = row
                parent = (key, parent_prefix)
                if parent not in parents or prefix == parent_prefix:
                    # `prefix == parent_prefix` means the SKU is not long
                    # enough to narrow — keeping it would re-enqueue the parent
                    # as its own child, forever.
                    continue
            out.append(
                (
                    _Family(key, mid, name, prefix, unlisted, has_longer=(longest or 0) > level),
                    parent,
                )
            )
        return out

    def _one_group(self, db: Session, supplier_pk, canonical_key: str, prefix: str):
        level = len(prefix)
        prefix_col = func.upper(func.substr(Part.sku, 1, level))
        row = (
            self._base_query(db, supplier_pk)
            .with_entities(Manufacturer.id, Manufacturer.name, func.count(Part.id))
            .filter(Manufacturer.canonical_key == canonical_key, prefix_col == prefix)
            .group_by(Manufacturer.id, Manufacturer.name)
            .first()
        )
        if row is None:
            return None
        return _Family(canonical_key, row[0], row[1], prefix, row[2])

    def _anchor(self, db: Session, family: _Family) -> tuple[uuid.UUID, str | None] | None:
        """Where this family's parts live, when its members agree.

        The dominant `category_id` among OUR categorised parts under
        (manufacturer, prefix), accepted only at a two-thirds share — a family
        split down the middle has no opinion worth filing a new part under.
        Returns the `(category_id, sub_slug)` pair `_new_part` wants: a CHILD
        category contributes its slug as `sub_slug` (the category page filters
        on it), a top-level one contributes None — the same convention
        `create_part` keeps.
        """
        key = (family.canonical_key, family.prefix)
        if key in self._anchors:
            return self._anchors[key]
        rows = (
            db.query(Part.category_id, func.count(Part.id))
            .filter(
                Part.manufacturer_id == family.manufacturer_id,
                func.upper(func.substr(Part.sku, 1, len(family.prefix))) == family.prefix,
                Part.category_id.isnot(None),
            )
            .group_by(Part.category_id)
            .order_by(func.count(Part.id).desc())
            .all()
        )
        anchor = None
        total = sum(n for _, n in rows)
        if rows and rows[0][1] * 3 >= total * 2:
            cat = db.query(Category).filter(Category.id == rows[0][0]).first()
            if cat is not None:
                anchor = (cat.id, cat.slug if cat.parent_id is not None else None)
        self._anchors[key] = anchor
        return anchor

    def absorb(self, db, supplier, unit, fp, counts) -> dict | None:
        family: _Family = unit.payload
        manufacturer_id = self._resolve_maker(
            db, fp.manufacturer, family, unit.scope, fp.provider_manufacturer_id
        )
        if manufacturer_id is None:
            # Only reachable on an UNSCOPED page — a scoped one is vouched for
            # by the distributor's own filter (see _resolve_maker). The earlier
            # "measured live this never happens, 0 off-scope across 150 records"
            # was measured over two makers whose spellings happen to match ours
            # exactly, and read as "working as designed" while every pinned and
            # every accented maker was being discarded.
            counts.off_scope += 1
            return None
        part = find_part(db, manufacturer_id, fp.mpn)
        is_new = False
        if part is None:
            # Phase 4: an unheld sibling rides in on a page already paid for.
            # Create it ONLY when the family's own held parts agree on where it
            # lives (_anchor); otherwise decline exactly as before — an
            # uncategorised part is a page nothing links to.
            anchor = self._anchor(db, family)
            if anchor is None:
                counts.absent += 1
                return None
            cat_id, sub_slug = anchor
            try:
                part, is_new = get_or_create_part(
                    db,
                    sku=fp.mpn,
                    manufacturer_name=fp.manufacturer,
                    # Defaults, not captures — the same late-binding guard the
                    # category sweep documents on its own call.
                    build=lambda mid, fp=fp, cat_id=cat_id, sub_slug=sub_slug: _new_part(
                        fp, cat_id, sub_slug, manufacturer_id=mid
                    ),
                )
            except ValueError:
                # No usable manufacturer key — one bad row must not end the
                # night (the category sweep's own rule).
                counts.absent += 1
                return None
        if not is_new and _supplier_already_lists(db, part.id, supplier.id):
            # Sync Inventory's territory. Refreshing it here would spend a
            # rate-limited call to do the other button's job.
            counts.already_listed += 1
            return None
        action, image_url = _absorb_feed_part(db, supplier, part, fp, is_new=is_new, counts=counts)
        return sync_event(
            "part_synced",
            str(supplier.id),
            f"{fp.mpn} — {fp.manufacturer}",
            unit.label,
            image_url,
            action,
        )

    @staticmethod
    def _resolve_maker(
        db: Session,
        raw_name: str | None,
        family: _Family,
        scope: FeedScope,
        provider_maker_id: str | None,
    ):
        """The scoped manufacturer's id, or None if this row is someone else's.

        ASK IN THE DISTRIBUTOR'S OWN IDENTIFIERS WHEN IT GIVES US THEM. The
        query was narrowed with `ManufacturerFilter=<ids>`; a row carrying one
        of those ids is from a maker we filtered on, by the distributor's own
        statement, and no spelling is involved.

        This used to compare NAMES — `canon(row_name) == family.canonical_key`
        — which asks whether the two sides SPELL the company identically. For
        makers whose spellings already agree that is a tautology. For the rest
        it is exactly inverted, because those entries are in the map PRECISELY
        because the spellings differ. Measured against the real catalog and the
        live Digi-Key list: 26 of 476 mapped makers discarded, 20,752 parts,
        14.3% of everything mapped — including ALL 22 hand pins, whose entire
        justification is that `canon()` correctly refuses to merge the two
        names ("Analog Devices Inc." is not `analog devices maxim integrated`;
        "Eaton Tripp Lite" is not `tripp lite`). Those makers own 8,384
        six-character families, so roughly eight days of a shared 1,000/day
        quota was going on queries structurally incapable of writing a row,
        each one reported as `off_scope` beside a comment promising the
        operator that counter never fires.

        The id was thrown away twice before it got here: the generator held
        Digi-Key's Name beside its Id and persisted only the Id, and the parser
        read `Manufacturer.Name` straight past the `Manufacturer.Id` in the
        same dict. Carrying it through is a join, not a new rule.

        NAME FALLBACK, for providers that send no id. Mouser does not, and an
        unscoped page has nothing vouching for it either, so `canon()` equality
        with an alias fallback remains the only available question there.

        THIS IS STILL A GATE, and deliberately so. An earlier attempt trusted
        the scope outright and returned `family.manufacturer_id` for every row;
        two existing tests caught it, correctly. `absorb` uses the id returned
        here to call `find_part(manufacturer_id, mpn)` against OUR catalog, so
        a foreign row whose MPN collides with a part we hold under this maker
        would have had another company's price written onto it. Comparing ids
        refuses that row on the same evidence, without refusing the 26.
        """
        if provider_maker_id is not None:
            scoped_ids = {
                part.strip() for part in (scope.manufacturer_id or "").split(",") if part.strip()
            }
            if scoped_ids:
                return family.manufacturer_id if provider_maker_id in scoped_ids else None
        if canon(raw_name or "") == family.canonical_key:
            return family.manufacturer_id
        # `manufacturer_aliases` is 2,519 rows on production and every one is a
        # 1:1 self-alias, so this resolves a DIFFERENT spelling to this maker
        # exactly never today. Kept because the table is the designed home for
        # that mapping and the sweep should use it the day it holds one.
        resolved = _existing_manufacturer_id(db, raw_name)
        return family.manufacturer_id if resolved == family.manufacturer_id else None

    def next_cursor(self, provider, unit, start_at, raw_rows, want) -> int:
        window = getattr(provider, "search_window", FAMILY_SEARCH_WINDOW)
        total = getattr(provider, "last_total_count", None)
        if total is not None and total > window and unit.can_narrow:
            # Too wide to read out. Its longer children are the real work, and
            # they open windows this keyword never could — that is the whole
            # difference between a sweep with somewhere to go and one that is
            # lifetime-capped at 300 records per maker.
            return IMPORT_CURSOR_TOO_WIDE
        # `min(ProductsCount, window)` is what is REACHABLE. An unknown total
        # (the feed did not say) falls back to the window, which pages rather
        # than retiring a family nobody looked at.
        reachable = min(total, window) if total is not None else window
        nxt = start_at + raw_rows
        if raw_rows < want or nxt >= reachable:
            return IMPORT_CURSOR_EXHAUSTED
        return nxt

    def started_detail(self, pending, call_budget, continuous) -> str:
        if continuous:
            return (
                "sweeping for overlap · continuous — until the feed is "
                "exhausted or its quota is reached"
            )
        return (
            f"sweeping for overlap · budget {call_budget} calls · "
            f"{len(pending)} part families to probe"
        )

    def finished_detail(self, counts, provider) -> str:
        return (
            f"{counts.created} created · "
            f"{counts.listing_added} listings added · "
            f"{counts.already_listed} already listed · "
            f"{counts.absent} declined — no category consensus · "
            f"{counts.off_scope} off scope · {provider.calls_made} calls used"
        )


IMPORT_STRATEGIES: dict[str, type[SweepStrategy]] = {
    "category": _CategorySweep,
    "family": _FamilySweep,
}
"""Strategy name -> class. A provider names its own with `import_strategy`.

Read off the PROVIDER rather than off the registry on purpose: which question
is worth asking a distributor is a fact about that distributor's API (Mouser
has no manufacturer filter; DigiKey does and enforces a 300-record window), not
about which supplier row happens to point at it.
"""


def _strategy_for(provider: PartFeedProvider) -> SweepStrategy:
    name = getattr(provider, "import_strategy", "category")
    try:
        return IMPORT_STRATEGIES[name]()
    except KeyError:
        raise ValueError(
            f"{type(provider).__name__} asks for import strategy {name!r}, which does "
            f"not exist (known: {sorted(IMPORT_STRATEGIES)})"
        ) from None


def grow_catalog(
    db: Session,
    provider: PartFeedProvider,
    supplier: Supplier,
    call_budget: int,
    per_category: int = 50,
    continuous: bool = False,
) -> Iterator[dict]:
    """Import NEW inventory for at most `call_budget` provider calls.

    The mirror image of `sync_supplier_listings` economics: a sync spends one
    call per part it already has, an import spends one call per PAGE of parts
    it does not.

    WHICH import depends on the provider. Mouser fills the thinnest CATEGORY
    shelves; DigiKey sweeps (manufacturer, MPN-prefix) FAMILIES looking for a
    second price on parts we already hold. Both run through one generator with
    one set of counters — see `SweepStrategy` for exactly what differs.

    `per_category` keeps its name because every caller passes it positionally
    or not at all; it is the per-UNIT record ceiling for both strategies.
    """
    return _sweep_run(
        db,
        provider,
        supplier,
        _strategy_for(provider),
        call_budget=call_budget,
        per_unit=per_category,
        continuous=continuous,
    )


def _sweep_run(
    db: Session,
    provider: PartFeedProvider,
    supplier: Supplier,
    strategy: SweepStrategy,
    *,
    call_budget: int,
    per_unit: int,
    continuous: bool,
) -> Iterator[dict]:
    """One import run, whatever the work unit is.

    Shares the sync's rails: listings attach to the PASSED supplier row (a
    name-matched twin would split the catalog), work COMMITS PER PART before
    its event is yielded, and a FeedFatalError ends the stream with an error
    plus the counts so far instead of raising out of the generator.

    DEPTH is what keeps repeat runs useful. `supplier_feeds.import_cursor`
    remembers how far into each unit's results this supplier has already read,
    so every run asks for the NEXT page rather than re-reading page one (the
    owner-reported plateau: after the first sweep, Import found nothing new). A
    unit that answers with fewer raw rows than it asked for is EXHAUSTED and
    stops consuming budget; when every unit is exhausted the namespace is
    cleared and the sweep starts from the top again. The cursor is persisted
    PER UNIT, on its own commit, so a quota wall mid-run keeps the depth the
    finished units already paid for.

    ONE PASS OR MANY — that is what `continuous` decides, and it is the whole
    difference between the two callers:

    * `continuous=False` (the default, and what `jobs/feed_import_daily`
      always uses) makes ONE pass down the pending units and returns even with
      budget left over. The bound is then the UNIT LIST, which is correct for
      an unattended nightly run: the night's `FEED_IMPORT_CALL_BUDGET` is split
      evenly across every enabled supplier, and letting the first supplier run
      until the well is dry would starve the rest of them and the operator's
      next-day clicks.
    * `continuous=True` (the interactive Import click on a supplier whose
      Auto-import switch is ON) re-derives the pending list and sweeps AGAIN,
      batch after batch.

    A continuous run ends on exactly three things: a FeedFatalError (the quota
    wall — caught below, so the run ends cleanly with `sync_error` plus the
    counts so far), an empty pending list, or `CONTINUOUS_CALL_CEILING`. It
    deliberately does NOT wrap and restart mid-run: `wrapped` is evaluated ONCE
    at run start, so a fully-swept catalog restarts on the NEXT click or night.
    A mid-run wrap against a healthy provider is an infinite re-read.

    The run reports ONE `sync_started` and ONE `sync_finished` however many
    passes it makes — the wire shape and the six-key `counts` set are the same
    for both modes, so nothing downstream has to know which one ran.
    """
    supplier_id = str(supplier.id)
    supplier_name = supplier.name
    # The PK itself, read once: every per-part commit expires `supplier`, and
    # the cursor writes need the UUID rather than the event string.
    supplier_pk = supplier.id
    counts = _SweepCounts()
    sweeps = 0

    def _finished() -> dict:
        detail = strategy.finished_detail(counts, provider)
        if continuous:
            detail += f" · {sweeps} sweeps"
        event = sync_event("sync_finished", supplier_id, supplier_name, detail)
        event["counts"] = counts.wire()
        return event

    cursor = _load_import_cursor(db, supplier_pk)
    units = strategy.units(db, provider, supplier_pk, cursor, call_budget)
    wrapped = strategy.is_wrapped(cursor, units)
    if wrapped:
        # Every unit has answered "no more rows". Sweeping them again is the
        # useful thing to do — it re-verifies what is listed and catches what
        # the distributor added since — so clear THIS namespace rather than
        # idling forever. Evaluated HERE and nowhere else: a continuous run
        # that re-wrapped between passes would never stop.
        cursor = _cursor_clear_namespace(cursor, strategy.namespace)
        units = strategy.units(db, provider, supplier_pk, cursor, call_budget)
    pending = [
        unit for unit in units if _cursor_get(cursor, unit.cursor_key) != IMPORT_CURSOR_EXHAUSTED
    ]

    # A one-element list, not an int: `_sweep` closes over it and must be able
    # to reset it, and the flush in the `finally` below has to see the same
    # count across every pass of a continuous run.
    cursor_dirty = [0]

    def _flush_cursor() -> None:
        if not cursor_dirty[0]:
            return
        # ROLL BACK FIRST. This runs from a `finally`, so it is reached on paths
        # nobody cleaned up: only the FeedFatalError branch rolls back, and any
        # other exception — an IntegrityError from `absorb`'s commit, which the
        # api and feed-import containers can genuinely produce against the same
        # part rows — leaves the session poisoned. Without this the flush's own
        # query raises PendingRollbackError from inside the `finally`,
        # REPLACING the real exception, so the operator's sync_error blames
        # "This Session's transaction has been rolled back" instead of the
        # cause, and the cursor is lost as well.
        #
        # Safe by construction rather than by luck: `absorb` commits per part,
        # so at any point this is reached a healthy session has nothing pending
        # and the rollback is a no-op. It also protects the commit-per-part
        # boundary — without it, a failure between `db.flush()` and `absorb`'s
        # commit would have `_save_import_cursor`'s own commit persist a
        # half-absorbed part alongside the cursor.
        db.rollback()
        _save_import_cursor(db, supplier_pk, cursor)
        cursor_dirty[0] = 0

    def _sweep(batch: list[WorkUnit]) -> Iterator[dict]:
        """ONE pass down `batch`. The unit `continuous` repeats.

        Closes over the run's counters and `cursor` rather than returning them:
        the totals belong to the RUN, not to a pass, and the cursor a pass
        advances is what the next pass reads to ask for the next page.
        """
        for unit in batch:
            remaining_calls = call_budget - provider.calls_made
            if remaining_calls <= 0:
                break
            # `search` paginates INSIDE the provider, so the size asked for is
            # the only place the budget can bound pages: N records cost
            # ceil(N / records_per_call) calls.
            want = min(per_unit, remaining_calls * provider.records_per_call)
            start_at = _cursor_get(cursor, unit.cursor_key) or 0
            if start_at < 0:
                # A sentinel, not a depth. TOO_WIDE units re-enter here after
                # being narrowed away and back; reading one as an offset would
                # ask the distributor for record -2.
                start_at = 0
            seen: set[tuple[str, str]] = set()
            for fp in search_scoped(provider, unit.scope, want, start_at):
                # Keyed on the SAME pair as part identity. On MPN alone this
                # dropped a legitimately distinct part: one page really does
                # carry 1N4148 from Vishay and from onsemi, and 49 such
                # cross-manufacturer MPN pairs exist on production. Skipping
                # the second would have enforced here the very rule
                # `part_identity` exists to repudiate.
                key = (canon(fp.manufacturer or ""), fp.mpn.upper())
                if key in seen:
                    continue
                seen.add(key)
                event = strategy.absorb(db, supplier, unit, fp, counts)
                if event is not None:
                    yield event
            raw_rows = provider.last_raw_count
            _cursor_set(
                cursor,
                unit.cursor_key,
                strategy.next_cursor(provider, unit, start_at, raw_rows, want),
            )
            # Batched — see CURSOR_FLUSH_EVERY. `cursor_dirty` is closed over
            # so the count spans passes, not just this batch.
            cursor_dirty[0] += 1
            if cursor_dirty[0] >= CURSOR_FLUSH_EVERY:
                _save_import_cursor(db, supplier_pk, cursor)
                cursor_dirty[0] = 0

    started_detail = strategy.started_detail(pending, call_budget, continuous)
    if wrapped:
        started_detail += " · catalog fully swept — restarting from the top"

    yield sync_event("sync_started", supplier_id, supplier_name, started_detail)
    try:
        while pending:
            sweeps += 1
            spent_before = provider.calls_made
            yield from _sweep(pending)
            if not continuous:
                break
            if provider.calls_made >= call_budget:
                # The runaway ceiling (or, for a caller that passes its own
                # number, that number). The provider's quota normally walls
                # first, as a FeedFatalError.
                break
            if provider.calls_made <= spent_before:
                # A pass that spent nothing cannot have advanced a cursor
                # either — every cursor write happens after a search. Sweeping
                # the same list again would loop forever.
                break
            # Re-derived every pass ON PURPOSE: the ranking moves as parts land
            # and offers appear, a unit that just answered short must drop out,
            # and a unit that answered TOO WIDE must be replaced by its
            # children. One aggregate query against a provider that charges
            # ~0.55-2.1 s a call.
            pending = [
                unit
                for unit in strategy.units(db, provider, supplier_pk, cursor, call_budget)
                if _cursor_get(cursor, unit.cursor_key) != IMPORT_CURSOR_EXHAUSTED
            ]
    except FeedFatalError as exc:
        # str(exc) carries no API key — mouser.py never puts one in a message.
        # On a continuous run this IS the expected ending: the quota wall.
        db.rollback()
        yield sync_event("sync_error", supplier_id, "Feed unavailable", str(exc))
        yield _finished()
        return
    finally:
        # EVERY exit flushes: clean finish, quota wall, pause, or the generator
        # being closed when the client disconnects. Batching that only flushed
        # mid-loop would silently discard up to CURSOR_FLUSH_EVERY pages of
        # depth on a NORMAL ending, which is worse than the slowdown it fixes.
        # After the rollback above the session is clean, and
        # `_save_import_cursor` re-queries and commits on its own.
        _flush_cursor()
    yield _finished()


def backfill_images(
    db: Session,
    provider: PartFeedProvider,
    limit: int = 200,
    offset: int = 0,
) -> dict:
    """Fill image_url (and, independently, missing datasheet_url) by MPN.

    Commits PER ROW: one provider error mid-batch must not discard work the
    quota already paid for. `offset` is the resume cursor — parts the
    provider cannot resolve stay NULL, so consecutive runs use
    --offset to scan past the un-fillable head of the list."""
    parts = (
        db.query(Part)
        .filter(Part.image_url.is_(None))
        .order_by(Part.sku)
        .offset(offset)
        .limit(limit)
        .all()
    )
    filled = missed = 0
    for part in parts:
        fp = provider.lookup_mpn(part.sku)
        changed = False
        image = _safe_image(fp.image_url) if fp else None
        if image:
            part.image_url = image
            changed = True
            filled += 1
        else:
            missed += 1
        # datasheet fills on its own merits — an imageless part with a real
        # datasheet used to be refetched forever (review-caught).
        if (
            fp is not None
            and not part.datasheet_url
            and fp.datasheet_url
            and len(fp.datasheet_url) <= 500
        ):
            part.datasheet_url = fp.datasheet_url
            changed = True
        if changed:
            db.commit()
    db.commit()
    return {"scanned": len(parts), "filled": filled, "missed": missed}


def fill_all_empty(
    db: Session,
    provider: PartFeedProvider,
    per_category: int = 25,
    max_categories: int | None = None,
) -> list[dict]:
    """Walk every EMPTY subcategory and fill it from the provider.

    The employee-grade entry point: one command populates the whole
    expansion. One category failing (rate limit, odd keyword) records an
    error row and moves on — it never kills the run.
    """
    children = (
        db.query(Category).filter(Category.parent_id.isnot(None)).order_by(Category.name).all()
    )
    results: list[dict] = []
    processed = 0
    for cat in children:
        has_parts = db.query(Part.id).filter(Part.category_id == cat.id).first() is not None
        if has_parts:
            continue
        try:
            results.append(fill_category(db, provider, cat.slug, count=per_category))
        except FeedFatalError as exc:
            # Auth/quota failure hits EVERY remaining category identically —
            # continuing would burn one wasted request per subcategory
            # (review-caught). Record and abort.
            db.rollback()
            results.append({"category": cat.slug, "error": str(exc), "aborted": True})
            break
        except Exception as exc:  # noqa: BLE001 — a batch job must survive one bad category
            db.rollback()
            results.append({"category": cat.slug, "error": str(exc)})
        processed += 1
        if max_categories is not None and processed >= max_categories:
            break
    return results


def fill_category(
    db: Session,
    provider: PartFeedProvider,
    category_slug: str,
    keyword: str | None = None,
    count: int = 50,
) -> dict:
    """Populate a SUBCATEGORY with real parts+listings from the provider."""
    cat = db.query(Category).filter(Category.slug == category_slug).first()
    if cat is None:
        raise ValueError(f"no category with slug {category_slug!r}")
    if cat.parent_id is None:
        raise ValueError(
            f"{category_slug!r} is a top-level category — parts attach to "
            "subcategories (pass a child slug)"
        )
    supplier = _get_or_create_supplier(db, provider)
    created = updated = skipped = 0
    seen_mpns: set[tuple[str, str]] = set()
    for fp in provider.search(keyword or _search_keyword(cat), count):
        # Keyed on (manufacturer, MPN) — the same pair part identity uses. On
        # MPN alone, one page carrying 1N4148 from two makers silently dropped
        # the second, which is a different product.
        key = (canon(fp.manufacturer or ""), fp.mpn.upper())
        if key in seen_mpns:
            skipped += 1
            continue
        seen_mpns.add(key)
        try:
            part, was_created = get_or_create_part(
                db,
                sku=fp.mpn,
                manufacturer_name=fp.manufacturer,
                # Bound as a default for the same reason as the sweep above.
                build=lambda mid, fp=fp: _new_part(fp, cat.id, cat.slug, manufacturer_id=mid),
            )
        except ValueError:
            logger.info("feed row for %r has no identifiable manufacturer — skipped", fp.mpn)
            skipped += 1
            continue
        db.flush()
        if was_created:
            created += 1
        elif part.category_id == cat.id:
            updated += 1
        else:
            # The MPN already lives in ANOTHER category — never hijack it
            # into this one (and never count it as this category's fill).
            skipped += 1
            continue
        _fill_part_media(part, fp)
        _upsert_listing(db, part, supplier, fp)
    db.commit()
    return {
        "category": category_slug,
        "created": created,
        "updated": updated,
        "skipped": skipped,
    }


# ── Server-owned feed runs: the work must outlive the socket ────────────────
#
# The generators above USED to be driven by the HTTP response body itself: the
# route returned `StreamingResponse(stream())` and `stream()` iterated
# `grow_catalog`, so Starlette advanced the import one `__next__()` per chunk
# the client read. That made the socket the engine. When the transport died —
# the operator switching tabs on a phone that then froze the page, a proxy
# read-timeout, a laptop sleeping — Starlette stopped pulling, the generator
# was closed, and the import ENDED SILENTLY mid-run (uvicorn logged a plain
# `200 OK`). Nothing recorded that a run had been intended, so nothing could
# finish it and nothing could resume it; the run existed only as that socket.
#
# So the click now starts a RUN and the response only OBSERVES it. The work
# lives on a daemon thread with its OWN session (the request's session is
# closed at request teardown by `get_db`, exactly as `jobs/feed_import_daily`
# already had to solve) and its own provider, which it closes when the WORK
# ends rather than when a reader leaves. `app.jobs.feed_import_daily` is the
# proof this was always transport-independent: it runs the same `grow_catalog`
# generator to completion with no socket at all.
#
# Scope, stated plainly: the registry is IN-PROCESS. That is sound on today's
# single uvicorn worker; with more than one, a reattach can land on a worker
# that never held the run and must fall back to `activity_events`. A container
# restart still truncates a run — but every part is committed before its event
# is yielded and the per-category `import_cursor` is persisted as it goes, so
# the progress is durable and the next run resumes rather than repeats.

# How long a FINISHED run stays readable, so an operator who lost the socket
# can still come back and read the summary. Small and time-bounded: these are
# event lists held in memory.
_RUN_RETENTION_SECONDS = 900.0
# Hard cap on retained (finished) runs, independent of the TTL — a burst of
# short runs across many suppliers must not grow the map without bound.
_MAX_RETAINED_RUNS = 32

# Pushed to every subscriber when the work ends. An object() rather than None,
# because None is the heartbeat tick a reader may legitimately see.
_END = object()

_RUNS: dict[str, "FeedRun"] = {}
_RUNS_LOCK = threading.Lock()


class FeedRunActive(RuntimeError):
    """A run is already going for this supplier.

    Two concurrent runs would spend the same rate-limited daily quota twice
    and interleave writes to the same rows, so the second click is refused
    rather than queued — the caller can attach to the run already going.
    """


class FeedRunElsewhere(RuntimeError):
    """Another PROCESS holds this supplier's feed lock.

    Distinct from :class:`FeedRunActive`, which is the in-process registry
    refusing a second click synchronously. This one is only discoverable once
    the worker thread tries to claim the cross-process lock — by which time the
    route has answered — so it surfaces as a terminal event on the stream
    rather than as a status code.
    """


class FeedRun:
    """One server-owned feed run: the work, and everyone watching it.

    `events` is append-only and complete, which is what makes re-attaching
    possible: a reader that arrives late (or comes back after its socket died)
    replays everything so far and then follows live, and the two halves are
    handed over under one lock so no event is duplicated or dropped in the
    switch.
    """

    def __init__(self, supplier_pk: uuid.UUID, supplier_name: str, mode: str):
        self.run_id = str(uuid.uuid4())
        self.supplier_pk = supplier_pk
        # The string form the wire events carry, read once off the ORM row in
        # the REQUEST thread — the row itself belongs to a session the worker
        # must never touch.
        self.supplier_id = str(supplier_pk)
        self.supplier_name = supplier_name
        self.mode = mode
        self.started_at = time.time()
        self.finished_at: float | None = None
        self.events: list[dict] = []
        self._subscribers: list[queue.Queue] = []
        self._lock = threading.Lock()
        # The pause door (2026-08-21): clicking the button again while a run
        # is going requests a wind-down. The worker checks this BETWEEN parts
        # — the part in hand always finishes and commits, so nothing is lost
        # and (for imports) the cursor lets the next click resume.
        self._stop = threading.Event()

    @property
    def running(self) -> bool:
        return self.finished_at is None

    @property
    def stop_requested(self) -> bool:
        return self._stop.is_set()

    def request_stop(self) -> None:
        self._stop.set()

    # -- producer side (the worker thread) --

    def _publish(self, event: dict) -> None:
        with self._lock:
            self.events.append(event)
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(event)

    def _finish(self) -> None:
        with self._lock:
            self.finished_at = time.time()
            subscribers = list(self._subscribers)
            self._subscribers.clear()
        for q in subscribers:
            q.put(_END)

    # -- consumer side (any number of HTTP observers) --

    def _attach(self) -> tuple[list[dict], queue.Queue | None]:
        """Snapshot the backlog and register for the live tail, atomically.

        The atomicity is the whole point: taking the backlog and subscribing as
        two steps would either miss the events published between them or
        deliver them twice. A finished run gets no queue — its backlog IS the
        whole run.
        """
        with self._lock:
            backlog = list(self.events)
            if self.finished_at is not None:
                return backlog, None
            q: queue.Queue = queue.Queue()
            self._subscribers.append(q)
            return backlog, q

    def _detach(self, q: queue.Queue | None) -> None:
        if q is None:
            return
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def observe(self, heartbeat_seconds: float | None = None) -> Iterator[dict | None]:
        """Replay this run so far, then follow it live until it ends.

        Yields `None` as a HEARTBEAT tick whenever `heartbeat_seconds` passes
        with nothing published — an import sweeping already-known MPNs yields
        no event for minutes while still spending 2.1 s per provider call, and
        nginx cuts an idle proxied response at 60 s by default. The caller
        decides what a tick looks like on the wire.

        Leaving this generator only detaches the reader. It never stops the
        run — that is the entire point of the split.
        """
        backlog, q = self._attach()
        try:
            yield from backlog
            if q is None:
                return
            while True:
                if heartbeat_seconds is None:
                    item = q.get()
                else:
                    try:
                        item = q.get(timeout=heartbeat_seconds)
                    except queue.Empty:
                        yield None
                        continue
                if item is _END:
                    return
                yield item
        finally:
            self._detach(q)


# The work a run drives: given a session, a provider and the supplier row read
# through THAT session, yield wire events. A callable rather than a bound
# generator because the worker owns the session — a thunk closing over the
# request's session is exactly the coupling this replaces.
FeedWork = Callable[[Session, PartFeedProvider, Supplier], Iterator[dict]]


def _tally(counts: dict[str, int], event: dict) -> None:
    """Mirror `_finished`'s arithmetic as the events go past.

    The generator owns the authoritative totals, and this MIRRORS them for one
    reason: when the generator raises, its totals die with it and the abort
    path still has to report what the run did. Every part is committed before
    its event is yielded, so everything counted here survived the rollback.
    """
    if event.get("kind") != "part_synced":
        return
    action = event.get("action")
    # media_filled counts in BOTH — filling an image IS a write.
    if action == "media_filled":
        counts["synced"] += 1
        counts["media_filled"] += 1
    elif action == "updated":
        counts["synced"] += 1
    elif action == "listing_added":
        # NOT `synced`: import never refreshes, so this is a new offer.
        counts["listing_added"] += 1
    elif action == "created":
        # a NEW part, not a refreshed one — counted apart from `synced`
        # exactly as the generator counts it
        counts["created"] += 1
    elif action == "not_found":
        counts["not_found"] += 1
    elif action == "no_data":
        counts["no_data"] += 1


def _feed_run_worker(
    run: FeedRun,
    provider: PartFeedProvider,
    work: FeedWork,
    session_factory: Callable[[], Session],
) -> None:
    """Drive one run to completion. Never raises — it IS the top of a thread.

    The terminal events are produced by the WORK, not by a socket: a run that
    blows up ends with `sync_error` + `sync_finished` carrying its real tally
    whether or not anybody is reading, so the summary is in `activity_events`
    and in the replay buffer either way.
    """
    is_import = run.mode == "import"
    stored_kinds = IMPORT_EVENT_KINDS if is_import else None
    abort_title = "Import failed" if is_import else "Sync failed"
    abort_detail = "import aborted" if is_import else "sync aborted"
    # Five keys, always — the same set `_finished` reports, so a console never
    # has to tell a missing counter from a zero one.
    counts = {
        "synced": 0,
        "media_filled": 0,
        "not_found": 0,
        "no_data": 0,
        "created": 0,
        "listing_added": 0,
    }
    db = session_factory()
    try:
        try:
            supplier = db.query(Supplier).filter(Supplier.id == run.supplier_pk).first()
            if supplier is None:
                # Deleted between the click and the thread starting.
                raise RuntimeError("supplier no longer exists")
            paused = False
            # `_RUNS` only arbitrates between callers inside THIS process. The
            # nightly `feed-import` container calls grow_catalog directly and
            # cannot see it, so the cross-process claim is made here — held for
            # the run's life on its own connection, released if this container
            # dies. Taken inside the thread on purpose: the route has already
            # answered by now, and an honest terminal event beats a lock the
            # caller's thread would have to hand across a boundary.
            with supplier_feed_lock(db.get_bind(), run.supplier_pk) as claimed:
                if not claimed:
                    raise FeedRunElsewhere(
                        "another process is already importing this supplier "
                        "(most likely the nightly sweep) — try again later"
                    )
                for event in work(db, provider, supplier):
                    _tally(counts, event)
                    record_stream_event(db, run.supplier_pk, event, stored_kinds)
                    run._publish(event)
                    if run.stop_requested and event.get("kind") != "sync_finished":
                        # Abandoning the generator here runs its finallys
                        # (GeneratorExit); the ending event is OURS to emit —
                        # the work's own sync_finished never yields.
                        paused = True
                        break
            if paused:
                stopped = sync_event(
                    "sync_finished",
                    run.supplier_id,
                    run.supplier_name,
                    ("import" if is_import else "sync") + " paused — click again to resume",
                )
                stopped["counts"] = dict(counts)
                record_stream_event(db, run.supplier_pk, stopped, stored_kinds)
                run._publish(stopped)
        except FeedRunElsewhere as exc:
            # NOT a failure, and it must not be filed as one. Falling through
            # to the generic handler below stamped this as "Import failed" /
            # "import aborted" with zero counts — a red run in the operator's
            # console and in activity_events describing a system that is
            # working exactly as designed (the nightly sweep has the supplier).
            # No sync_error: nothing errored.
            stood_down = sync_event("sync_finished", run.supplier_id, run.supplier_name, str(exc))
            stood_down["counts"] = dict(counts)
            record_stream_event(db, run.supplier_pk, stood_down, stored_kinds)
            run._publish(stood_down)
        except Exception as exc:  # noqa: BLE001
            # FeedFatalError (auth/quota) is already handled inside the
            # generators; this is for everything else. Report it as events
            # rather than a traceback into the void: a half-written run with
            # no ending is what the operator used to be left with.
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                logger.warning("[feed-run] rollback failed after %s", exc, exc_info=True)
            failed = sync_event("sync_error", run.supplier_id, abort_title, str(exc))
            record_stream_event(db, run.supplier_pk, failed, stored_kinds)
            run._publish(failed)
            # Real totals, not zeros: the parts already reported were each
            # committed before they were reported. The detail still says it
            # did not finish, named for the run the operator actually started.
            aborted = sync_event("sync_finished", run.supplier_id, run.supplier_name, abort_detail)
            aborted["counts"] = dict(counts)
            record_stream_event(db, run.supplier_pk, aborted, stored_kinds)
            run._publish(aborted)
    finally:
        # One provider (and its HTTP connection pool) per run, released when
        # the WORK ends — never when a reader leaves.
        close = getattr(provider, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                logger.warning("[feed-run] provider close failed", exc_info=True)
        # A run just rewrote the catalog: drop the search TTL caches so the
        # manufacturers list, the did-you-mean vocabulary and the backfill
        # pool reflect what it imported. ONCE PER RUN, here at the end —
        # never per part, which would clear the cache thousands of times and
        # make every intervening search re-derive from scratch.
        invalidate_catalog_caches()
        try:
            db.close()
        finally:
            # Last, always: observers block until this lands, so anything that
            # must be finished before they return has already happened.
            run._finish()


def _purge_locked(now: float) -> None:
    """Drop finished runs the retention window is done with. Caller holds the lock."""
    stale = [
        key
        for key, run in _RUNS.items()
        if run.finished_at is not None and now - run.finished_at > _RUN_RETENTION_SECONDS
    ]
    for key in stale:
        del _RUNS[key]
    finished = [(run.finished_at or 0.0, key) for key, run in _RUNS.items() if not run.running]
    overflow = len(finished) - _MAX_RETAINED_RUNS
    if overflow > 0:
        for _, key in sorted(finished)[:overflow]:
            del _RUNS[key]


def start_feed_run(
    *,
    supplier: Supplier,
    mode: str,
    provider: PartFeedProvider,
    work: FeedWork,
    session_factory: Callable[[], Session] | None = None,
) -> FeedRun:
    """Start a server-owned run for `supplier` and return it, already going.

    `supplier` is read HERE, in the caller's thread — the worker re-queries the
    row through its own session, because an ORM instance may not cross into
    another session's thread.

    Raises :class:`FeedRunActive` if this supplier already has a run going.
    """
    factory = session_factory or SessionLocal
    key = str(supplier.id)
    run = FeedRun(supplier.id, supplier.name, mode)
    with _RUNS_LOCK:
        _purge_locked(time.time())
        existing = _RUNS.get(key)
        if existing is not None and existing.running:
            raise FeedRunActive(key)
        _RUNS[key] = run
    threading.Thread(
        target=_feed_run_worker,
        args=(run, provider, work, factory),
        name=f"feed-run-{mode}-{key[:8]}",
        daemon=True,
    ).start()
    return run


def request_feed_stop(supplier_pk) -> str | None:
    """Ask the ACTIVE run for this supplier to wind down. Returns its run_id,
    or None when nothing is running (finished runs cannot be paused)."""
    key = str(supplier_pk)
    with _RUNS_LOCK:
        run = _RUNS.get(key)
        if run is None or not run.running:
            return None
        run.request_stop()
        return run.run_id


def get_feed_run(supplier_id: uuid.UUID | str) -> FeedRun | None:
    """The run for this supplier — going, or finished inside the retention
    window. `None` once there is nothing left to show."""
    with _RUNS_LOCK:
        _purge_locked(time.time())
        return _RUNS.get(str(supplier_id))


def reset_feed_runs() -> None:
    """Forget every run. For tests — the registry is module state, and a run
    left behind by one test would refuse the next test's click."""
    with _RUNS_LOCK:
        _RUNS.clear()
