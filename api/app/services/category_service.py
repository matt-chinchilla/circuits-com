from sqlalchemy import func
from sqlalchemy.orm import Session
from app.models import Category, CategorySupplier, Supplier, Sponsor, Part, PartListing


def get_all_categories(db: Session) -> list[Category]:
    """Top-level categories with children eager-loaded; stamps `parts_count`
    on each (own + child rows aggregated client-side from a single query).

    Test seed attaches parts to the subcategory, prod seed to the top-level —
    keeping the count keyed by `category_id` works for both.
    """
    cats = (
        db.query(Category)
        .filter(Category.parent_id.is_(None))
        .order_by(Category.sort_order)
        .all()
    )

    counts: dict = {
        row[0]: row[1]
        for row in db.query(Part.category_id, func.count(Part.id))
        .group_by(Part.category_id)
        .all()
    }

    for cat in cats:
        cat.parts_count = int(counts.get(cat.id, 0))
        for child in cat.children or []:
            child.parts_count = int(counts.get(child.id, 0))

    return cats


def _build_public_parts(db: Session, category_id, category_icon: str | None = None) -> list[dict]:
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
            "category_icon": category_icon,
        })

    return result


def _build_popular_parts(
    db: Session, parent_id, page: int = 1, per_page: int = 20
) -> dict:
    """Paginated rollup of parts across a parent category AND its immediate
    subcategories, ranked by aggregate stock across all listings.

    Powers the "Popular Parts" section on parent category pages. Designed to
    scale to thousands of parts — frontend pages through `per_page` rows at
    a time with Google-style numbered controls. The sort metric will
    eventually blend in click-count once analytics ship; the contract
    (most-popular first, paginated) stays stable.

    Returns a dict matching `PopularPartsPage` schema (items + meta).
    """
    page = max(1, page)
    per_page = max(1, min(per_page, 100))  # cap to prevent abuse

    # Self + immediate children (2-level tree only — matches the seed shape).
    cat_id_rows = (
        db.query(Category.id)
        .filter((Category.id == parent_id) | (Category.parent_id == parent_id))
        .all()
    )
    cat_ids = [row[0] for row in cat_id_rows]
    if not cat_ids:
        return {"items": [], "total": 0, "page": 1, "pages": 1, "per_page": per_page}

    total_stock = func.coalesce(func.sum(PartListing.stock_quantity), 0)

    base_query = (
        db.query(
            Part,
            total_stock.label("total_stock"),
            func.min(PartListing.unit_price).label("best_price"),
            func.count(PartListing.id).label("listings_count"),
        )
        .outerjoin(PartListing, PartListing.part_id == Part.id)
        .filter(Part.category_id.in_(cat_ids))
        .group_by(Part.id)
        .order_by(total_stock.desc(), Part.sku)
    )

    # Use a subquery for an accurate total when GROUP BY is involved
    total = (
        db.query(func.count(Part.id))
        .filter(Part.category_id.in_(cat_ids))
        .scalar()
    ) or 0
    pages = max(1, (total + per_page - 1) // per_page)
    offset = (page - 1) * per_page

    rows = base_query.offset(offset).limit(per_page).all()

    # Each part may live on a different subcategory — surface that subcat's
    # icon in the table for visual context.
    cat_icon_by_id: dict = {
        row[0]: row[1]
        for row in db.query(Category.id, Category.icon)
        .filter(Category.id.in_(cat_ids))
        .all()
    }

    items = [
        {
            "id": part.id,
            "sku": part.sku,
            "description": part.description,
            "manufacturer_name": part.manufacturer_name,
            "lifecycle_status": part.lifecycle_status,
            "listings_count": int(listings_count or 0),
            "best_price": float(best_price) if best_price is not None else None,
            "category_icon": cat_icon_by_id.get(part.category_id),
        }
        for part, _total_stock, best_price, listings_count in rows
    ]
    return {
        "items": items,
        "total": int(total),
        "page": page,
        "pages": pages,
        "per_page": per_page,
    }


def get_category_by_slug(
    db: Session, slug: str, popular_page: int = 1, popular_per_page: int = 20
) -> dict | None:
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
    parts = _build_public_parts(db, category.id, category.icon)

    # On a parent category page, surface a "Popular Parts" rollup spanning
    # all subcategories. Leaf pages skip this (their `parts` list IS the
    # source of truth for that category).
    if category.children:
        popular_parts = _build_popular_parts(
            db, category.id, page=popular_page, per_page=popular_per_page
        )
    else:
        popular_parts = {"items": [], "total": 0, "page": 1, "pages": 1, "per_page": popular_per_page}

    return {
        "category": category,
        "suppliers": suppliers,
        "sponsor": sponsor_data,
        "parts": parts,
        "popular_parts": popular_parts,
    }
