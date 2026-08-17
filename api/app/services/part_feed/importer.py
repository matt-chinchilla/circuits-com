"""Turns FeedParts into catalog rows: Part + PartListing + PriceBreaks.

Idempotent by construction: parts keyed by MPN, listings keyed by
(part, supplier), price breaks replaced wholesale per sync. Never overwrites
a value a human/API already set with something emptier — image/datasheet fill
only when missing, stock/lead/prices refresh on every run.
"""

import re
import uuid
from collections.abc import Iterator
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models import Category, Part, PartListing, PriceBreak, Supplier
from app.services.part_feed.base import FeedPart, PartFeedProvider
from app.services.part_feed.mouser import FeedFatalError
from app.utils.image_url import validate_optional_image_url


def _slugify_sku(sku: str) -> str:
    # Same derivation as routes/parts.slugify_sku — duplicated (4 lines)
    # rather than importing a route module from a service.
    slug = re.sub(r"[^a-z0-9]+", "-", sku.lower())
    return re.sub(r"-+", "-", slug).strip("-")


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


def _upsert_listing(db: Session, part: Part, supplier: Supplier, fp: FeedPart) -> None:
    if not fp.price_breaks:
        return  # a listing without a price is not a comparison row
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


def _sync_event(
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
    synced = media_filled = not_found = 0

    def _finished() -> dict:
        event = _sync_event(
            "sync_finished",
            supplier_id,
            supplier_name,
            f"{synced} synced · {media_filled} images filled · {not_found} not found",
        )
        event["counts"] = {
            "synced": synced,
            "media_filled": media_filled,
            "not_found": not_found,
        }
        return event

    yield _sync_event("sync_started", supplier_id, supplier_name, f"{len(parts)} parts queued")
    try:
        for part in parts:
            sku = part.sku
            category = category_names.get(part.category_id)
            fp = provider.lookup_mpn(sku)
            if fp is None:
                not_found += 1
                yield _sync_event("part_synced", supplier_id, sku, category, action="not_found")
                continue
            _upsert_listing(db, part, supplier, fp)
            media = _fill_part_media(part, fp)
            image_url = part.image_url
            db.commit()
            synced += 1
            if media:
                media_filled += 1
            yield _sync_event(
                "part_synced",
                supplier_id,
                f"{sku} — {fp.manufacturer}",
                category,
                image_url,
                "media_filled" if media else "updated",
            )
    except FeedFatalError as exc:
        # str(exc) carries no API key — mouser.py never puts one in a message.
        db.rollback()
        yield _sync_event("sync_error", supplier_id, "Feed unavailable", str(exc))
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
        db.query(Category)
        .filter(Category.parent_id.isnot(None))
        .order_by(Category.name)
        .all()
    )
    results: list[dict] = []
    processed = 0
    for cat in children:
        has_parts = (
            db.query(Part.id).filter(Part.category_id == cat.id).first() is not None
        )
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
    for fp in provider.search(keyword or cat.name, count):
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
            part = Part(
                id=uuid.uuid4(),
                sku=fp.mpn,
                slug=_slugify_sku(fp.mpn),
                manufacturer_name=fp.manufacturer,
                description=fp.description,
                category_id=cat.id,
                sub_slug=cat.slug,
            )
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
