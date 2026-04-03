import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas import SupplierResponse
from app.models import Supplier, Part, PartListing, Revenue, CategorySupplier, Category, User
from app.services.auth_service import get_current_user

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
    description: str | None = None


class SupplierUpdate(BaseModel):
    name: str | None = None
    phone: str | None = None
    website: str | None = None
    email: str | None = None
    description: str | None = None


def supplier_to_dict(supplier: Supplier) -> dict:
    return {
        "id": str(supplier.id),
        "name": supplier.name,
        "phone": supplier.phone,
        "website": supplier.website,
        "email": supplier.email,
        "description": supplier.description,
        "logo_url": supplier.logo_url,
    }


@router.get("/", response_model=list[SupplierResponse])
def list_suppliers(db: Session = Depends(get_db)):
    return db.query(Supplier).order_by(Supplier.name).all()


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
        description=body.description,
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
        db.query(func.count(PartListing.id))
        .filter(PartListing.supplier_id == supplier.id)
        .scalar() or 0
    )
    revenue_total = (
        db.query(func.sum(Revenue.amount))
        .filter(Revenue.supplier_id == supplier.id)
        .scalar() or 0
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
