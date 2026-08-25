import json
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
    SupplierFeed,
    User,
)
from app.services.auth_service import (
    get_current_user,
)
from app.services.part_feed import (
    PartFeedProvider,
    get_feed_key,
    grow_catalog,
    match_provider,
    sync_supplier_listings,
)

# The run registry, imported from the SUBMODULE rather than through the
# package: these names are the route's half of one seam and nothing else
# consumes them, so widening `part_feed.__all__` would advertise run management
# to callers who should only be starting runs.
from app.services.part_feed.importer import (
    CONTINUOUS_CALL_CEILING,
    FeedRun,
    FeedRunActive,
    FeedWork,
    get_feed_run,
    request_feed_stop,
    start_feed_run,
)
from app.services.search_service import get_active_supplier_tiers, invalidate_catalog_caches
from app.utils.color import validate_optional_hex_color
from app.utils.image_url import validate_optional_image_url

router = APIRouter(prefix="/api/suppliers", tags=["suppliers"])


def _to_uuid(val: str) -> uuid.UUID:
    """Convert string to UUID, raise 404 if invalid."""
    try:
        return uuid.UUID(val)
    except (ValueError, AttributeError):
        raise HTTPException(404, "Not found")


def _supplier_or_404(db: Session, supplier_id: str) -> Supplier:
    """The supplier row, or the 404 every route on this file answers with.

    One definition so a malformed id and an unknown one keep giving the same
    answer everywhere — a route that grew its own copy is how an id shape ends
    up 500ing on one endpoint and 404ing on the next.
    """
    supplier = db.query(Supplier).filter(Supplier.id == _to_uuid(supplier_id)).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")
    return supplier


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

    # Highest ACTIVE sponsorship tier, normalized lowercase (or None) — the
    # same shared helper the search supplier hits use, so the browse drawer's
    # FEATURED badge and the search results can never disagree.
    tiers = get_active_supplier_tiers(db)

    return [
        {
            **supplier_to_dict(s),
            "parts_count": int(parts_counts.get(s.id, 0)),
            "categories": categories_by_supplier.get(s.id, []),
            "tier": tiers.get(s.id),
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
    invalidate_catalog_caches()
    db.refresh(supplier)
    return supplier_to_dict(supplier)


@router.get("/{supplier_id}")
def get_supplier(supplier_id: str, db: Session = Depends(get_db)):
    supplier = _supplier_or_404(db, supplier_id)

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
    supplier = _supplier_or_404(db, supplier_id)

    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(supplier, key, value)

    db.commit()
    invalidate_catalog_caches()
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
    Revenue rows and the supplier's feed settings are removed. Linked Users have
    `supplier_id` set to NULL — admin/company-user accounts must survive — and
    so do ActivityEvents, which record what actually happened and outlive the
    company row.
    """
    supplier = _supplier_or_404(db, supplier_id)

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
    # Feed settings are the other way round: a dependent, not history. A company
    # that is gone has no nightly import, and the FK carries no cascade, so this
    # row has to go before the supplier does or the DELETE dies on it.
    db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier.id).delete(
        synchronize_session=False
    )

    # Bulk deletes bypass session sync; expire the supplier so the upcoming
    # ORM delete doesn't try to NULL composite-PK columns on stale in-memory
    # CategorySupplier rows (lazy="selectin" had loaded them).
    db.expire(supplier)
    db.delete(supplier)
    db.commit()
    invalidate_catalog_caches()
    return {"status": "ok"}


# ── Live feed runs: sync (refresh what we list) and import (find new) ───────


def _resolve_feed_provider(db: Session, supplier_id: str) -> tuple[Supplier, PartFeedProvider]:
    """The supplier row and a provider built for ITS feed — or the refusal.

    ORDER OF REFUSAL, and it matters (shared by both streams, which is why it
    is one function and not two copies):

    1. Unknown/malformed id → 404.
    2. No provider covers this supplier → **409 no_feed_for_supplier**: the
       endpoint exists, this row just has no feed behind it.
    3. No key for THAT provider → **404 sync_unavailable**, the same feature-off
       posture as the Stripe routes: an unconfigured feed has no such endpoint.
       `get_feed_key` reads the key stored from Admin → Settings first and falls
       back to the environment.

    The key is resolved for the MATCHED slug, not for a default: a second
    distributor in the registry must not be reachable on Mouser's credential
    (nor be gated open by Mouser's key being present). Matching does NOT
    construct — `match_provider` returns the CLASS — so the provider is only
    ever built once its own key is in hand, which is what keeps a missing key a
    404 instead of the constructor's RuntimeError as a 500.
    """
    supplier = _supplier_or_404(db, supplier_id)
    match = match_provider(supplier)
    if match is None:
        raise HTTPException(409, "no_feed_for_supplier")
    provider_slug, provider_cls = match
    key = get_feed_key(db, provider_slug)
    if not key:
        raise HTTPException(404, "sync_unavailable")
    return supplier, provider_cls.from_credential(key)


# How long an observer may hear nothing before the stream sends a blank line.
# nginx cuts an idle proxied response at 60 s by default (neither nginx config
# sets `proxy_read_timeout`), and an import sweeping already-known MPNs yields
# NO event for minutes while still spending 2.1 s per provider call — so a
# perfectly healthy run used to be exposed to a proxy-side cut. A bare "\n" is
# contract-safe: NDJSON readers skip blank lines (the client's `parseNdjson`
# does, and so does every test helper here), so it is traffic without being an
# event.
FEED_RUN_HEARTBEAT_SECONDS = 20.0


def _feed_run_response(run: FeedRun) -> StreamingResponse:
    """The NDJSON body — one JSON object per line, as the run produces them.

    An OBSERVER, not the engine. The run is driven by its own worker thread
    (`part_feed.importer.start_feed_run`); this generator replays what has
    happened so far and then follows along, and closing it detaches a reader
    without touching the work. That split is the whole fix: the response body
    USED to BE the import, so a dead transport — a frozen tab, a proxy
    timeout, a sleeping laptop — silently ended the run mid-sweep with a
    `200 OK` in the log and no way to finish or resume it.
    """

    def observe() -> Iterator[str]:
        for event in run.observe(heartbeat_seconds=FEED_RUN_HEARTBEAT_SECONDS):
            yield "\n" if event is None else json.dumps(event) + "\n"

    return StreamingResponse(
        observe(),
        media_type="application/x-ndjson",
        # nginx buffers a proxied response by default (and its gzip_types cover
        # application/json but not x-ndjson), which would hold the whole run
        # back and deliver it in one lump — the opposite of the point.
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            # Which run this socket is watching, and which job it is. A client
            # that re-attaches after a dropped socket needs the MODE to label
            # the console it is re-filling, and it cannot infer it from a
            # stream whose events are identical on both routes.
            "X-Feed-Run-Id": run.run_id,
            "X-Feed-Run-Mode": run.mode,
            # Is the run still GOING, or is this only its replay? A finished
            # run stays readable for the retention window precisely so an
            # operator who lost the socket can come back and read it — which
            # means "the attach succeeded" is NOT evidence of live work, and a
            # client that assumed it was spent the whole replay of a paused run
            # claiming the run was still going and offering a Pause that could
            # only 404. The stream ending settles it either way; this is what
            # the console needs BEFORE the last line lands.
            "X-Feed-Run-Active": "true" if run.running else "false",
        },
    )


def _start_feed_run(
    provider: PartFeedProvider,
    supplier: Supplier,
    work: FeedWork,
    mode: str = "sync",
) -> StreamingResponse:
    """Start the run, then hand back a stream that watches it.

    Shared by sync and import because everything outside the generator is the
    same job. `work` is a CALLABLE taking `(session, provider, supplier)` — the
    worker owns its own session (the request's is closed at request teardown by
    `get_db`), so a thunk closing over the request session is exactly the
    coupling this replaces.

    `mode` is the ONE thing the two routes disagree about, and it changes
    nothing on the wire: it picks the activity LABELS an import files its run
    under (`IMPORT_EVENT_KINDS`) and the abort event's title, so a failed
    import reads "Import failed" rather than announcing a sync the operator
    never started. The stream itself stays one shape for one parser.
    """
    try:
        run = start_feed_run(supplier=supplier, mode=mode, provider=provider, work=work)
    except FeedRunActive:
        # The provider was built for a run that will not happen — release its
        # connection pool rather than leaving it to the garbage collector.
        close = getattr(provider, "close", None)
        if callable(close):
            close()
        # Not a queue: two runs would spend the same rate-limited daily quota
        # twice and interleave writes to the same rows. The caller can watch
        # the run already going via GET /{id}/feed-run.
        raise HTTPException(409, "feed_run_already_active") from None
    return _feed_run_response(run)


@router.post("/{supplier_id}/sync")
def sync_supplier(
    supplier_id: str,
    limit: int = 25,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Refresh this supplier's listings from its distributor feed.

    A sync takes minutes (the provider throttles itself under the free tier's
    ~30 calls/min), so the admin watches it happen instead of staring at a
    spinner. The route is deliberately thin: `sync_supplier_listings` owns the
    import and commits per part; `_stream_feed_run` records and serializes, and
    `_resolve_feed_provider` holds the order of refusal.

    `def`, not `async def`: the provider sleeps between calls to stay under the
    rate limit, and Starlette runs a sync generator in a threadpool where that
    blocking is harmless. As an `async def` it would stall the event loop for
    the whole run.
    """
    supplier, provider = _resolve_feed_provider(db, supplier_id)
    # A negative LIMIT is a Postgres error and a huge one is an unbounded run
    # against a rate-limited API; both clamp rather than 422 — the number is a
    # batch size, not a request the caller can get wrong.
    limit = max(1, min(50, limit))
    return _start_feed_run(
        provider,
        supplier,
        lambda run_db, run_provider, run_supplier: sync_supplier_listings(
            run_db, run_provider, run_supplier, limit=limit
        ),
    )


@router.post("/{supplier_id}/import")
def import_supplier_parts(
    supplier_id: str,
    calls: int = 200,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Import NEW inventory for this supplier, thinnest subcategory first.

    The mirror image of `sync_supplier`'s economics and its twin in every other
    respect (same refusal order, same NDJSON envelope, same activity rows): a
    sync spends one provider call per part it ALREADY lists, an import spends
    one call per PAGE of parts the catalog does not have yet. So the bound here
    is a CALL BUDGET, not a row count — `grow_catalog` walks as far down the
    thin-first category order as `calls` can pay for.

    900 is the ceiling because the free tier allows ~1,000 calls/day
    (`docs/part-import-runbook.md`): one click must not be able to spend the
    whole day's allowance in a single request, and a budget of 0 would start a
    run that can never do anything. Both ends clamp rather than 422 — same call
    as `sync`'s `limit`: this is a batch size, not a request a caller can get
    wrong.

    ONE BATCH, OR UNTIL THE WELL IS DRY — decided by this supplier's stored
    `auto_import_enabled`, read HERE and never taken from the request. One
    pass reads at most one page per subcategory, so a plain click advances
    every shelf by one page and stops with budget to spare; with Auto-import ON
    the same click sweeps again and again until the feed is exhausted or its
    quota walls the run. `calls` is simply ignored in that mode.

    There is deliberately NO `continuous` query parameter. A URL is durable —
    bookmarked, retried, shared — and an unbounded spend against a
    rate-limited daily quota must not be something a link can ask for. The
    switch is the one place that intent is expressed, and flipping it is
    already gated (`update_feed_settings` 409s an enable with no provider or
    no key), which is exactly the check a continuous run needs.

    The nightly job is untouched by this: `jobs/feed_import_daily` keeps
    passing its own even slice of `FEED_IMPORT_CALL_BUDGET` with
    `continuous` false, because that budget is a FAIRNESS constraint across
    every enabled supplier on one shared account-wide quota.
    """
    supplier, provider = _resolve_feed_provider(db, supplier_id)
    feed_row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier.id).first()
    continuous = bool(feed_row and feed_row.auto_import_enabled)
    call_budget = CONTINUOUS_CALL_CEILING if continuous else max(1, min(900, calls))
    return _start_feed_run(
        provider,
        supplier,
        lambda run_db, run_provider, run_supplier: grow_catalog(
            run_db,
            run_provider,
            run_supplier,
            call_budget=call_budget,
            continuous=continuous,
        ),
        mode="import",
    )


@router.get("/{supplier_id}/feed-run")
def observe_supplier_feed_run(
    supplier_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Watch the run this supplier already has going — the RE-ATTACH door.

    A run is server-owned now, so a lost socket is a lost VIEW rather than a
    lost run: the operator's tab froze, a proxy timed out, they navigated away
    and came back. This hands them the same stream again, replayed from the
    top and then live, so the console refills instead of the run vanishing.

    404 `no_feed_run` when there is nothing to watch — a run that finished
    outside the retention window is the same answer as one that never
    happened, because both leave the client with nothing to attach to (the
    dashboard's `activity_events` rows are the durable record either way).

    Refuses the demo account, which cannot START a run: `get_current_user`
    gates the demo on WRITES only, so a GET needs its own line or the one
    account handed to any anonymous visitor could read a run it is not allowed
    to cause.
    """
    supplier = _supplier_or_404(db, supplier_id)
    run = get_feed_run(supplier.id)
    if run is None:
        raise HTTPException(404, "no_feed_run")
    return _feed_run_response(run)


# ── Per-supplier feed settings: does the nightly import run for this row? ───


class FeedSettingsUpdate(BaseModel):
    auto_import_enabled: bool


def _feed_settings(db: Session, supplier: Supplier) -> dict:
    """What the admin's switch renders from — and nothing else.

    Three fields, none of them a secret: which provider covers this supplier (if
    any), whether a key exists for THAT provider, and whether the nightly import
    is switched on. `key_configured` is `get_feed_key` — the Admin → Settings
    row first, the environment as fallback — so this endpoint agrees with what a
    run would actually present, rather than with one of the two sources.

    `supplier_feeds` also carries `feed_url` and `api_key` (the partner-feed
    phase writes them); neither is read here and neither is ever returned.

    The stored toggle is reported as STORED even when the feed could not run
    right now: a key removed after the fact does not silently flip the operator's
    switch, and the UI greys it on `provider`/`key_configured` instead.
    """
    match = match_provider(supplier)
    provider_slug = match[0] if match else None
    row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier.id).first()
    return {
        "provider": provider_slug,
        "key_configured": bool(get_feed_key(db, provider_slug)) if provider_slug else False,
        "auto_import_enabled": bool(row.auto_import_enabled) if row else False,
    }


@router.get("/{supplier_id}/feed-settings")
def get_feed_settings(
    supplier_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Whether this supplier has a feed, a key, and the nightly run switched on.

    Unlike the sync/import routes this one does NOT 404 when the feature is
    unconfigured: the switch has to render greyed with a reason, and "no
    endpoint" gives the UI nothing to say. The demo account reads it as-is —
    there is no secret in the payload to withhold.
    """
    return _feed_settings(db, _supplier_or_404(db, supplier_id))


@router.patch("/{supplier_id}/feed-settings")
def update_feed_settings(
    supplier_id: str,
    body: FeedSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Flip the nightly auto-import for this supplier.

    ENABLING requires a feed that could actually run — a provider match AND a
    key for that provider — else **409 `feed_not_configured`**. A switch that
    turns on a job which can never do anything is a lie told to the operator
    every night, and the 409 is what makes the UI say why.

    DISABLING is always allowed, deliberately: the key may have been removed
    since, and an off switch that refuses to work traps the toggle in whatever
    state it was left in.

    Upserts the row, touching ONE column — a blind rebuild would drop the
    partner-feed `feed_url`/`api_key` the next phase stores beside it. The demo
    account never reaches here (the global read-only gate 403s first).
    """
    supplier = _supplier_or_404(db, supplier_id)
    state = _feed_settings(db, supplier)
    if body.auto_import_enabled and not (state["provider"] and state["key_configured"]):
        raise HTTPException(409, "feed_not_configured")

    row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier.id).first()
    if row is None:
        row = SupplierFeed(supplier_id=supplier.id)
        db.add(row)
    row.auto_import_enabled = body.auto_import_enabled
    db.commit()
    return _feed_settings(db, supplier)


@router.get("/{supplier_id}/parts")
def get_supplier_parts(
    supplier_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    supplier = _supplier_or_404(db, supplier_id)

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


@router.post("/{supplier_id}/feed-run/pause")
def pause_feed_run(
    supplier_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Wind down this supplier's ACTIVE run (the owner's second click).

    Pause, not freeze: the worker finishes the part in hand, commits, and ends
    the run with its real tally + a "paused" detail — for imports the cursor
    makes the next click a RESUME. A paused run holds no thread, session or
    provider, and frees the 409 slot. Demo cannot reach this: POST is covered
    by the write-gate. 404 = nothing running (finished runs cannot be paused).
    """
    supplier = db.get(Supplier, _to_uuid(supplier_id))
    if supplier is None:
        raise HTTPException(status_code=404, detail="Supplier not found")
    run_id = request_feed_stop(supplier.id)
    if run_id is None:
        raise HTTPException(status_code=404, detail="no_feed_run")
    return {"pausing": True, "run_id": run_id}
