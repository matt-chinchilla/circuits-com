import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Part, PartListing, PriceBreak, Supplier, User, Category
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/parts", tags=["parts"])


def _to_uuid(val: str) -> uuid.UUID:
    """Convert string to UUID, raise 404 if invalid."""
    try:
        return uuid.UUID(val)
    except (ValueError, AttributeError):
        raise HTTPException(404, "Not found")


# --- Pydantic schemas ---

class InitialListing(BaseModel):
    """Optional payload bundled with PartCreate so a new Part can be linked
    to a Supplier atomically. Used by the Supplier-detail Quick Actions
    "Add part" flow so sales staff land on one form, submit once, and get
    both the Part row and a PartListing(part_id, supplier_id) wired in a
    single transaction.
    """
    supplier_id: str
    stock_quantity: int | None = None
    unit_price: float | None = None


class PartCreate(BaseModel):
    sku: str
    description: str | None = None
    manufacturer_name: str
    category_id: str | None = None
    sub_slug: str | None = None
    datasheet_url: str | None = None
    lifecycle_status: str = "active"
    initial_listing: InitialListing | None = None


class PartUpdate(BaseModel):
    sku: str | None = None
    description: str | None = None
    manufacturer_name: str | None = None
    category_id: str | None = None
    sub_slug: str | None = None
    datasheet_url: str | None = None
    lifecycle_status: str | None = None


class BatchPartItem(BaseModel):
    sku: str
    description: str | None = None
    manufacturer_name: str
    category_id: str | None = None
    listing_sku: str | None = None
    stock_quantity: int | None = None
    unit_price: float | None = None


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
        "lifecycle_status": part.lifecycle_status,
        "created_at": part.created_at.isoformat() if part.created_at else None,
        "updated_at": part.updated_at.isoformat() if part.updated_at else None,
    }


def listing_to_dict(listing: PartListing) -> dict:
    return {
        "id": str(listing.id),
        "supplier_id": str(listing.supplier_id),
        "supplier_name": listing.supplier.name if listing.supplier else None,
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
        query = query.filter(
            or_(Part.sku.ilike(pattern), Part.description.ilike(pattern))
        )

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
        description=body.description,
        manufacturer_name=body.manufacturer_name,
        category_id=_to_uuid(body.category_id) if body.category_id else None,
        sub_slug=derived_sub_slug,
        datasheet_url=body.datasheet_url,
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
            unit_price=Decimal(str(il.unit_price)) if il.unit_price is not None else Decimal("0"),
        )
        db.add(listing)

    db.commit()
    db.refresh(part)
    return part_to_dict(part, db)


@router.get("/{part_id}")
def get_part(part_id: str, db: Session = Depends(get_db)):
    part = db.query(Part).filter(Part.id == _to_uuid(part_id)).first()
    if not part:
        raise HTTPException(404, "Part not found")

    result = part_to_dict(part, db)
    result["listings"] = [listing_to_dict(l) for l in part.listings]
    return result


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

            part = Part(
                id=uuid.uuid4(),
                sku=item.sku,
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
                    unit_price=Decimal(str(item.unit_price)),
                )
                db.add(listing)
                db.flush()

            created += 1
        except Exception as e:
            db.rollback()
            errors.append({"row": idx, "error": str(e)})

    if created > 0:
        db.commit()

    return {"created": created, "errors": errors}
