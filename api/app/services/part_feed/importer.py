"""Turns FeedParts into catalog rows: Part + PartListing + PriceBreaks.

Idempotent by construction: parts keyed by MPN, listings keyed by
(part, supplier), price breaks replaced wholesale per sync. Never overwrites
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
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models import Category, Part, PartListing, PriceBreak, Supplier, SupplierFeed
from app.services.activity import IMPORT_EVENT_KINDS, record_stream_event
from app.services.part_feed.base import FeedPart, PartFeedProvider
from app.services.part_feed.mouser import FeedFatalError
from app.services.part_feed.specmap import map_lifecycle
from app.utils.image_url import validate_optional_image_url

logger = logging.getLogger(__name__)


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


def _new_part(fp: FeedPart, category_id: uuid.UUID | None, sub_slug: str | None) -> Part:
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
        if part.lifecycle_status != mapped:
            part.lifecycle_status = mapped
        part.lifecycle_verified_at = datetime.now(UTC)
        changed = True
    # Spec fields (migration 039) — `is not None`, NEVER truthiness: rohs=False
    # is a value and must be stored; feed absence (None) leaves values alone.
    if fp.mount is not None and part.mount != fp.mount:
        part.mount = fp.mount
        changed = True
    if fp.rohs is not None and part.rohs != fp.rohs:
        part.rohs = fp.rohs
        changed = True
    if fp.lead_time_days is not None and part.lead_time_days != fp.lead_time_days:
        part.lead_time_days = fp.lead_time_days
        changed = True
    return changed


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


def _upsert_listing(db: Session, part: Part, supplier: Supplier, fp: FeedPart) -> bool:
    """Create/refresh this supplier's listing for `part`. Returns True if it
    wrote anything — False means the feed row carried no price, so there was
    nothing worth storing (callers report that honestly instead of claiming an
    update)."""
    if not fp.price_breaks:
        return False  # a listing without a price is not a comparison row
    lowest_qty_break = min(fp.price_breaks, key=lambda b: b.min_quantity)
    listing = (
        db.query(PartListing)
        .filter(PartListing.part_id == part.id, PartListing.supplier_id == supplier.id)
        .first()
    )
    if listing is None:
        listing = PartListing(
            id=uuid.uuid4(),
            part_id=part.id,
            supplier_id=supplier.id,
            unit_price=Decimal(str(lowest_qty_break.unit_price)),
        )
        db.add(listing)
        # Sessions run autoflush=False — without this flush the NEXT
        # existence query in the same run cannot see this row, and a
        # repeated MPN mints a duplicate (part, supplier) listing
        # (review-caught, reproduced).
        db.flush()
    listing.sku = fp.supplier_sku or listing.sku
    listing.stock_quantity = fp.stock_quantity
    listing.lead_time_days = fp.lead_time_days
    listing.unit_price = Decimal(str(lowest_qty_break.unit_price))
    listing.currency = fp.currency
    db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).delete()
    for pb in fp.price_breaks:
        db.add(
            PriceBreak(
                id=uuid.uuid4(),
                listing_id=listing.id,
                min_quantity=pb.min_quantity,
                unit_price=Decimal(str(pb.unit_price)),
            )
        )
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
    part = db.query(Part).filter(Part.sku == fp.mpn).first()
    if part is None:
        part = _new_part(fp, None, None)
        db.add(part)
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
        # EXISTS, not a JOIN: nothing stops a (part, supplier) pair from
        # holding two listing rows, and a join would then spend the `limit`
        # budget twice on the same part.
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
"""`import_cursor` value meaning "this category has no more rows to read"."""


def _load_import_cursor(db: Session, supplier_id) -> dict[str, int]:
    """This supplier's sweep depth per category: {category_slug: next start_at}.

    No row, or no stored value, is a FRESH catalog — which is exactly what the
    first import of every supplier sees, so run 1 behaves as it always did.
    """
    row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier_id).first()
    if row is None or not row.import_cursor:
        return {}
    return dict(row.import_cursor)


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


def grow_catalog(
    db: Session,
    provider: PartFeedProvider,
    supplier: Supplier,
    call_budget: int,
    per_category: int = 50,
    continuous: bool = False,
) -> Iterator[dict]:
    """Import NEW inventory, thinnest subcategory first, for at most
    `call_budget` provider calls.

    The mirror image of `sync_supplier_listings` economics: a sync spends one
    call per part it already has, an import spends one call per PAGE of parts
    it does not.

    Shares the sync's rails: listings attach to the PASSED supplier row (a
    name-matched twin would split the catalog), work COMMITS PER PART before
    its event is yielded, and a FeedFatalError ends the stream with an error
    plus the counts so far instead of raising out of the generator.

    An MPN that already lives in ANOTHER category is never hijacked into this
    one, and yields NO event — a stream of skips a human cannot act on is
    noise; the finish line carries the tally.

    DEPTH is what keeps repeat runs useful. `supplier_feeds.import_cursor`
    remembers how far into each category's search results this supplier has
    already read, so every run asks the provider for the NEXT page rather than
    re-reading page one (the owner-reported plateau: after the first sweep,
    Import found nothing new). A category that answers with fewer raw rows than
    it asked for is EXHAUSTED and stops consuming budget; when every category
    is exhausted the map is cleared and the sweep starts from the top again —
    a nightly run then re-verifies the catalog and picks up whatever the
    distributor has listed since. The cursor is persisted PER CATEGORY, on its
    own commit, so a quota wall mid-run keeps the depth the finished categories
    already paid for.

    ONE PASS OR MANY — that is what `continuous` decides, and it is the whole
    difference between the two callers:

    * `continuous=False` (the default, and what `jobs/feed_import_daily`
      always uses) makes ONE pass down the pending categories and returns even
      with budget left over. The bound is then the CATEGORY LIST, which is
      correct for an unattended nightly run: the night's
      `FEED_IMPORT_CALL_BUDGET` is split evenly across every enabled supplier,
      and letting the first supplier run until the well is dry would starve
      the rest of them and the operator's next-day clicks.
    * `continuous=True` (the interactive Import click on a supplier whose
      Auto-import switch is ON) re-derives the pending list and sweeps AGAIN,
      batch after batch. One pass only ever reads ONE page per category, so
      depth used to advance one page per click; continuous keeps going until
      the feed is exhausted or its quota is reached.

    A continuous run ends on exactly three things: a FeedFatalError (the quota
    wall — caught below, so the run ends cleanly with `sync_error` plus the
    counts so far), an empty pending list (every category answered short, i.e.
    the catalog is exhausted), or `CONTINUOUS_CALL_CEILING`. It deliberately
    does NOT wrap and restart mid-run: `wrapped` is evaluated ONCE at run
    start, so a fully-swept catalog restarts on the NEXT click or night. A
    mid-run wrap against a healthy provider is an infinite re-read.

    The run reports ONE `sync_started` and ONE `sync_finished` however many
    passes it makes — the wire shape and the five-key `counts` set are the same
    for both modes, so nothing downstream has to know which one ran.
    """
    supplier_id = str(supplier.id)
    supplier_name = supplier.name
    # The PK itself, read once: every per-part commit expires `supplier`, and
    # the cursor writes need the UUID rather than the event string.
    supplier_pk = supplier.id
    created = synced = media_filled = no_data = skipped_elsewhere = 0
    # An import never looks a known MPN up, so nothing can be "not found" —
    # the key stays because every run reports the same five counters.
    not_found = 0
    sweeps = 0

    def _finished() -> dict:
        detail = (
            f"{created} created · {synced} updated · "
            f"{skipped_elsewhere} already elsewhere · {provider.calls_made} calls used"
        )
        if continuous:
            detail += f" · {sweeps} sweeps"
        event = sync_event("sync_finished", supplier_id, supplier_name, detail)
        event["counts"] = {
            "synced": synced,
            "media_filled": media_filled,
            "not_found": not_found,
            "no_data": no_data,
            "created": created,
        }
        return event

    categories = _thinnest_subcategories(db)
    cursor = _load_import_cursor(db, supplier_pk)
    wrapped = bool(categories) and all(
        cursor.get(cat.slug) == IMPORT_CURSOR_EXHAUSTED for cat in categories
    )
    if wrapped:
        # Every shelf has answered "no more rows". Sweeping them again is the
        # useful thing to do — it re-verifies what is listed and catches parts
        # the distributor added since — so clear the map rather than idling
        # forever. The cleared state persists with the first category's write,
        # which stores the whole map. Evaluated HERE and nowhere else: a
        # continuous run that re-wrapped between passes would never stop.
        cursor = {}
    pending = [cat for cat in categories if cursor.get(cat.slug) != IMPORT_CURSOR_EXHAUSTED]

    def _sweep(batch: list[Category]) -> Iterator[dict]:
        """ONE pass down `batch`, thinnest first. The unit `continuous` repeats.

        Closes over the run's counters and `cursor` rather than returning them:
        the totals belong to the RUN, not to a pass, and the cursor a pass
        advances is what the next pass reads to ask for the next page.
        """
        nonlocal created, synced, media_filled, no_data, skipped_elsewhere
        for cat in batch:
            remaining_calls = call_budget - provider.calls_made
            if remaining_calls <= 0:
                break
            # `search` paginates INSIDE the provider, so the size asked for is
            # the only place the budget can bound pages: N records cost
            # ceil(N / records_per_call) calls.
            want = min(per_category, remaining_calls * provider.records_per_call)
            # Read the category's own fields ONCE: every per-part commit
            # expires the instance, so touching `cat` inside the page loop
            # would re-SELECT it for each row.
            cat_id, cat_slug = cat.id, cat.slug
            cat_name, keyword = cat.name, _search_keyword(cat)
            start_at = cursor.get(cat_slug, 0)
            seen: set[str] = set()
            for fp in provider.search(keyword, want, start_at=start_at):
                key = fp.mpn.upper()
                if key in seen:
                    # One page can carry the same MPN twice (generic numbers
                    # like 1N4148 ship from several manufacturers) — a feed
                    # artifact, not something this run did to the catalog.
                    continue
                seen.add(key)
                part = db.query(Part).filter(Part.sku == fp.mpn).first()
                if part is not None and part.category_id != cat_id:
                    skipped_elsewhere += 1
                    continue
                is_new = part is None
                if is_new:
                    part = _new_part(fp, cat_id, cat_slug)
                    db.add(part)
                    # autoflush=False — the listing needs a real part.id, and
                    # the next existence query has to see this row.
                    db.flush()
                wrote_listing = _upsert_listing(db, part, supplier, fp)
                media = _fill_part_media(part, fp)
                # Facts are a real write, but not a MEDIA one — fold them into
                # the "updated" bucket (see the same wiring in the sync path).
                wrote_listing = _stamp_feed_facts(part, fp) or wrote_listing
                image_url = part.image_url
                db.commit()
                if is_new:
                    # A new catalog row IS the win, priced or not: the part
                    # page exists now and the next run can price it.
                    created += 1
                    action = "created"
                elif media:
                    # media IS a real write, priced feed row or not
                    synced += 1
                    media_filled += 1
                    action = "media_filled"
                elif wrote_listing:
                    synced += 1
                    action = "updated"
                else:
                    # found, but nothing changed — counting it as updated
                    # would overstate what the run did
                    no_data += 1
                    action = "no_data"
                yield sync_event(
                    "part_synced",
                    supplier_id,
                    f"{fp.mpn} — {fp.manufacturer}",
                    cat_name,
                    image_url,
                    action,
                )
            # Advance by the RAW rows the provider consumed, not by the parts
            # kept: rows that failed to decode still took their place in the
            # result set, and advancing by the survivors would re-fetch the
            # junk every run. Short of what was asked for = the shelf ran out.
            raw_rows = provider.last_raw_count
            cursor[cat_slug] = IMPORT_CURSOR_EXHAUSTED if raw_rows < want else start_at + raw_rows
            _save_import_cursor(db, supplier_pk, cursor)

    if continuous:
        started_detail = (
            "growing catalog · continuous — sweeping until the feed is "
            "exhausted or its quota is reached"
        )
    else:
        started_detail = (
            f"growing catalog · budget {call_budget} calls · {len(pending)} categories to sweep"
        )
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
            # Re-derived every pass ON PURPOSE: the thin-first ranking moves as
            # parts land, and a category that just answered short must drop
            # out. One GROUP BY against a provider that charges ~2.1 s a call.
            pending = [
                cat
                for cat in _thinnest_subcategories(db)
                if cursor.get(cat.slug) != IMPORT_CURSOR_EXHAUSTED
            ]
    except FeedFatalError as exc:
        # str(exc) carries no API key — mouser.py never puts one in a message.
        # On a continuous run this IS the expected ending: the quota wall.
        db.rollback()
        yield sync_event("sync_error", supplier_id, "Feed unavailable", str(exc))
        yield _finished()
        return
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
    seen_mpns: set[str] = set()
    for fp in provider.search(keyword or _search_keyword(cat), count):
        # Search pages can repeat an MPN (generic numbers like 1N4148 exist
        # from several manufacturers as separate distributor rows) — first
        # (highest-ranked) row wins, repeats are skipped.
        key = fp.mpn.upper()
        if key in seen_mpns:
            skipped += 1
            continue
        seen_mpns.add(key)
        part = db.query(Part).filter(Part.sku == fp.mpn).first()
        if part is None:
            part = _new_part(fp, cat.id, cat.slug)
            db.add(part)
            db.flush()
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
    counts = {"synced": 0, "media_filled": 0, "not_found": 0, "no_data": 0, "created": 0}
    db = session_factory()
    try:
        try:
            supplier = db.query(Supplier).filter(Supplier.id == run.supplier_pk).first()
            if supplier is None:
                # Deleted between the click and the thread starting.
                raise RuntimeError("supplier no longer exists")
            paused = False
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
