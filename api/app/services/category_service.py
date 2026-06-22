from sqlalchemy import case, func, or_
from sqlalchemy.orm import Session

from app.models import Category, Part, PartListing, PriceBreak, Sponsor, Supplier


def _active_sponsor():
    """Visible-sponsor predicate: Active OR legacy NULL status (Paused/Expired
    are hidden). Must match the admin write-path block
    (`admin_sponsors._reject_if_slot_taken`) + migration 016's index predicate."""
    return or_(Sponsor.status == "Active", Sponsor.status.is_(None))


def _tier_order():
    """Order sponsorships by tier priority (Platinum > Gold > Silver) for the
    ranked per-category sponsor list. 'featured' was dropped 2026-06-11 — the
    tier-boards matrix maps the old top-level Featured onto Platinum."""
    t = func.lower(Sponsor.tier)
    return case(
        (t == "platinum", 0),
        (t == "gold", 1),
        (t == "silver", 2),
        else_=9,
    )


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

    # A category's preferred partners = its active SPONSORSHIPS (the `sponsors`
    # table is the single source of truth as of 2026-06-03 — Featured on a
    # top-level category, Platinum/Gold on a child). Ordered by tier then
    # recency; UNIQUE(supplier_id, category_id) means a supplier appears at most
    # once per category, so no dedup is needed.
    #   - `featured_list_by_cat`: ordered {id, name} list → PreferredPartnersBanner
    #     + the admin tree. Carries the supplier id (names collide — no unique).
    #   - `featured_by_cat`: legacy single name = `featured_suppliers[0].name`.
    featured_rows = (
        db.query(Sponsor.category_id, Supplier.id, Supplier.name)
        .join(Supplier, Supplier.id == Sponsor.supplier_id)
        .filter(Sponsor.category_id.isnot(None))
        .filter(_active_sponsor())
        .order_by(Sponsor.category_id, _tier_order(), Sponsor.created_at)
        .all()
    )
    featured_list_by_cat: dict = {}
    for cat_id, supplier_id, supplier_name in featured_rows:
        featured_list_by_cat.setdefault(cat_id, []).append(
            {"id": supplier_id, "name": supplier_name}
        )
    featured_by_cat: dict = {
        cat_id: entries[0]["name"] for cat_id, entries in featured_list_by_cat.items() if entries
    }

    for cat in cats:
        cat.parts_count = int(counts.get(cat.id, 0))
        cat.featured_supplier_name = featured_by_cat.get(cat.id)
        cat.featured_suppliers = featured_list_by_cat.get(cat.id, [])
        for child in cat.children or []:
            child.parts_count = int(counts.get(child.id, 0))
            child.featured_supplier_name = featured_by_cat.get(child.id)
            child.featured_suppliers = featured_list_by_cat.get(child.id, [])

    return cats


def _sponsor_board_dict(sponsor: Sponsor, supplier: Supplier | None) -> dict:
    """Shape a Sponsor + its joined Supplier into the SponsorResponse dict the
    boards consume. Carries every SponsorResponse field, including the board
    fields (logo_url/contact_role/coverage_hours/brand_*) pulled off the
    supplier. The /partners + /{slug} routes serialize this by hand (no
    response_model), so every field listed on SponsorResponse must be present.
    """
    return {
        "id": sponsor.id,
        "supplier_name": supplier.name if supplier else "",
        "image_url": sponsor.image_url,
        "description": sponsor.description,
        "tier": sponsor.tier,
        "website": supplier.website if supplier else None,
        "phone": supplier.phone if supplier else None,
        "email": supplier.email if supplier else None,
        "contact_name": supplier.contact_name if supplier else None,
        "logo_url": supplier.logo_url if supplier else None,
        "contact_role": supplier.contact_role if supplier else None,
        "coverage_hours": supplier.coverage_hours if supplier else None,
        "brand_primary": supplier.brand_primary if supplier else None,
        "brand_secondary": supplier.brand_secondary if supplier else None,
    }


def get_category_partners(db: Session, slug: str) -> dict | None:
    """The Platinum Category Sponsor board for the TOP-LEVEL category of `slug`.

    Resolves a child slug to its top-level ancestor (2-level tree: a child's
    `parent` IS the top level), so the same Platinum board shows on the parent
    page and every subpage. Returns the resolved top-level identity plus its
    single visible **Platinum** sponsor (newest-wins) as a rich `platinum` dict,
    or `None` for `platinum` when unsold (board → Open-Placement). Unknown slug
    → None (route → 404). (2026-06-11 tier-boards matrix — was a supplier list.)
    """
    category = db.query(Category).filter(Category.slug == slug).first()
    if not category:
        return None
    # A child's parent IS the top level (2-level tree). `.parent` is a single
    # lazy SELECT here (one object, not a loop) — not an N+1.
    top = category if category.parent_id is None else category.parent

    # Single visible Platinum sponsor. Single-occupancy is enforced on the write
    # path (`admin_sponsors._reject_if_slot_taken`, 409 BLOCK) + a Postgres partial
    # unique index (migration 016), so at most one is active; created_at.asc()
    # (oldest/incumbent wins, matching the block + migration-016 dedup) breaks any
    # legacy 2-active tie the same way the write side does. Top-level placements are
    # Platinum-only per the matrix, but tier-filter explicitly so a legacy/mis-
    # tiered row can't leak.
    # Sponsor + Supplier in ONE join (no N+1 — this is a category-page hot path).
    row = (
        db.query(Sponsor, Supplier)
        .join(Supplier, Supplier.id == Sponsor.supplier_id)
        .filter(
            Sponsor.category_id == top.id,
            func.lower(Sponsor.tier) == "platinum",
            _active_sponsor(),
        )
        .order_by(Sponsor.created_at.asc())
        .first()
    )
    platinum = _sponsor_board_dict(row[0], row[1]) if row else None

    return {"slug": top.slug, "name": top.name, "platinum": platinum}


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
    """Return category with sponsor and parts.

    The Preferred Partners banner is no longer built here (2026-06-04) — it is a
    TOP-LEVEL artifact served by `get_category_partners`. This returns only the
    single SponsorBlock `sponsor` (newest visible) plus parts.
    """
    category = db.query(Category).filter(Category.slug == slug).first()
    if not category:
        return None

    # The child's single Subcategory Sponsor slot → SponsorBlock. This is the
    # single visible **Gold** sponsor (tier-filtered — Silver rows populate the
    # directory below, not this slot). Single-occupancy is enforced on the write
    # path (`routes/admin_sponsors._reject_if_slot_taken`, 409 BLOCK) plus a
    # Postgres partial unique index (migration 016), so at most one Gold is active
    # per child. The visible-status filter (Active OR legacy NULL) MUST match that
    # block, else an admin marking the current sponsor Expired (deliberately
    # taking the slot down) would still surface it. Paused sponsors are hidden
    # too; created_at.asc() (oldest/incumbent wins, matching the write-side block +
    # migration 016) breaks any legacy 2-active tie consistently.
    # Sponsor + Supplier in ONE join (no N+1 — this is a category-page hot path).
    gold_row = (
        db.query(Sponsor, Supplier)
        .join(Supplier, Supplier.id == Sponsor.supplier_id)
        .filter(
            Sponsor.category_id == category.id,
            func.lower(Sponsor.tier) == "gold",
            _active_sponsor(),
        )
        .order_by(Sponsor.created_at.asc())
        .first()
    )
    sponsor_data = _sponsor_board_dict(gold_row[0], gold_row[1]) if gold_row else None

    # The Silver directory for this child (multi-occupant → SilverPartners).
    # Each shaped as a SupplierResponse dict (incl. the board contact_role).
    silver_rows = (
        db.query(Supplier)
        .join(Sponsor, Sponsor.supplier_id == Supplier.id)
        .filter(
            Sponsor.category_id == category.id,
            func.lower(Sponsor.tier) == "silver",
            _active_sponsor(),
        )
        .order_by(Sponsor.created_at)
        .all()
    )
    silver = [
        {
            "id": s.id,
            "name": s.name,
            "phone": s.phone,
            "website": s.website,
            "email": s.email,
            "contact_name": s.contact_name,
            "contact_role": s.contact_role,
            "description": s.description,
            "logo_url": s.logo_url,
        }
        for s in silver_rows
    ]

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
        "sponsor": sponsor_data,
        "silver": silver,
        "parts": parts,
        "popular_parts": popular_parts,
    }
