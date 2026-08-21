"""Search v2 — the live search surface behind GET /api/search/ (spec §1.3).

Four sections (parts / categories / suppliers / manufacturers), every
derived part field from BATCHED queries over the collected ids (the v1
per-part N+1 is gone), and a zero-result fuzzy recovery computed only when a
page-level search asks for it (suggest=1) — the dropdown's debounced calls
pass suggest=0 and never pay.

Also home to the derived public manufacturers list (§1.4): names + counts
grouped from parts.manufacturer_name, 600s in-process TTL cache. The
Leads-CRM tables are never read by anything in this module.
"""

import re
import time
from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, aliased, raiseload

from app.models import Category, Part, PartListing, PriceBreak, Sponsor, Supplier
from app.services.search_suggest import closest_score, did_you_mean

PARTS_LIMIT = 20
SECTION_LIMIT = 12
CLOSEST_LIMIT = 15
CLOSEST_POOL_CAP = 400

# Ranking only — an unknown tier string still surfaces (normalized), it just
# sorts below the known ladder.
_TIER_RANK = {"platinum": 0, "gold": 1, "silver": 2}


# ── Supplier tier (shared by the search hits AND the suppliers listing) ─────


def get_active_supplier_tiers(
    db: Session, supplier_ids: Iterable[UUID] | None = None
) -> dict[UUID, str]:
    """supplier_id → highest ACTIVE sponsorship tier, normalized lowercase.

    Active means status == 'Active' OR status IS NULL (legacy seed omits
    status — NULL counts as active everywhere, per the standing gotcha), and
    tier casing is normalized server-side (admin writes TitleCase, legacy
    rows are lowercase). One home so the search supplier hits and the public
    suppliers listing can never disagree on what "platinum" means.
    """
    query = db.query(Sponsor.supplier_id, Sponsor.tier).filter(
        or_(Sponsor.status == "Active", Sponsor.status.is_(None))
    )
    if supplier_ids is not None:
        ids = list(supplier_ids)
        if not ids:
            return {}
        query = query.filter(Sponsor.supplier_id.in_(ids))
    best: dict[UUID, tuple[int, str]] = {}
    for supplier_id, tier in query.all():
        normalized = (tier or "").strip().lower()
        if not normalized:
            continue
        rank = _TIER_RANK.get(normalized, 9)
        current = best.get(supplier_id)
        if current is None or rank < current[0]:
            best[supplier_id] = (rank, normalized)
    return {supplier_id: pair[1] for supplier_id, pair in best.items()}


# ── Derived public manufacturers (§1.4) ─────────────────────────────────────

_MANUFACTURERS_TTL_SECONDS = 600.0
_manufacturers_cache: tuple[float, list[dict]] | None = None


def _now() -> float:
    """Clock seam — tests monkeypatch this to expire the cache."""
    return time.monotonic()


def get_public_manufacturers(db: Session) -> list[dict]:
    """[{name, parts_count}, …] grouped from parts.manufacturer_name,
    count-desc (name-asc tiebreak), cached in-process for 600s."""
    global _manufacturers_cache
    cached = _manufacturers_cache
    if cached is not None and _now() - cached[0] < _MANUFACTURERS_TTL_SECONDS:
        return cached[1]
    rows = (
        db.query(Part.manufacturer_name, func.count(Part.id))
        .filter(Part.manufacturer_name.isnot(None), Part.manufacturer_name != "")
        .group_by(Part.manufacturer_name)
        .order_by(func.count(Part.id).desc(), Part.manufacturer_name.asc())
        .all()
    )
    data = [{"name": name, "parts_count": int(count)} for name, count in rows]
    _manufacturers_cache = (_now(), data)
    return data


def clear_public_manufacturers_cache() -> None:
    """Reset seam — wired into an autouse conftest fixture so one test's
    catalog can never leak into the next suite's vocabulary."""
    global _manufacturers_cache
    _manufacturers_cache = None


# ── Batched SearchPart enrichment ───────────────────────────────────────────


def _build_search_parts(db: Session, parts: list[Part]) -> list[dict]:
    """Rows → SearchPart dicts via three batched queries over the collected
    ids (listing aggregates, MOQ, category slugs) — never per-row."""
    if not parts:
        return []
    part_ids = [p.id for p in parts]

    # dist_count is COUNT(DISTINCT supplier_id): a (part, supplier) pair can
    # hold two listing rows, and a raw count would double-count the supplier.
    listing_agg = {
        row[0]: row
        for row in db.query(
            PartListing.part_id,
            func.count(func.distinct(PartListing.supplier_id)),
            func.sum(PartListing.stock_quantity),
            func.min(PartListing.unit_price),
        )
        .filter(PartListing.part_id.in_(part_ids))
        .group_by(PartListing.part_id)
        .all()
    }

    moqs = {
        row[0]: int(row[1])
        for row in db.query(PartListing.part_id, func.min(PriceBreak.min_quantity))
        .join(PriceBreak, PriceBreak.listing_id == PartListing.id)
        .filter(PartListing.part_id.in_(part_ids))
        .group_by(PartListing.part_id)
        .all()
        if row[1] is not None
    }

    category_ids = {p.category_id for p in parts if p.category_id is not None}
    categories: dict = {}
    if category_ids:
        parent = aliased(Category)
        for cat_id, icon, slug, parent_slug in (
            db.query(Category.id, Category.icon, Category.slug, parent.slug)
            .outerjoin(parent, Category.parent_id == parent.id)
            .filter(Category.id.in_(category_ids))
            .all()
        ):
            categories[cat_id] = (icon, slug, parent_slug)

    out = []
    for p in parts:
        agg = listing_agg.get(p.id)
        icon, slug, parent_slug = categories.get(p.category_id, (None, None, None))
        out.append(
            {
                "id": str(p.id),
                "sku": p.sku,
                # slug is non-null in the contract; legacy rows without one
                # fall back to the id (the part page takes either form).
                "slug": p.slug or str(p.id),
                "description": p.description,
                "manufacturer_name": p.manufacturer_name,
                "package": p.package,
                "mount": p.mount,
                "rohs": p.rohs,
                "lead_time_days": p.lead_time_days,
                "moq": moqs.get(p.id),
                "dist_count": int(agg[1]) if agg else 0,
                "best_price": float(agg[3]) if agg and agg[3] is not None else None,
                "stock": int(agg[2] or 0) if agg else 0,
                "lifecycle_status": p.lifecycle_status,
                "category_icon": icon,
                "category_slug": slug,
                "parent_category_slug": parent_slug,
            }
        )
    return out


# ── Section builders ────────────────────────────────────────────────────────


def _category_hits(db: Session, pattern: str) -> list[dict]:
    """CategoryHit cards. A subcategory-name match surfaces the PARENT card
    with the child flagged; matched children order first. parts_count is
    own + sum(children), matching get_all_categories."""
    matched = db.query(Category).filter(Category.name.ilike(pattern)).all()
    if not matched:
        return []
    matched_ids = {c.id for c in matched}

    # Parent cards in deterministic order: direct top-level matches first,
    # then parents surfaced by a child match.
    card_ids: list = []
    seen: set = set()
    for c in sorted((c for c in matched if c.parent_id is None), key=lambda c: c.sort_order or 0):
        if c.id not in seen:
            seen.add(c.id)
            card_ids.append(c.id)
    for c in sorted((c for c in matched if c.parent_id is not None), key=lambda c: c.name):
        if c.parent_id not in seen:
            seen.add(c.parent_id)
            card_ids.append(c.parent_id)
    card_ids = card_ids[:SECTION_LIMIT]

    cards = {c.id: c for c in db.query(Category).filter(Category.id.in_(card_ids)).all()}

    counts = {
        row[0]: int(row[1])
        for row in db.query(Part.category_id, func.count(Part.id)).group_by(Part.category_id).all()
    }

    hits = []
    for card_id in card_ids:
        cat = cards.get(card_id)
        if cat is None:
            continue
        children = sorted(cat.children or [], key=lambda ch: (ch.sort_order or 0, ch.name))
        children = sorted(children, key=lambda ch: ch.id not in matched_ids)  # matched first
        hits.append(
            {
                "id": str(cat.id),
                "name": cat.name,
                "slug": cat.slug,
                "icon": cat.icon,
                "parent_slug": None,  # cards are always top-level
                "parts_count": counts.get(cat.id, 0)
                + sum(counts.get(ch.id, 0) for ch in cat.children or []),
                "children": [
                    {"name": ch.name, "slug": ch.slug, "matched": ch.id in matched_ids}
                    for ch in children
                ],
            }
        )
    return hits


def _supplier_hits(db: Session, pattern: str) -> list[dict]:
    suppliers = (
        db.query(Supplier)
        .filter(Supplier.name.ilike(pattern))
        .order_by(Supplier.name)
        .limit(SECTION_LIMIT)
        .all()
    )
    tiers = get_active_supplier_tiers(db, [s.id for s in suppliers])
    return [
        {
            "id": str(s.id),
            "name": s.name,
            "website": s.website,
            "logo_url": s.logo_url,
            "description": s.description,
            "tier": tiers.get(s.id),
        }
        for s in suppliers
    ]


def _manufacturer_hits(db: Session, query: str) -> list[dict]:
    needle = query.lower()
    return [m for m in get_public_manufacturers(db) if needle in m["name"].lower()][:SECTION_LIMIT]


# ── Zero-result fuzzy recovery (§1.5) ───────────────────────────────────────


def _suggestion_vocab(db: Session) -> list[tuple[str, str, str | None]]:
    """Category names (both levels) + supplier names + derived manufacturer
    names — deliberately NO part SKUs. Kit-parity dedup order: suppliers
    overwrite a colliding category name, manufacturers never overwrite."""
    vocab: dict[str, tuple[str, str | None]] = {}
    for name, icon in db.query(Category.name, Category.icon).all():
        vocab[name] = ("category", icon)
    for (name,) in db.query(Supplier.name).all():
        vocab[name] = ("distributor", None)
    for m in get_public_manufacturers(db):
        vocab.setdefault(m["name"], ("manufacturer", None))
    return [(term, kind, icon) for term, (kind, icon) in vocab.items()]


def _closest_parts(db: Session, query: str) -> list[dict]:
    """Bounded SQL candidate pool → python trigram/prefix scoring → popular
    stock-ordered backfill up to CLOSEST_LIMIT full SearchPart rows."""
    clean_query = re.sub(r"[^A-Za-z0-9]", "", query)
    tokens = [t for t in re.split(r"[\s\-_/,]+", query) if len(t) >= 3]
    filters = []
    if len(clean_query) >= 3:
        filters.append(Part.sku.ilike(f"{clean_query[:3].upper()}%"))
    for token in tokens:
        token_pattern = f"%{token}%"
        filters.append(Part.sku.ilike(token_pattern))
        filters.append(Part.description.ilike(token_pattern))
        filters.append(Part.manufacturer_name.ilike(token_pattern))

    candidates = (
        db.query(Part)
        .options(raiseload(Part.listings))
        .filter(or_(*filters))
        .limit(CLOSEST_POOL_CAP)
        .all()
        if filters
        else []
    )
    scored = []
    for p in candidates:
        hay = " ".join(x for x in (p.sku, p.description, p.manufacturer_name) if x)
        score = closest_score(query, p.sku, hay)
        if score >= 2:
            scored.append((score, p))
    scored.sort(key=lambda entry: (-entry[0], entry[1].sku))
    picked = [p for _, p in scored[:CLOSEST_LIMIT]]

    if len(picked) < CLOSEST_LIMIT:
        picked_ids = {p.id for p in picked}
        backfill = (
            db.query(Part)
            .options(raiseload(Part.listings))
            .outerjoin(PartListing, PartListing.part_id == Part.id)
            .group_by(Part.id)
            .order_by(
                func.coalesce(func.sum(PartListing.stock_quantity), 0).desc(),
                Part.sku.asc(),
            )
            .limit(CLOSEST_LIMIT + len(picked))
            .all()
        )
        for p in backfill:
            if len(picked) >= CLOSEST_LIMIT:
                break
            if p.id in picked_ids:
                continue
            picked.append(p)
            picked_ids.add(p.id)
    return _build_search_parts(db, picked)


# ── The endpoint's whole answer ─────────────────────────────────────────────


def search(db: Session, query: str, suggest: bool = True) -> dict:
    """The full §1.3 response contract, serialized and JSON-ready."""
    t0 = time.perf_counter()
    pattern = f"%{query}%"

    parts_raw = (
        db.query(Part)
        # Suppress the listings→price_breaks selectin cascade (the seed-probe
        # lesson: bare Part loads hydrate the whole chain, tens of thousands of
        # discarded ORM rows against the full catalog). raiseload rather than
        # lazyload so an accidental .listings read here fails LOUD —
        # _build_search_parts computes every aggregate in SQL and must stay
        # the only consumer. Same options() on both _closest_parts queries.
        .options(raiseload(Part.listings))
        .filter(
            or_(
                Part.sku.ilike(pattern),
                Part.description.ilike(pattern),
                Part.manufacturer_name.ilike(pattern),
            )
        )
        .order_by(Part.sku)
        .limit(PARTS_LIMIT)
        .all()
    )
    parts = _build_search_parts(db, parts_raw)
    categories = _category_hits(db, pattern)
    suppliers = _supplier_hits(db, pattern)
    manufacturers = _manufacturer_hits(db, query)

    total = len(parts) + len(categories) + len(suppliers) + len(manufacturers)

    suggestions = None
    closest = None
    if total == 0 and suggest:
        suggestions = did_you_mean(query, _suggestion_vocab(db))
        closest = _closest_parts(db, query)

    return {
        "parts": parts,
        "categories": categories,
        "suppliers": suppliers,
        "manufacturers": manufacturers,
        "total": total,
        "took_ms": round((time.perf_counter() - t0) * 1000.0, 3),
        "suggestions": suggestions,
        "closest_parts": closest,
    }
