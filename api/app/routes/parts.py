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

class PartCreate(BaseModel):
    sku: str
    description: str | None = None
    manufacturer_name: str
    category_id: str | None = None
    datasheet_url: str | None = None
    lifecycle_status: str = "active"


class PartUpdate(BaseModel):
    sku: str | None = None
    description: str | None = None
    manufacturer_name: str | None = None
    category_id: str | None = None
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

def part_to_dict(part: Part) -> dict:
    return {
        "id": str(part.id),
        "sku": part.sku,
        "description": part.description,
        "manufacturer_name": part.manufacturer_name,
        "category_id": str(part.category_id) if part.category_id else None,
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
        "items": [part_to_dict(p) for p in items],
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
    part = Part(
        id=uuid.uuid4(),
        sku=body.sku,
        description=body.description,
        manufacturer_name=body.manufacturer_name,
        category_id=_to_uuid(body.category_id) if body.category_id else None,
        datasheet_url=body.datasheet_url,
        lifecycle_status=body.lifecycle_status,
    )
    db.add(part)
    db.commit()
    db.refresh(part)
    return part_to_dict(part)


@router.get("/{part_id}")
def get_part(part_id: str, db: Session = Depends(get_db)):
    part = db.query(Part).filter(Part.id == _to_uuid(part_id)).first()
    if not part:
        raise HTTPException(404, "Part not found")

    result = part_to_dict(part)
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
    return part_to_dict(part)


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
