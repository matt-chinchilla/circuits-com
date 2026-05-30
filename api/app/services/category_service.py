from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Category, CategorySupplier, Part, PartListing, PriceBreak, Sponsor, Supplier


def get_all_categories(db: Session) -> list[Category]:
    """Top-level categories with children eager-loaded; stamps `parts_count`
    and `featured_supplier_name` on each (own + child rows aggregated
    client-side from batched queries — two queries total, no N+1).

    Test seed attaches parts to the subcategory, prod seed to the top-level —
    keeping the count keyed by `category_id` works for both.
    """
    cats = (
        db.query(Category).filter(Category.parent_id.is_(None)).order_by(Category.sort_order).all()
    )

    counts: dict = {
        row[0]: row[1]
        for row in db.query(Part.category_id, func.count(Part.id)).group_by(Part.category_id).all()
    }

    # Featured supplier per category — lowest rank among is_featured=true rows
    # wins. ORDER BY rank DESC so the dict-comprehension's last-write semantics
    # leave the highest-priority (lowest-rank) name in place. Single join.
    featured_rows = (
        db.query(CategorySupplier.category_id, Supplier.name, CategorySupplier.rank)
        .join(Supplier, Supplier.id == CategorySupplier.supplier_id)
        .filter(CategorySupplier.is_featured.is_(True))
        .order_by(CategorySupplier.rank.desc())
        .all()
    )
    featured_by_cat: dict = {row[0]: row[1] for row in featured_rows}

    for cat in cats:
        cat.parts_count = int(counts.get(cat.id, 0))
        cat.featured_supplier_name = featured_by_cat.get(cat.id)
        for child in cat.children or []:
            child.parts_count = int(counts.get(child.id, 0))
            child.featured_supplier_name = featured_by_cat.get(child.id)

    return cats


def _build_public_parts(
    db: Session,
    category_id,
    category_icon: str | None = None,
    page: int = 1,
    per_page: int = 15,
) -> dict:
    """Paginated parts for a leaf category with per-tier best prices."""
    per_page = min(per_page, 500)
    total = (db.query(func.count(Part.id)).filter(Part.category_id == category_id).scalar()) or 0
    pages = max(1, (total + per_page - 1) // per_page)
    page = max(1, min(page, pages))

    parts = (
        db.query(Part)
        .filter(Part.category_id == category_id)
        .order_by(Part.sku)
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )

    part_ids = [p.id for p in parts]
    if not part_ids:
        return {"items": [], "total": total, "page": page, "pages": pages, "per_page": per_page}

    listing_stats = {
        row[0]: row[1]
        for row in db.query(PartListing.part_id, func.count(PartListing.id))
        .filter(PartListing.part_id.in_(part_ids))
        .group_by(PartListing.part_id)
        .all()
    }

    base_prices = {
        row[0]: row[1]
        for row in db.query(PartListing.part_id, func.min(PartListing.unit_price))
        .filter(PartListing.part_id.in_(part_ids))
        .group_by(PartListing.part_id)
        .all()
    }

    tier_prices: dict[str, dict[int, float | None]] = {}
    for qty in (10, 100, 1000):
        rows = (
            db.query(
                PartListing.part_id,
                func.min(PriceBreak.unit_price),
            )
            .join(PriceBreak, PriceBreak.listing_id == PartListing.id)
            .filter(
                PartListing.part_id.in_(part_ids),
                PriceBreak.min_quantity == qty,
            )
            .group_by(PartListing.part_id)
            .all()
        )
        for row in rows:
            pid_str = str(row[0])
            price_val = row[1]
            tier_prices.setdefault(pid_str, {})[qty] = (
                float(price_val) if price_val is not None else None
            )

    items = []
    for part in parts:
        pid = str(part.id)
        bp = base_prices.get(part.id)
        tp = tier_prices.get(pid, {})
        items.append(
            {
                "id": part.id,
                "sku": part.sku,
                "description": part.description,
                "manufacturer_name": part.manufacturer_name,
                "lifecycle_status": part.lifecycle_status,
                "listings_count": listing_stats.get(part.id, 0),
                "best_price": float(bp) if bp is not None else None,
                "best_price_10": tp.get(10),
                "best_price_100": tp.get(100),
                "best_price_1000": tp.get(1000),
                "category_icon": category_icon,
                "sub_slug": part.sub_slug,
            }
        )

    return {
        "items": items,
        "total": total,
        "page": page,
        "pages": pages,
        "per_page": per_page,
    }


def _build_popular_parts(db: Session, parent_id, page: int = 1, per_page: int = 20) -> dict:
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
    per_page = max(1, min(per_page, 500))  # cap to prevent abuse

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
    total = (db.query(func.count(Part.id)).filter(Part.category_id.in_(cat_ids)).scalar()) or 0
    pages = max(1, (total + per_page - 1) // per_page)
    offset = (page - 1) * per_page

    rows = base_query.offset(offset).limit(per_page).all()

    # Each part may live on a different subcategory — surface that subcat's
    # icon in the table for visual context.
    cat_icon_by_id: dict = {
        row[0]: row[1]
        for row in db.query(Category.id, Category.icon).filter(Category.id.in_(cat_ids)).all()
    }

    part_ids = [part.id for part, _, _, _ in rows]
    tier_prices: dict[str, dict[int, float | None]] = {}
    for qty in (10, 100, 1000):
        tier_rows = (
            db.query(
                PartListing.part_id,
                func.min(PriceBreak.unit_price),
            )
            .join(PriceBreak, PriceBreak.listing_id == PartListing.id)
            .filter(
                PartListing.part_id.in_(part_ids),
                PriceBreak.min_quantity == qty,
            )
            .group_by(PartListing.part_id)
            .all()
        )
        for row in tier_rows:
            pid_str = str(row[0])
            price_val = row[1]
            tier_prices.setdefault(pid_str, {})[qty] = (
                float(price_val) if price_val is not None else None
            )

    items = [
        {
            "id": part.id,
            "sku": part.sku,
            "description": part.description,
            "manufacturer_name": part.manufacturer_name,
            "lifecycle_status": part.lifecycle_status,
            "listings_count": int(listings_count or 0),
            "best_price": float(best_price) if best_price is not None else None,
            "best_price_10": tier_prices.get(str(part.id), {}).get(10),
            "best_price_100": tier_prices.get(str(part.id), {}).get(100),
            "best_price_1000": tier_prices.get(str(part.id), {}).get(1000),
            "category_icon": cat_icon_by_id.get(part.category_id),
            "sub_slug": part.sub_slug,
        }
        for part, _, best_price, listings_count in rows
    ]
    return {
        "items": items,
        "total": int(total),
        "page": page,
        "pages": pages,
        "per_page": per_page,
    }


def get_category_by_slug(
    db: Session,
    slug: str,
    popular_page: int = 1,
    popular_per_page: int = 20,
    parts_page: int = 1,
    parts_per_page: int = 20,
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

    # Get sponsor for this category — newest wins, so an admin adding a fresh
    # sponsor supersedes an older one on the same category (a category can hold
    # more than one Sponsor row; the public block shows the most recently added).
    sponsor = (
        db.query(Sponsor)
        .filter(Sponsor.category_id == category.id)
        .order_by(Sponsor.created_at.desc())
        .first()
    )
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
            "email": sponsor_supplier.email if sponsor_supplier else None,
            "contact_name": sponsor_supplier.contact_name if sponsor_supplier else None,
        }

    icon_val = getattr(category, "icon", None)
    icon_str = str(icon_val) if icon_val is not None else None
    parts = _build_public_parts(
        db,
        category.id,
        icon_str,
        page=parts_page,
        per_page=parts_per_page,
    )

    # On a parent category page, surface a "Popular Parts" rollup spanning
    # all subcategories. Leaf pages skip this (their `parts` list IS the
    # source of truth for that category).
    if category.children:
        popular_parts = _build_popular_parts(
            db, category.id, page=popular_page, per_page=popular_per_page
        )
    else:
        popular_parts = {
            "items": [],
            "total": 0,
            "page": 1,
            "pages": 1,
            "per_page": popular_per_page,
        }

    return {
        "category": category,
        "suppliers": suppliers,
        "sponsor": sponsor_data,
        "parts": parts,
        "popular_parts": popular_parts,
    }
