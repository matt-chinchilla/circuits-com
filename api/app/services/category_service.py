from sqlalchemy.orm import Session
from app.models import Category, CategorySupplier, Supplier, Sponsor


def get_all_categories(db: Session) -> list[Category]:
    """Return top-level categories with children eager-loaded."""
    return (
        db.query(Category)
        .filter(Category.parent_id.is_(None))
        .order_by(Category.sort_order)
        .all()
    )


def get_category_by_slug(db: Session, slug: str) -> dict | None:
    """Return category with suppliers and sponsor."""
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

    return {
        "category": category,
        "suppliers": suppliers,
        "sponsor": sponsor_data,
    }
