from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from app.models import Category, Supplier, Part, PartListing


def search(db: Session, query: str) -> dict:
    """ILIKE search across category names, supplier names, and parts."""
    pattern = f"%{query}%"
    categories = (
        db.query(Category)
        .filter(Category.name.ilike(pattern))
        .limit(20)
        .all()
    )
    suppliers = (
        db.query(Supplier)
        .filter(Supplier.name.ilike(pattern))
        .limit(20)
        .all()
    )

    # Search parts by sku, description, and manufacturer_name
    parts_raw = (
        db.query(Part)
        .filter(
            or_(
                Part.sku.ilike(pattern),
                Part.description.ilike(pattern),
                Part.manufacturer_name.ilike(pattern),
            )
        )
        .order_by(Part.sku)
        .limit(20)
        .all()
    )

    parts = []
    for part in parts_raw:
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
        category_icon = None
        if part.category_id:
            cat = db.query(Category).filter(Category.id == part.category_id).first()
            if cat:
                category_icon = cat.icon
        parts.append({
            "id": part.id,
            "sku": part.sku,
            "description": part.description,
            "manufacturer_name": part.manufacturer_name,
            "lifecycle_status": part.lifecycle_status,
            "listings_count": listings_count or 0,
            "best_price": float(best_price_row) if best_price_row is not None else None,
            "category_icon": category_icon,
        })

    return {"categories": categories, "suppliers": suppliers, "parts": parts}
