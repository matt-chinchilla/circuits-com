import json
import logging
import uuid
from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import (
    ActivityEvent,
    Category,
    CategorySupplier,
    Part,
    PartListing,
    PriceBreak,
    Revenue,
    Sponsor,
    Supplier,
    User,
)
from app.services.auth_service import get_current_user

# `sync_event` is the ONE definition of the wire shape (importer.py owns it).
# The abort path below has to emit the same key set, and re-typing the dict
# here is how a stream ends up with an event the client's parser drops.
from app.services.part_feed import (
    feed_configured,
    resolve_provider,
    sync_event,
    sync_supplier_listings,
)
from app.utils.color import validate_optional_hex_color
from app.utils.image_url import validate_optional_image_url

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/suppliers", tags=["suppliers"])


def _to_uuid(val: str) -> uuid.UUID:
    """Convert string to UUID, raise 404 if invalid."""
    try:
        return uuid.UUID(val)
    except (ValueError, AttributeError):
        raise HTTPException(404, "Not found")


class SupplierCreate(BaseModel):
    name: str
    phone: str | None = None
    website: str | None = None
    email: str | None = None
    contact_name: str | None = None
    # Board fields (migration 014) — the rep's job title + coverage hours render
    # under the Contact/Phone divisions of the sponsor boards.
    contact_role: str | None = None
    coverage_hours: str | None = None
    description: str | None = None
    logo_url: str | None = None
    brand_primary: str | None = None
    brand_secondary: str | None = None

    @field_validator("logo_url")
    @classmethod
    def _validate_logo_url(cls, v: str | None) -> str | None:
        return validate_optional_image_url(v)

    @field_validator("brand_primary", "brand_secondary")
    @classmethod
    def _validate_brand_colors(cls, value: str | None) -> str | None:
        return validate_optional_hex_color(value)


class SupplierUpdate(BaseModel):
    name: str | None = None
    phone: str | None = None
    website: str | None = None
    email: str | None = None
    contact_name: str | None = None
    contact_role: str | None = None
    coverage_hours: str | None = None
    description: str | None = None
    logo_url: str | None = None
    brand_primary: str | None = None
    brand_secondary: str | None = None

    @field_validator("logo_url")
    @classmethod
    def _validate_logo_url(cls, v: str | None) -> str | None:
        return validate_optional_image_url(v)

    @field_validator("brand_primary", "brand_secondary")
    @classmethod
    def _validate_brand_colors(cls, value: str | None) -> str | None:
        return validate_optional_hex_color(value)


def supplier_to_dict(supplier: Supplier) -> dict:
    return {
        "id": str(supplier.id),
        "name": supplier.name,
        "phone": supplier.phone,
        "website": supplier.website,
        "email": supplier.email,
        "contact_name": supplier.contact_name,
        "contact_role": supplier.contact_role,
        "coverage_hours": supplier.coverage_hours,
        "description": supplier.description,
        "logo_url": supplier.logo_url,
        "brand_primary": supplier.brand_primary,
        "brand_secondary": supplier.brand_secondary,
    }


@router.get("/")
def list_suppliers(db: Session = Depends(get_db)):
    suppliers = db.query(Supplier).order_by(Supplier.name).all()

    parts_counts: dict = {
        row[0]: row[1]
        for row in db.query(PartListing.supplier_id, func.count(PartListing.id))
        .group_by(PartListing.supplier_id)
        .all()
    }

    categories_by_supplier: dict = {}
    for sup_id, cat_name in (
        db.query(CategorySupplier.supplier_id, Category.name)
        .join(Category, Category.id == CategorySupplier.category_id)
        .all()
    ):
        categories_by_supplier.setdefault(sup_id, []).append(cat_name)

    return [
        {
            **supplier_to_dict(s),
            "parts_count": int(parts_counts.get(s.id, 0)),
            "categories": categories_by_supplier.get(s.id, []),
        }
        for s in suppliers
    ]


@router.post("/")
def create_supplier(
    body: SupplierCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    supplier = Supplier(
        id=uuid.uuid4(),
        name=body.name,
        phone=body.phone,
        website=body.website,
        email=body.email,
        contact_name=body.contact_name,
        contact_role=body.contact_role,
        coverage_hours=body.coverage_hours,
        description=body.description,
        logo_url=body.logo_url,
        brand_primary=body.brand_primary,
        brand_secondary=body.brand_secondary,
    )
    db.add(supplier)
    db.commit()
    db.refresh(supplier)
    return supplier_to_dict(supplier)


@router.get("/{supplier_id}")
def get_supplier(supplier_id: str, db: Session = Depends(get_db)):
    supplier = db.query(Supplier).filter(Supplier.id == _to_uuid(supplier_id)).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")

    parts_count = (
        db.query(func.count(PartListing.id)).filter(PartListing.supplier_id == supplier.id).scalar()
        or 0
    )
    revenue_total = (
        db.query(func.sum(Revenue.amount)).filter(Revenue.supplier_id == supplier.id).scalar() or 0
    )
    category_names = (
        db.query(Category.name)
        .join(CategorySupplier, CategorySupplier.category_id == Category.id)
        .filter(CategorySupplier.supplier_id == supplier.id)
        .all()
    )

    result = supplier_to_dict(supplier)
    result["parts_count"] = parts_count
    result["revenue_total"] = float(revenue_total)
    result["categories"] = [name for (name,) in category_names]
    return result


@router.put("/{supplier_id}")
def update_supplier(
    supplier_id: str,
    body: SupplierUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    supplier = db.query(Supplier).filter(Supplier.id == _to_uuid(supplier_id)).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")

    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(supplier, key, value)

    db.commit()
    db.refresh(supplier)
    return supplier_to_dict(supplier)


@router.delete("/{supplier_id}")
def delete_supplier(
    supplier_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Cascade-delete a supplier and every dependent row.

    PartListings (and their PriceBreaks), Sponsors, CategorySupplier links,
    and Revenue rows are removed. Linked Users have `supplier_id` set to
    NULL — admin/company-user accounts must survive — and so do ActivityEvents,
    which record what actually happened and outlive the company row.
    """
    supplier = db.query(Supplier).filter(Supplier.id == _to_uuid(supplier_id)).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")

    listing_ids = [
        row[0]
        for row in db.query(PartListing.id).filter(PartListing.supplier_id == supplier.id).all()
    ]
    if listing_ids:
        db.query(PriceBreak).filter(PriceBreak.listing_id.in_(listing_ids)).delete(
            synchronize_session=False
        )
    db.query(PartListing).filter(PartListing.supplier_id == supplier.id).delete(
        synchronize_session=False
    )
    db.query(Sponsor).filter(Sponsor.supplier_id == supplier.id).delete(synchronize_session=False)
    db.query(CategorySupplier).filter(CategorySupplier.supplier_id == supplier.id).delete(
        synchronize_session=False
    )
    db.query(Revenue).filter(Revenue.supplier_id == supplier.id).delete(synchronize_session=False)
    db.query(User).filter(User.supplier_id == supplier.id).update(
        {User.supplier_id: None}, synchronize_session=False
    )
    # Activity events are history, not dependents: what the sync did stays true
    # after the company row goes away, so unlink rather than delete.
    db.query(ActivityEvent).filter(ActivityEvent.supplier_id == supplier.id).update(
        {ActivityEvent.supplier_id: None}, synchronize_session=False
    )

    # Bulk deletes bypass session sync; expire the supplier so the upcoming
    # ORM delete doesn't try to NULL composite-PK columns on stale in-memory
    # CategorySupplier rows (lazy="selectin" had loaded them).
    db.expire(supplier)
    db.delete(supplier)
    db.commit()
    return {"status": "ok"}


# ── Live inventory sync ─────────────────────────────────────────────────────

# Only an action that WROTE something becomes a row. The dashboard renders a
# part_synced event as "Synced X into Y" and ActivityEvent has no action column
# to tell the kinds apart afterwards, so a `not_found` / `no_data` row would
# read as a sync that never happened. Both still travel the live stream, where
# the operator can see exactly what the feed did and did not answer.
_RECORDED_PART_ACTIONS = frozenset({"updated", "media_filled"})


def _record_event(db: Session, supplier_id: uuid.UUID, event: dict) -> None:
    """Append one activity row for `event` — its own commit, so an abort
    (client disconnect, provider blowing up) keeps everything already reported.

    Values are clamped to their columns here rather than trusted: `title` is
    the feed's own `sku — manufacturer` string and nothing upstream bounds the
    manufacturer, and Postgres answers an over-long value with
    StringDataRightTruncation, which would kill the run mid-stream. SQLite
    accepts it silently, so the test suite alone would never catch it.
    """
    if event.get("kind") == "part_synced" and event.get("action") not in _RECORDED_PART_ACTIONS:
        return
    detail = event.get("detail")
    # ONLY the event's own image (a feed part photo, already bounded to 500 by
    # the importer's `_safe_image`). Never `supplier.logo_url` — that column is
    # Text and routinely holds a 64KB data URL from the admin's cropper.
    image_url = event.get("image_url")
    if image_url and len(image_url) > 500:
        # Unreachable through the importer; a dropped thumbnail still beats a
        # truncated (broken) URL, and beats aborting the run.
        image_url = None
    try:
        db.add(
            ActivityEvent(
                id=uuid.uuid4(),
                kind=str(event.get("kind"))[:40],
                supplier_id=supplier_id,
                title=str(event.get("title") or "")[:255],
                detail=detail[:500] if detail else None,
                image_url=image_url,
            )
        )
        db.commit()
    except Exception:  # noqa: BLE001
        # An activity row is bookkeeping. If the DB hiccups mid-run, losing
        # one row must not cut the NDJSON stream off mid-line — roll back and
        # let the stream keep reporting. It still gets logged: silently
        # dropping rows is how "the dashboard is missing runs" becomes
        # unexplainable. NEVER log the event's contents — `title`/`detail`
        # are unbounded feed strings, and the traceback is the actual signal.
        logger.warning("activity event persist failed for supplier %s", supplier_id, exc_info=True)
        db.rollback()


@router.post("/{supplier_id}/sync")
def sync_supplier(
    supplier_id: str,
    limit: int = 25,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Refresh this supplier's listings from its distributor feed, streaming
    NDJSON — one JSON object per line, flushed as each part is done.

    A sync takes minutes (the provider throttles itself under the free tier's
    ~30 calls/min), so the admin watches it happen instead of staring at a
    spinner. The route is deliberately thin: `sync_supplier_listings` owns the
    import and commits per part; this adds an activity row per event and
    serializes.

    ORDER OF REFUSAL, and it matters:

    1. No ``MOUSER_API_KEY`` → **404 sync_unavailable**. Same feature-off
       posture as the Stripe routes: an unconfigured environment has no such
       endpoint. It comes FIRST because `resolve_provider` constructs the
       provider, whose constructor raises without a key — resolving first would
       turn "not configured" into a 500.
    2. Unknown/malformed id → 404.
    3. No provider covers this supplier → **409 no_feed_for_supplier**: the
       endpoint exists, this row just has no feed behind it.

    `def`, not `async def`: the provider sleeps between calls to stay under the
    rate limit, and Starlette runs a sync generator in a threadpool where that
    blocking is harmless. As an `async def` it would stall the event loop for
    the whole run.
    """
    if not feed_configured():
        raise HTTPException(404, "sync_unavailable")
    supplier_uuid = _to_uuid(supplier_id)
    supplier = db.query(Supplier).filter(Supplier.id == supplier_uuid).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")
    provider = resolve_provider(supplier)
    if provider is None:
        raise HTTPException(409, "no_feed_for_supplier")
    # A negative LIMIT is a Postgres error and a huge one is an unbounded run
    # against a rate-limited API; both clamp rather than 422 — the number is a
    # batch size, not a request the caller can get wrong.
    limit = max(1, min(50, limit))
    # Read off the row BEFORE the body runs: the abort path rolls back, and
    # these two values must survive that without re-querying.
    supplier_key = str(supplier.id)
    supplier_name = supplier.name

    def stream() -> Iterator[str]:
        # Running totals, tallied as the events go past. The generator owns the
        # authoritative arithmetic (`importer._finished`) and this MIRRORS it,
        # for one reason: when the generator raises, its own totals die with
        # it, and the abort path still has to report what the run did. The
        # importer commits per part BEFORE yielding its event, so everything
        # counted here is work that survived the rollback below.
        counts = {"synced": 0, "media_filled": 0, "not_found": 0, "no_data": 0}

        def tally(event: dict) -> None:
            if event.get("kind") != "part_synced":
                return
            action = event.get("action")
            # media_filled counts in BOTH — filling an image IS a write.
            if action == "media_filled":
                counts["synced"] += 1
                counts["media_filled"] += 1
            elif action == "updated":
                counts["synced"] += 1
            elif action == "not_found":
                counts["not_found"] += 1
            elif action == "no_data":
                counts["no_data"] += 1

        try:
            for event in sync_supplier_listings(db, provider, supplier, limit=limit):
                tally(event)
                _record_event(db, supplier_uuid, event)
                yield json.dumps(event) + "\n"
        except Exception as exc:  # noqa: BLE001
            # A raise inside a response body cuts the NDJSON off mid-line: the
            # client sees a half-written run with no ending and no reason.
            # FeedFatalError (auth/quota) is already handled inside
            # `sync_supplier_listings`; this is for everything else.
            db.rollback()
            failed = sync_event("sync_error", supplier_key, "Sync failed", str(exc))
            _record_event(db, supplier_uuid, failed)
            yield json.dumps(failed) + "\n"
            # Real totals, not zeros: the parts already on screen were each
            # committed before they were reported, so blanking the counters
            # would understate the run directly above a line promising the
            # progress was saved. "sync aborted" still says it did not finish.
            aborted = sync_event("sync_finished", supplier_key, supplier_name, "sync aborted")
            aborted["counts"] = dict(counts)
            _record_event(db, supplier_uuid, aborted)
            yield json.dumps(aborted) + "\n"
        finally:
            # One provider (and its HTTP connection pool) per run — release it
            # whether the run finished, aborted, or the client disconnected.
            close = getattr(provider, "close", None)
            if callable(close):
                close()

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        # nginx buffers a proxied response by default (and its gzip_types cover
        # application/json but not x-ndjson), which would hold the whole run
        # back and deliver it in one lump — the opposite of the point.
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@router.get("/{supplier_id}/parts")
def get_supplier_parts(
    supplier_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    supplier = db.query(Supplier).filter(Supplier.id == _to_uuid(supplier_id)).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")

    query = (
        db.query(Part)
        .join(PartListing, PartListing.part_id == Part.id)
        .filter(PartListing.supplier_id == supplier.id)
    )
    total = query.count()
    pages = max(1, (total + per_page - 1) // per_page)
    offset = (page - 1) * per_page
    items = query.order_by(Part.sku).offset(offset).limit(per_page).all()

    return {
        "items": [
            {
                "id": str(p.id),
                "sku": p.sku,
                "description": p.description,
                "manufacturer_name": p.manufacturer_name,
                "lifecycle_status": p.lifecycle_status,
            }
            for p in items
        ],
        "total": total,
        "page": page,
        "pages": pages,
    }
