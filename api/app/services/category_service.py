from sqlalchemy import func
from sqlalchemy.orm import Session
from app.models import Category, CategorySupplier, Supplier, Sponsor, Part, PartListing


def get_all_categories(db: Session) -> list[Category]:
    """Return top-level categories with children eager-loaded."""
    return (
        db.query(Category)
        .filter(Category.parent_id.is_(None))
        .order_by(Category.sort_order)
        .all()
    )


def _build_public_parts(db: Session, category_id) -> list[dict]:
    """Query parts for a category with listings_count and best_price."""
    parts = (
        db.query(Part)
        .filter(Part.category_id == category_id)
        .order_by(Part.sku)
        .limit(50)
        .all()
    )

    result = []
    for part in parts:
        listings_count = (
            db.query(func.count(PartListing.id))
            .filter(PartListing.part_id == part.id)
            .scalar()
        )
        best_price_row = (
            db.query(func.min(PartListing.unit_price))
            .filter(PartListing.part_id == part.id)
            .scalar()
        )
        result.append({
            "id": part.id,
            "sku": part.sku,
            "description": part.description,
            "manufacturer_name": part.manufacturer_name,
            "lifecycle_status": part.lifecycle_status,
            "listings_count": listings_count or 0,
            "best_price": float(best_price_row) if best_price_row is not None else None,
        })

    return result


def get_category_by_slug(db: Session, slug: str) -> dict | None:
    """Return category with suppliers, sponsor, and parts."""
    category = db.query(Category).filter(Category.slug == slug).first()
    if not category:
        return None

    # Get suppliers for this category via CategorySupplier join
    supplier_rows = (
        db.query(Supplier, CategorySupplier.is_featured, CategorySupplier.rank)
        .join(CategorySupplier, CategorySupplier.supplier_id == Supplier.id)
        .filter(CategorySupplier.category_id == category.id)
        .order_by(CategorySupplier.rank)
        .all()
    )

    suppliers = []
    for supplier, is_featured, rank in supplier_rows:
        supplier.is_featured = is_featured
        supplier.rank = rank
        suppliers.append(supplier)

    # Get sponsor for this category
    sponsor = db.query(Sponsor).filter(Sponsor.category_id == category.id).first()
    sponsor_data = None
    if sponsor:
        sponsor_supplier = db.query(Supplier).filter(Supplier.id == sponsor.supplier_id).first()
        sponsor_data = {
            "id": sponsor.id,
            "supplier_name": sponsor_supplier.name if sponsor_supplier else "",
            "image_url": sponsor.image_url,
            "description": sponsor.description,
            "tier": sponsor.tier,
            "website": sponsor_supplier.website if sponsor_supplier else None,
            "phone": sponsor_supplier.phone if sponsor_supplier else None,
        }

    # Get parts for this category
    parts = _build_public_parts(db, category.id)

    return {
        "category": category,
        "suppliers": suppliers,
        "sponsor": sponsor_data,
        "parts": parts,
    }
