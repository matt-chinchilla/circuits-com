from sqlalchemy.orm import Session
from app.models import Category, Supplier


def search(db: Session, query: str) -> dict:
    """ILIKE search across category names and supplier names."""
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
    return {"categories": categories, "suppliers": suppliers}
