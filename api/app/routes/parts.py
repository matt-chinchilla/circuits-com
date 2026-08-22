import re
import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Category, Part, PartListing, PriceBreak, Supplier, User
from app.services.auth_service import get_current_user
from app.services.search_service import invalidate_catalog_caches
from app.utils.image_url import validate_optional_image_url

router = APIRouter(prefix="/api/parts", tags=["parts"])


def _to_uuid(val: str) -> uuid.UUID:
    """Convert string to UUID, raise 404 if invalid."""
    try:
        return uuid.UUID(val)
    except (ValueError, AttributeError):
        raise HTTPException(404, "Not found") from None


def slugify_sku(sku: str) -> str:
    """Derive a URL-safe slug from a part SKU."""
    slug = sku.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    return slug.strip("-")


# --- Pydantic schemas ---


class _ListingNumbers(BaseModel):
    """The numeric/currency bounds shared by EVERY part_listings write path.

    Three schemas below build a PartListing row — ListingCreate
    (POST /{part_id}/listings), InitialListing (POST /api/parts/) and
    BatchPartItem (POST /api/parts/batch, the CSV import and by far the
    highest-volume, most fat-finger-prone door) — so the bounds live here
    once. Put them on one schema only and the other two keep handing raw
    values to Postgres.

    Every bound mirrors a real column constraint, turning a hostile or
    fat-finger payload into a 422 the admin form can render instead of an
    opaque 500:
      - currency   -> String(3): "DOLLARS" is 'value too long for type
                      character varying(3)'.
      - unit_price -> Numeric(10, 4), i.e. 6 integer digits. `le=999999.9999`
                      and NOT `lt=1_000_000`: 999999.99999 clears `lt` but
                      Postgres rounds it to the column's scale first, giving
                      1000000.0000 — 7 integer digits, 'numeric field
                      overflow'.
      - negatives  -> no DB CHECK exists, so they persist happily and roll
                      straight into the public best_price / total_stock
                      aggregates (one negative price undercuts every real
                      listing on the part page).
      - integers   -> stock_quantity / lead_time_days are Postgres int4, so a
                      fat-fingered or pasted 12345678901 is 'integer out of
                      range' — the same opaque 500 the price bound prevents,
                      via the one column class that had a floor but no
                      ceiling. Both caps sit well inside int4's 2147483647
                      and well outside anything real: 2e9 units of stock, and
                      100000 days (~274 years) of lead time.

    The one column bound that CANNOT live here is `listing_sku` -> String(100).
    Only two of the three writers put a value in the row's `sku` column
    (create_part's initial_listing never does), so a field on this base would
    be silently accepted and then dropped on the third. ListingCreate and
    BatchPartItem therefore each declare it, with the SAME max_length=100 —
    keep the two in step.
    """

    stock_quantity: int | None = Field(None, ge=0, le=2_000_000_000)
    unit_price: float | None = Field(None, ge=0, le=999999.9999)
    lead_time_days: int | None = Field(None, ge=0, le=100_000)
    currency: str | None = Field("USD", max_length=3)


class InitialListing(_ListingNumbers):
    """Optional payload bundled with PartCreate so a new Part can be linked
    to a Supplier atomically. Used by the Supplier-detail Quick Actions
    "Add part" flow so sales staff land on one form, submit once, and get
    both the Part row and a PartListing(part_id, supplier_id) wired in a
    single transaction.
    """

    supplier_id: str


class ListingCreate(_ListingNumbers):
    """Attach an ALREADY-EXISTING Part to a Supplier's catalog.

    Sibling of InitialListing: same shape of data, different entry point.
    InitialListing rides along with a PartCreate (new part + first listing in
    one transaction); this one is posted on its own to
    POST /api/parts/{part_id}/listings when the part is already in the
    catalog and a second distributor picks it up.
    """

    supplier_id: str
    # part_listings.sku is String(100) — see the _ListingNumbers docstring for
    # why this bound is duplicated here instead of hoisted onto the base.
    listing_sku: str | None = Field(None, max_length=100)


# The `parts` columns are bounded too, and the same "opaque 500 vs renderable
# 422" argument applies: sku String(100), manufacturer_name String(200),
# sub_slug String(80), datasheet_url String(500). description is Text
# (unbounded) and needs no cap. PartCreate / PartUpdate / BatchPartItem are the
# three writers — bound all of them or the unbounded one still 500s.
#
# `lifecycle_status` is the same class of bug with a different column type:
# parts.lifecycle_status is Enum('active', 'nrnd', 'obsolete', 'unknown'), so a
# free `str` lets 'Active' or 'discontinued' through the schema and Postgres
# answers with 'invalid input value for enum lifecycle_status' — a 500. A
# Literal keeps the membership check at the schema boundary (422, nothing
# written) and keeps the accepted set in one place next to the column. Keep the
# members in step with the model's Enum; the SQLite test DB ignores Enum just
# like it ignores String(N), so drift only shows up in prod.
LifecycleStatus = Literal["active", "nrnd", "obsolete", "unknown"]


def _reject_non_http_scheme(v: str | None) -> str | None:
    """Write-side half of the stored-href defense: a datasheet URL may be
    schemeless (the admin form prepends https) or http(s), never an executable
    scheme — 'javascript:'/'data:text/html' in href is stored DOM-XSS. The
    read side mirrors this with safeHttpUrl at every render site."""
    if v is None or not v.strip():
        return v
    low = v.strip().lower()
    if re.match(r"^[a-z][a-z0-9+.-]*:", low) and not low.startswith(("http://", "https://")):
        raise ValueError("datasheet_url must be an http(s) link")
    return v


class PartCreate(BaseModel):
    sku: str = Field(..., max_length=100)
    description: str | None = None
    manufacturer_name: str = Field(..., max_length=200)
    category_id: str | None = None
    sub_slug: str | None = Field(None, max_length=80)
    datasheet_url: str | None = Field(None, max_length=500)
    image_url: str | None = Field(None, max_length=500)
    lifecycle_status: LifecycleStatus = "active"
    initial_listing: InitialListing | None = None

    @field_validator("image_url")
    @classmethod
    def _check_image_url(cls, v: str | None) -> str | None:
        return validate_optional_image_url(v)

    @field_validator("datasheet_url")
    @classmethod
    def _check_datasheet_url(cls, v: str | None) -> str | None:
        return _reject_non_http_scheme(v)


class PartUpdate(BaseModel):
    sku: str | None = Field(None, max_length=100)
    description: str | None = None
    manufacturer_name: str | None = Field(None, max_length=200)
    category_id: str | None = None
    sub_slug: str | None = Field(None, max_length=80)
    datasheet_url: str | None = Field(None, max_length=500)
    image_url: str | None = Field(None, max_length=500)
    lifecycle_status: LifecycleStatus | None = None

    @field_validator("image_url")
    @classmethod
    def _check_image_url(cls, v: str | None) -> str | None:
        return validate_optional_image_url(v)

    @field_validator("datasheet_url")
    @classmethod
    def _check_datasheet_url(cls, v: str | None) -> str | None:
        return _reject_non_http_scheme(v)


class BatchPartItem(_ListingNumbers):
    sku: str = Field(..., max_length=100)
    description: str | None = None
    manufacturer_name: str = Field(..., max_length=200)
    category_id: str | None = None
    listing_sku: str | None = Field(None, max_length=100)


class BatchImportRequest(BaseModel):
    supplier_id: str
    parts: list[BatchPartItem]


# --- Helpers ---


def part_to_dict(part: Part, db: Session | None = None) -> dict:
    category_name = None
    category_icon = None
    category_slug = None
    parent_category_name = None
    parent_category_slug = None
    parent_category_icon = None
    if part.category_id and db:
        cat = db.query(Category).filter(Category.id == part.category_id).first()
        if cat:
            category_name = cat.name
            category_icon = cat.icon
            category_slug = cat.slug
            if cat.parent_id:
                parent = db.query(Category).filter(Category.id == cat.parent_id).first()
                if parent:
                    parent_category_name = parent.name
                    parent_category_slug = parent.slug
                    parent_category_icon = parent.icon

    # Aggregate over listings (lazy="selectin" auto-loads them, no N+1).
    # best_price = MIN(unit_price), total_stock = SUM(stock_quantity).
    # Both null when the part has zero listings.
    listings = list(part.listings or [])
    best_price = min((float(li.unit_price) for li in listings), default=None)
    total_stock = sum((li.stock_quantity or 0) for li in listings) if listings else None

    return {
        "id": str(part.id),
        "sku": part.sku,
        "slug": part.slug,
        "description": part.description,
        "manufacturer_name": part.manufacturer_name,
        "category_id": str(part.category_id) if part.category_id else None,
        "category_name": category_name,
        "category_slug": category_slug,
        "category_icon": category_icon,
        "parent_category_name": parent_category_name,
        "parent_category_slug": parent_category_slug,
        "parent_category_icon": parent_category_icon,
        "sub_slug": part.sub_slug,
        "best_price": best_price,
        "total_stock": total_stock,
        "datasheet_url": part.datasheet_url,
        "image_url": part.image_url,
        "lifecycle_status": part.lifecycle_status,
        "mount": part.mount,
        "rohs": part.rohs,
        "lead_time_days": part.lead_time_days,
        "created_at": part.created_at.isoformat() if part.created_at else None,
        "updated_at": part.updated_at.isoformat() if part.updated_at else None,
    }


def listing_to_dict(listing: PartListing) -> dict:
    return {
        "id": str(listing.id),
        "supplier_id": str(listing.supplier_id),
        "supplier_name": listing.supplier.name if listing.supplier else None,
        "supplier_website": listing.supplier.website if listing.supplier else None,
        "sku": listing.sku,
        "stock_quantity": listing.stock_quantity,
        "lead_time_days": listing.lead_time_days,
        "unit_price": float(listing.unit_price),
        "currency": listing.currency,
        "price_breaks": [
            {
                "id": str(pb.id),
                "min_quantity": pb.min_quantity,
                "unit_price": float(pb.unit_price),
            }
            for pb in listing.price_breaks
        ],
    }


# --- Routes ---


@router.get("/")
def list_parts(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: str | None = None,
    category_id: str | None = None,
    supplier_id: str | None = None,
    db: Session = Depends(get_db),
):
    query = db.query(Part)

    if search:
        pattern = f"%{search}%"
        query = query.filter(or_(Part.sku.ilike(pattern), Part.description.ilike(pattern)))

    if category_id:
        query = query.filter(Part.category_id == _to_uuid(category_id))

    if supplier_id:
        query = query.join(PartListing, PartListing.part_id == Part.id).filter(
            PartListing.supplier_id == _to_uuid(supplier_id)
        )

    total = query.count()
    pages = max(1, (total + per_page - 1) // per_page)
    offset = (page - 1) * per_page
    items = query.order_by(Part.sku).offset(offset).limit(per_page).all()

    return {
        "items": [part_to_dict(p, db) for p in items],
        "total": total,
        "page": page,
        "pages": pages,
    }


@router.post("/")
def create_part(
    body: PartCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Auto-derive sub_slug when category_id resolves to a child category and
    # the caller didn't provide one explicitly. Keeps the denormalization
    # consistent across CSV-imported, admin-UI-created, and API-created rows
    # — otherwise new rows would NULL where the backfill (migration 006)
    # populated child-category slugs on existing rows.
    derived_sub_slug = body.sub_slug
    if derived_sub_slug is None and body.category_id:
        cat = db.query(Category).filter(Category.id == _to_uuid(body.category_id)).first()
        if cat is not None and cat.parent_id is not None:
            derived_sub_slug = cat.slug

    part = Part(
        id=uuid.uuid4(),
        sku=body.sku,
        slug=slugify_sku(body.sku),
        description=body.description,
        manufacturer_name=body.manufacturer_name,
        category_id=_to_uuid(body.category_id) if body.category_id else None,
        sub_slug=derived_sub_slug,
        datasheet_url=body.datasheet_url,
        image_url=body.image_url,
        lifecycle_status=body.lifecycle_status,
    )
    db.add(part)
    db.flush()

    # When the Supplier-detail "Add part" flow hands off context, create the
    # PartListing in the same transaction so the new part is immediately
    # discoverable on the supplier's page. Mirrors /batch's wiring.
    if body.initial_listing:
        il = body.initial_listing
        supplier = db.query(Supplier).filter(Supplier.id == _to_uuid(il.supplier_id)).first()
        if not supplier:
            db.rollback()
            raise HTTPException(404, "Supplier for initial_listing not found")
        listing = PartListing(
            id=uuid.uuid4(),
            part_id=part.id,
            supplier_id=supplier.id,
            stock_quantity=il.stock_quantity or 0,
            lead_time_days=il.lead_time_days,
            unit_price=Decimal(str(il.unit_price)) if il.unit_price is not None else Decimal("0"),
            currency=il.currency or "USD",
        )
        db.add(listing)

    db.commit()
    invalidate_catalog_caches()
    db.refresh(part)
    return part_to_dict(part, db)


@router.post("/{part_id}/listings")
def add_part_listing(
    part_id: str,
    body: ListingCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add one distributor listing to an existing part.

    The admin "Add distributor" flow (part detail → /listings/new) posts here.
    Unlike POST /parts/ with initial_listing, the part already exists, so this
    is a pure insert — no Part row is created or mutated.
    """
    part = db.query(Part).filter(Part.id == _to_uuid(part_id)).first()
    if not part:
        raise HTTPException(404, "Part not found")

    supplier = db.query(Supplier).filter(Supplier.id == _to_uuid(body.supplier_id)).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")

    # There is no UNIQUE(part_id, supplier_id) on part_listings, so this guard
    # is the ONLY duplicate protection. Two listings for the same distributor
    # would double-count total_stock and make best_price ambiguous on the
    # public part page — reject instead, and let the admin edit or remove the
    # listing that already holds the slot.
    existing = (
        db.query(PartListing)
        .filter(
            PartListing.part_id == part.id,
            PartListing.supplier_id == supplier.id,
        )
        .first()
    )
    if existing:
        raise HTTPException(
            409,
            f"{supplier.name} already carries {part.sku}. "
            "Remove that listing before adding a new one.",
        )

    # Decimal(str(...)) — never a raw float and never None into the
    # Numeric(10, 4) NOT NULL column. Mirrors create_part's initial_listing.
    #
    # The Decimal("0") fallback is API tolerance ONLY, and it is a poor value:
    # best_price is MIN(unit_price) across a part's listings, so a $0.0000 row
    # doesn't read as "price unknown" on the public part page — it WINS, and
    # undercuts every real distributor. The admin attach form
    # (frontend/src/admin/pages/parts/attach) therefore requires a unit price
    # client-side rather than letting the omission reach here. It stays optional
    # in the schema because the two sibling writers legitimately omit it (batch
    # rows without pricing create no listing at all, and initial_listing's
    # contract predates this), and because tightening it to a required field
    # would break the documented default-to-zero behaviour of this endpoint.
    listing = PartListing(
        id=uuid.uuid4(),
        part_id=part.id,
        supplier_id=supplier.id,
        sku=body.listing_sku,
        stock_quantity=body.stock_quantity or 0,
        lead_time_days=body.lead_time_days,
        unit_price=Decimal(str(body.unit_price)) if body.unit_price is not None else Decimal("0"),
        currency=body.currency or "USD",
    )
    db.add(listing)
    db.commit()
    db.refresh(listing)
    return listing_to_dict(listing)


@router.delete("/{part_id}/listings/{listing_id}")
def delete_part_listing(
    part_id: str,
    listing_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove one distributor listing, leaving the Part itself in place."""
    listing = (
        db.query(PartListing)
        .filter(
            PartListing.id == _to_uuid(listing_id),
            PartListing.part_id == _to_uuid(part_id),
        )
        .first()
    )
    if not listing:
        raise HTTPException(404, "Listing not found")

    # Price breaks first — same cascade order as delete_part. PriceBreak's
    # listing_id FK is NOT NULL, so the children must go before the parent.
    db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).delete()
    # Bulk-delete leaves the lazy="selectin" price_breaks collection loaded
    # and stale; expire before the ORM delete or SQLAlchemy tries to blank
    # out the already-gone children's primary key (see CLAUDE.md gotcha).
    db.expire(listing)
    db.delete(listing)
    db.commit()
    return {"status": "ok"}


@router.get("/by-slug/{slug}")
def get_part_by_slug(slug: str, db: Session = Depends(get_db)):
    part = db.query(Part).filter(Part.slug == slug).first()
    if not part:
        raise HTTPException(404, "Part not found")

    result = part_to_dict(part, db)
    result["listings"] = [listing_to_dict(li) for li in part.listings]
    return result


@router.get("/{part_id}")
def get_part(part_id: str, db: Session = Depends(get_db)):
    part = db.query(Part).filter(Part.id == _to_uuid(part_id)).first()
    if not part:
        raise HTTPException(404, "Part not found")

    result = part_to_dict(part, db)
    result["listings"] = [listing_to_dict(ls) for ls in part.listings]
    return result


@router.get("/{part_id}/related")
def related_parts(part_id: str, db: Session = Depends(get_db)):
    """Alternates and companions for the part page, from taxonomy proximity.

    Alternates = other parts in the SAME subcategory, different manufacturer
    first, then closest best-price — the "can I swap this?" list. Companions =
    one part from each SIBLING subcategory under the same parent (an LDO's
    neighbors are DC-DC converters and supervisors) — real design adjacency
    with no hand-maintained pairing map to drift. Both empty when the part has
    no category; the page hides the sections.
    """
    part = db.query(Part).filter(Part.id == _to_uuid(part_id)).first()
    if not part:
        raise HTTPException(404, "Part not found")

    def best_price(p: Part) -> float | None:
        return min((float(li.unit_price) for li in (p.listings or [])), default=None)

    alternates: list[Part] = []
    companions: list[tuple[Part, Category]] = []
    cat: Category | None = None
    parent: Category | None = None
    if part.category_id:
        cat = db.query(Category).filter(Category.id == part.category_id).first()
        if cat is not None and cat.parent_id is not None:
            parent = db.query(Category).filter(Category.id == cat.parent_id).first()

        candidates = (
            db.query(Part)
            .filter(Part.category_id == part.category_id, Part.id != part.id)
            .order_by(Part.sku)
            .limit(24)
            .all()
        )
        own_best = best_price(part)

        def sort_key(p: Part) -> tuple:
            # `is None` checks, not `or` — a genuine $0.00 best price is a
            # real distance, and an unpriced part must sort LAST, not first
            # (the falsy-zero trap CLAUDE.md flags).
            bp = best_price(p)
            same_mfr = p.manufacturer_name == part.manufacturer_name
            if bp is None or own_best is None:
                return (same_mfr, True, 0.0, p.sku)
            return (same_mfr, False, abs(bp - own_best), p.sku)

        candidates.sort(key=sort_key)
        alternates = candidates[:4]

        if cat is not None and cat.parent_id is not None:
            siblings = (
                db.query(Category)
                .filter(Category.parent_id == cat.parent_id, Category.id != cat.id)
                .order_by(Category.name)
                .all()
            )
            # Batched pick instead of a per-sibling .first() — the loop shape
            # was an N+1 (~2 round-trips per sibling once each row's selectin
            # listings load fires). A window function keeps the fetch at one
            # row per sibling (fetching ALL sibling parts would be worse than
            # the N+1 at real catalog sizes), then one Part query loads the
            # picks with a single shared selectin batch for their listings.
            sib_ids = [s.id for s in siblings]
            picks_by_cat: dict = {}
            if sib_ids:
                rn = (
                    func.row_number()
                    .over(partition_by=Part.category_id, order_by=Part.sku)
                    .label("rn")
                )
                ranked = (
                    db.query(Part.id.label("pid"), rn)
                    .filter(Part.category_id.in_(sib_ids))
                    .subquery()
                )
                first_ids = [
                    row.pid for row in db.query(ranked.c.pid).filter(ranked.c.rn == 1)
                ]
                picks_by_cat = {
                    p.category_id: p
                    for p in db.query(Part).filter(Part.id.in_(first_ids))
                }
            for sib in siblings:
                pick = picks_by_cat.get(sib.id)
                if pick is not None:
                    companions.append((pick, sib))
                if len(companions) >= 4:
                    break

    def serialize(p: Part, c: Category | None) -> dict:
        # part_to_dict without db skips its per-part Category (+parent)
        # queries; the category objects are already in hand, so stamp them in
        # directly — otherwise every page view pays ~16 redundant round-trips.
        d = part_to_dict(p)
        if c is not None:
            d["category_name"] = c.name
            d["category_slug"] = c.slug
            d["category_icon"] = c.icon
        if parent is not None:
            d["parent_category_name"] = parent.name
            d["parent_category_slug"] = parent.slug
            d["parent_category_icon"] = parent.icon
        return d

    return {
        "alternates": [serialize(p, cat) for p in alternates],
        "companions": [serialize(p, c) for p, c in companions],
    }


@router.put("/{part_id}")
def update_part(
    part_id: str,
    body: PartUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    part = db.query(Part).filter(Part.id == _to_uuid(part_id)).first()
    if not part:
        raise HTTPException(404, "Part not found")

    update_data = body.model_dump(exclude_unset=True)
    if "category_id" in update_data and update_data["category_id"] is not None:
        update_data["category_id"] = _to_uuid(update_data["category_id"])
    for key, value in update_data.items():
        setattr(part, key, value)

    db.commit()
    invalidate_catalog_caches()
    db.refresh(part)
    return part_to_dict(part, db)


@router.delete("/{part_id}")
def delete_part(
    part_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    part = db.query(Part).filter(Part.id == _to_uuid(part_id)).first()
    if not part:
        raise HTTPException(404, "Part not found")

    # Delete price breaks for each listing, then listings, then part
    for listing in part.listings:
        db.query(PriceBreak).filter(PriceBreak.listing_id == listing.id).delete()
    db.query(PartListing).filter(PartListing.part_id == part.id).delete()
    db.delete(part)
    db.commit()
    invalidate_catalog_caches()
    return {"status": "ok"}


@router.post("/batch")
def batch_import(
    body: BatchImportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Validate supplier exists
    supplier = db.query(Supplier).filter(Supplier.id == _to_uuid(body.supplier_id)).first()
    if not supplier:
        raise HTTPException(404, "Supplier not found")

    created = 0
    errors = []

    for idx, item in enumerate(body.parts):
        try:
            if not item.sku or not item.manufacturer_name:
                raise ValueError("sku and manufacturer_name are required")

            # SAVEPOINT per row. This route reports partial success
            # ({"created": N, "errors": [...]}), which only holds if a bad row
            # rolls back JUST ITSELF: a plain db.rollback() in the handler below
            # discarded the WHOLE open transaction — every previously flushed
            # good row vanished while `created` still counted them, so the
            # response over-reported and the admin's CSV silently lost rows.
            # begin_nested() re-raises after releasing the savepoint, so the
            # except still sees the original error.
            with db.begin_nested():
                part = Part(
                    id=uuid.uuid4(),
                    sku=item.sku,
                    slug=slugify_sku(item.sku),
                    description=item.description,
                    manufacturer_name=item.manufacturer_name,
                    category_id=_to_uuid(item.category_id) if item.category_id else None,
                )
                db.add(part)
                db.flush()

                # Create listing if pricing info provided
                if item.unit_price is not None:
                    listing = PartListing(
                        id=uuid.uuid4(),
                        part_id=part.id,
                        supplier_id=supplier.id,
                        sku=item.listing_sku,
                        stock_quantity=item.stock_quantity or 0,
                        lead_time_days=item.lead_time_days,
                        unit_price=Decimal(str(item.unit_price)),
                        currency=item.currency or "USD",
                    )
                    db.add(listing)
                    db.flush()

            # Only counted once the savepoint released cleanly, i.e. the row
            # really is part of the transaction the commit below persists.
            created += 1
        except Exception as e:
            errors.append({"row": idx, "error": str(e)})

    if created > 0:
        db.commit()
        invalidate_catalog_caches()

    return {"created": created, "errors": errors}
