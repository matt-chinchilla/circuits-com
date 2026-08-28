from sqlalchemy import case, func, nullslast, or_
from sqlalchemy.orm import Session

from app.models import Category, Part, PartListing, PriceBreak, Sponsor, Supplier


def active_sponsor_filter():
    """Visible-sponsor predicate: Active OR legacy NULL status (Paused/Expired
    are hidden). Must match the admin write-path block
    (`admin_sponsors._reject_if_slot_taken`) + migration 016's index predicate."""
    return or_(Sponsor.status == "Active", Sponsor.status.is_(None))


# Tier priority ladder (Platinum > Gold > Silver), the single home shared with
# search_service's supplier-tier ranking. Ranking only — an unknown tier string
# still surfaces (normalized), it just sorts below the ladder (rank 9 at every
# consumer). 'featured' was dropped 2026-06-11 — the tier-boards matrix maps
# the old top-level Featured onto Platinum.
TIER_ORDER = {"platinum": 0, "gold": 1, "silver": 2}


def _tier_order():
    """Order sponsorships by TIER_ORDER for the ranked per-category list."""
    t = func.lower(Sponsor.tier)
    return case(*[(t == tier, rank) for tier, rank in TIER_ORDER.items()], else_=9)


def part_counts_by_category(db: Session, category_ids=None) -> dict:
    """category_id → part count, optionally restricted to `category_ids`.

    Test seed attaches parts to the subcategory, prod seed to the top-level —
    keeping the count keyed by `category_id` works for both; callers roll up
    own + children themselves.
    """
    query = db.query(Part.category_id, func.count(Part.id))
    if category_ids is not None:
        ids = list(category_ids)
        if not ids:
            return {}
        query = query.filter(Part.category_id.in_(ids))
    return {row[0]: int(row[1]) for row in query.group_by(Part.category_id).all()}


def get_all_categories(db: Session) -> list[Category]:
    """Top-level categories with children eager-loaded; stamps `parts_count`
    and `featured_supplier_name` on each (own + child rows aggregated
    client-side from batched queries — two queries total, no N+1).
    """
    cats = (
        db.query(Category).filter(Category.parent_id.is_(None)).order_by(Category.sort_order).all()
    )

    counts = part_counts_by_category(db)

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
        .filter(active_sponsor_filter())
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
        cat.parts_count = counts.get(cat.id, 0)
        cat.featured_supplier_name = featured_by_cat.get(cat.id)
        cat.featured_suppliers = featured_list_by_cat.get(cat.id, [])
        for child in cat.children or []:
            child.parts_count = counts.get(child.id, 0)
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
        "brand_primary": sponsor.brand_primary or (supplier.brand_primary if supplier else None),
        "brand_secondary": sponsor.brand_secondary
        or (supplier.brand_secondary if supplier else None),
        "brand_takeover": bool(sponsor.brand_primary or sponsor.brand_secondary),
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
            active_sponsor_filter(),
        )
        .order_by(Sponsor.created_at.asc())
        .first()
    )
    platinum = _sponsor_board_dict(row[0], row[1]) if row else None

    return {"slug": top.slug, "name": top.name, "platinum": platinum}


# ── The public parts block ──────────────────────────────────────────────────
# ONE block, scope-aware: a LEAF serves its own parts, a PARENT serves the
# rollup over itself plus its immediate children.
#
# Until this rework the page asked for 500 rows in one request and did the
# filtering, sorting and paging in the browser. At 200k+ parts that silently
# truncated 27 of 28 top-level categories and 127 of 189 leaves — Connectors
# rendered 500 of 39,353 — and the header count lied about the rest. The
# tripwire written to watch for exactly this (tests/test_category_size_
# tripwire.py, and the Deferred section of the 2026-06-07 category-performance
# spec that pre-approved the rework) had fired.
DEFAULT_PARTS_PER_PAGE = 25

# The 500 ceiling died with the model that needed it. 100 is a page a browser
# can render, and it is enforced in BOTH layers on purpose: `le=` on the
# route's Query, so an over-large ask is a 422 the caller can see rather than a
# silent clamp, and the min() below, so no internal caller can route around it.
MAX_PARTS_PER_PAGE = 100


class UnknownSort(ValueError):
    """A sort token this category cannot serve → 422 ``unknown_sort``.

    Covers 'popular' and 'sub' asked of a LEAF as well as a typo: both are
    rollup orderings and a leaf has nothing to roll up. Answering those with a
    silent fallback would leave the page's sort control claiming a state the
    server never entered.
    """


class UnknownSortDirection(ValueError):
    """``dir`` was neither asc nor desc → 422 ``unknown_dir``."""


# Direct-column sorts. The four price tokens read the DENORMALIZED columns
# migration 046 put on `parts` — which is the whole reason a price sort can
# happen in the database at all. qty1 is the unit price; qty10/qty100/qty1k are
# the 10/100/1000 rungs of the ladders behind it.
_SORT_COLUMNS = {
    "sku": Part.sku,
    "desc": Part.description,
    "mfg": Part.manufacturer_name,
    "sub": Part.sub_slug,
    "qty1": Part.best_price,
    "qty10": Part.best_price_10,
    "qty100": Part.best_price_100,
    "qty1k": Part.best_price_1000,
}

# Nullable sort columns sink their NULLs to the BOTTOM in BOTH directions.
# For the prices that is a deliberate, documented improvement on the browser
# sort it replaces: JS put `undefined` FIRST on an ascending sort, so "cheapest
# first" opened on a wall of parts carrying no price at all. A missing price is
# not a price of zero, and it is never the answer to "show me the cheapest".
_NULLS_LAST_SORTS = frozenset({"desc", "sub", "qty1", "qty10", "qty100", "qty1k"})

# Orderings that only exist across a rollup.
_PARENT_ONLY_SORTS = frozenset({"popular", "sub"})

_SORT_TOKENS = frozenset({*_SORT_COLUMNS, "popular"})


def resolve_sort(sort: str | None, direction: str | None, is_parent: bool) -> tuple[str, bool]:
    """``(token, descending)`` for this scope, or raise.

    The DEFAULT differs by scope on purpose. A leaf opens on ``sku`` asc — a
    stable, scannable list. A parent opens on ``popular``, which is the
    ordering `_build_popular_parts` was designed around and which the old
    client-side re-sort destroyed the moment the rows arrived.

    An ABSENT ``dir`` follows the sort rather than a blanket "asc": popular
    means total stock DESCENDING — most-stocked first is the whole idea, and
    an ascending default would open every parent page on the parts nobody has.
    An EXPLICIT ``dir=asc`` still inverts it; the default is a default, not a
    lock.
    """
    if direction is not None and direction not in ("asc", "desc"):
        raise UnknownSortDirection(direction)
    token = (sort or "").strip() or ("popular" if is_parent else "sku")
    if token not in _SORT_TOKENS or (not is_parent and token in _PARENT_ONLY_SORTS):
        raise UnknownSort(token)
    if direction is None:
        direction = "desc" if token == "popular" else "asc"
    return token, direction == "desc"


def _escape_like(term: str) -> str:
    """Neutralize LIKE wildcards so a literal % or _ in a SKU matches itself."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _filter_clauses(q: str | None, manufacturers, subs) -> dict:
    """The three filters, kept SEPARATE rather than pre-ANDed into one list.

    Faceted search computes each option list with every filter EXCEPT its own
    applied — otherwise picking a manufacturer collapses the manufacturer list
    to the one you picked and there is no way back to the others. Keeping the
    clauses apart is what makes "all of them but mine" expressible; a single
    pre-ANDed WHERE cannot express it.

    An ABSENT filter is unfiltered — an empty ``mfg``/``sub`` list is not "match
    nothing".
    """
    clauses: dict[str, object] = {"q": None, "mfg": None, "sub": None}
    term = (q or "").strip()
    if term:
        # The page's one search box matches BOTH columns, which is what a
        # buyer means by "search this category": part numbers and prose.
        pattern = f"%{_escape_like(term)}%"
        clauses["q"] = or_(
            Part.sku.ilike(pattern, escape="\\"),
            Part.description.ilike(pattern, escape="\\"),
        )
    names = [name for name in (manufacturers or []) if name]
    if names:
        clauses["mfg"] = Part.manufacturer_name.in_(names)
    slugs = [slug for slug in (subs or []) if slug]
    if slugs:
        # SLUGS, never names — `sub_slug` is the denormalized child slug, and
        # the facet hands the client exactly these values back.
        clauses["sub"] = Part.sub_slug.in_(slugs)
    return clauses


def _except(clauses: dict, own: str) -> list:
    """Every filter clause except `own` — the faceted-search rule, one place."""
    return [clause for key, clause in clauses.items() if key != own and clause is not None]


def _order_terms(token: str, descending: bool, total_stock=None) -> list:
    """ORDER BY for a resolved sort token.

    Always ends with a unique column so paging is deterministic: two parts with
    the same price (or the same stock, or no stock at all) must not be able to
    swap places between page 1 and page 2 and hide one of themselves.
    """
    if token == "popular":
        primary = total_stock.desc() if descending else total_stock.asc()
        return [primary, Part.sku.asc(), Part.id.asc()]
    column = _SORT_COLUMNS[token]
    primary = column.desc() if descending else column.asc()
    if token in _NULLS_LAST_SORTS:
        primary = nullslast(primary)
    tail = [Part.id.asc()] if token == "sku" else [Part.sku.asc(), Part.id.asc()]
    return [primary, *tail]


def _price(value) -> float | None:
    return float(value) if value is not None else None


def _build_facets(db: Session, scope, clauses: dict, children: list, is_parent: bool) -> dict:
    """Option lists for the page's filter controls, plus the unfiltered total.

    `total_unfiltered` is what the category HOLDS; the block's `total` is what
    the current filters left. The page shows both ("312 of 39,353"), which is
    the honesty the 500-row truncation could not offer.
    """
    total_unfiltered = int(db.query(func.count(Part.id)).filter(scope).scalar() or 0)

    mfg_count = func.count(Part.id)
    manufacturers = [
        {"name": row[0], "count": int(row[1])}
        for row in (
            db.query(Part.manufacturer_name, mfg_count)
            .filter(scope, *_except(clauses, "mfg"))
            .group_by(Part.manufacturer_name)
            .order_by(mfg_count.desc(), Part.manufacturer_name.asc())
            .all()
        )
        if row[0]
    ]

    subs: list[dict] = []
    if is_parent:
        # Names come off the children already loaded for the response — no
        # query. A sub_slug with no matching child (denormalized data can
        # outlive a rename) still surfaces, labelled by its own slug, rather
        # than vanishing from a list the client filters by.
        name_by_slug = {child.slug: child.name for child in children}
        sub_count = func.count(Part.id)
        subs = [
            {"slug": row[0], "name": name_by_slug.get(row[0], row[0]), "count": int(row[1])}
            for row in (
                db.query(Part.sub_slug, sub_count)
                .filter(scope, Part.sub_slug.isnot(None), *_except(clauses, "sub"))
                .group_by(Part.sub_slug)
                .order_by(sub_count.desc(), Part.sub_slug.asc())
                .all()
            )
        ]

    return {
        "total_unfiltered": total_unfiltered,
        "manufacturers": manufacturers,
        "subs": subs,
    }


def _build_public_parts(
    db: Session,
    category: Category,
    *,
    page: int = 1,
    per_page: int = DEFAULT_PARTS_PER_PAGE,
    q: str | None = None,
    manufacturers=(),
    subs=(),
    sort: str | None = None,
    direction: str | None = None,
) -> dict:
    """One filtered, sorted, counted page of this category's parts.

    Returns the `PartsPage` fields plus a `facets` entry, which
    `get_category_by_slug` lifts to the TOP LEVEL of the response — they are
    computed here because they share this function's scope and filters, but
    they describe the category rather than the page of rows.
    """
    children = list(category.children or [])
    is_parent = bool(children)
    token, descending = resolve_sort(sort, direction, is_parent)

    per_page = max(1, min(per_page, MAX_PARTS_PER_PAGE))
    # A parent rolls up self + immediate children (2-level tree — the same
    # scope `_build_popular_parts` has always used).
    scope = Part.category_id.in_([category.id, *[child.id for child in children]])

    # `sub` is a rollup filter. A leaf's parts all carry the one sub_slug and
    # its facet list is empty, so an option the page can never offer there must
    # not be able to empty the page either.
    clauses = _filter_clauses(q, manufacturers, subs if is_parent else ())
    applied = [clause for clause in clauses.values() if clause is not None]

    total = int(db.query(func.count(Part.id)).filter(scope, *applied).scalar() or 0)
    pages = max(1, (total + per_page - 1) // per_page)
    page = max(1, min(page, pages))

    # Explicit COLUMNS, not ORM entities: `Part.listings` is lazy="selectin",
    # so `db.query(Part)` fires a second query hydrating every listing (and,
    # through them, price breaks) for every row on the page — none of which
    # this response reads. Four of those columns are the denormalized prices,
    # so the display values are a column read now instead of the four batched
    # aggregate queries this function used to run per page.
    query = db.query(
        Part.id,
        Part.sku,
        Part.description,
        Part.manufacturer_name,
        Part.lifecycle_status,
        Part.best_price,
        Part.best_price_10,
        Part.best_price_100,
        Part.best_price_1000,
        Part.category_id,
        Part.sub_slug,
    ).filter(scope, *applied)

    if token == "popular":
        total_stock = func.coalesce(func.sum(PartListing.stock_quantity), 0)
        query = (
            query.outerjoin(PartListing, PartListing.part_id == Part.id)
            .group_by(Part.id)
            .order_by(*_order_terms(token, descending, total_stock))
        )
    else:
        query = query.order_by(*_order_terms(token, descending))

    rows = query.offset((page - 1) * per_page).limit(per_page).all()

    # Each row may live on a different subcategory — surface that subcat's own
    # icon. Built from the children already loaded for the response: no query.
    icon_by_cat = {category.id: category.icon}
    icon_by_cat.update({child.id: child.icon for child in children})

    part_ids = [row.id for row in rows]
    listing_counts: dict = {}
    if part_ids:
        # The one batched per-page query left. A 25-row IN list is cheap, and
        # the count is not a price so it has no denormalized column.
        listing_counts = {
            row[0]: int(row[1])
            for row in db.query(PartListing.part_id, func.count(PartListing.id))
            .filter(PartListing.part_id.in_(part_ids))
            .group_by(PartListing.part_id)
            .all()
        }

    items = [
        {
            "id": row.id,
            "sku": row.sku,
            "description": row.description,
            "manufacturer_name": row.manufacturer_name,
            "lifecycle_status": row.lifecycle_status,
            "listings_count": listing_counts.get(row.id, 0),
            "best_price": _price(row.best_price),
            "best_price_10": _price(row.best_price_10),
            "best_price_100": _price(row.best_price_100),
            "best_price_1000": _price(row.best_price_1000),
            "category_icon": _icon_str(icon_by_cat.get(row.category_id)),
            "sub_slug": row.sub_slug,
        }
        for row in rows
    ]

    return {
        "items": items,
        "total": total,
        "page": page,
        "pages": pages,
        "per_page": per_page,
        "facets": _build_facets(db, scope, clauses, children, is_parent),
    }


def _icon_str(value) -> str | None:
    return str(value) if value is not None else None


def _build_popular_parts(db: Session, parent_id, page: int = 1, per_page: int = 20) -> dict:
    """Paginated rollup of parts across a parent category AND its immediate
    subcategories, ranked by aggregate stock across all listings.

    Powers the "Popular Parts" section on parent category pages. Designed to
    scale to thousands of parts — frontend pages through `per_page` rows at
    a time with Google-style numbered controls. The sort metric will
    eventually blend in click-count once analytics ship; the contract
    (most-popular first, paginated) stays stable.

    Returns a dict matching `PopularPartsPage` schema (items + meta).

    LEGACY as of 2026-08-27, and deliberately UNCHANGED. The `parts` block
    above is scope-aware now — a parent's page rolls up self + children, sorted
    by this same stock metric by default — so the page asks for
    popular_page=1&popular_per_page=1 and ignores what comes back. This
    function keeps its exact behaviour (shape, stock-DESC ordering, pagination,
    the per-page aggregate queries) because test_category_hierarchy pins it and
    because a retired block that also changes is two migrations at once. Add
    nothing here; the block above is where the parts list lives.
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
    parts_per_page: int = DEFAULT_PARTS_PER_PAGE,
    q: str | None = None,
    manufacturers=(),
    subs=(),
    sort: str | None = None,
    direction: str | None = None,
) -> dict | None:
    """Return category with sponsor and parts.

    The Preferred Partners banner is no longer built here (2026-06-04) — it is a
    TOP-LEVEL artifact served by `get_category_partners`. This returns only the
    single SponsorBlock `sponsor` (newest visible) plus parts.

    The `parts` block is the scope-aware one (leaf = own, parent = rollup) and
    carries the query params through to it. Raises `UnknownSort` /
    `UnknownSortDirection` for a token this category cannot serve — the route
    turns both into a 422 — but only AFTER the slug resolves, so an unknown
    slug is still a 404 whatever else the query string says.
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
            active_sponsor_filter(),
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
            active_sponsor_filter(),
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

    parts = _build_public_parts(
        db,
        category,
        page=parts_page,
        per_page=parts_per_page,
        q=q,
        manufacturers=manufacturers,
        subs=subs,
        sort=sort,
        direction=direction,
    )
    # The facets ride out of the builder with the page they were computed
    # alongside (one pass over one scope), but they sit at the TOP LEVEL of
    # the response beside `parts`, not inside it: they describe the CATEGORY,
    # and the block itself keeps the plain PartsPage shape it shares with the
    # legacy `popular_parts`.
    facets = parts.pop("facets")

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

    # Child/sibling count pills. Only get_all_categories stamped parts_count,
    # so this response served the schema default 0 for every child — the chip
    # rows and SubcatSheet on a LEAF page (whose facet sub list is empty by
    # design: a leaf has no sub filter) had no real number to fall back on.
    family = list(category.children)
    if category.parent is not None:
        family.extend(category.parent.children)
    if family:
        counts = part_counts_by_category(db, [c.id for c in family])
        for child in family:
            child.parts_count = counts.get(child.id, 0)

    return {
        "category": category,
        "sponsor": sponsor_data,
        "silver": silver,
        "parts": parts,
        "popular_parts": popular_parts,
        "facets": facets,
    }
