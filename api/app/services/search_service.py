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
from sqlalchemy.orm import Session, aliased, defaultload, raiseload

from app.models import Category, Part, PartListing, PriceBreak, Sponsor, Supplier
from app.services.category_service import (
    TIER_ORDER,
    active_sponsor_filter,
    part_counts_by_category,
)
from app.services.search_suggest import closest_score, did_you_mean

PARTS_LIMIT = 20
SECTION_LIMIT = 12
# Longest query the search pipeline will look at. The fuzzy recovery is
# SUPERLINEAR in query length — did_you_mean runs a python Levenshtein of
# O(len(query) x len(term)) against EVERY vocabulary term, plus each word
# inside it — so an unbounded `q` on an unauthenticated GET is a CPU DoS
# (measured on the 6.3k-part dev catalog: 100 chars 1.7s, 400 chars 5.4s,
# 1600 chars 20.9s; prod carries 132k+ parts). The route rejects anything
# longer with 422; `search` truncates so no other caller can bypass it.
# Real queries are SKUs and part names — 120 chars is far past any of them.
MAX_QUERY_LENGTH = 120
# compact=1 (the dropdown) trims each section server-side — the client renders
# at most this many rows anyway, so the full payload was waste.
COMPACT_PARTS_LIMIT = 5
COMPACT_SECTION_LIMIT = 3
CLOSEST_LIMIT = 15
CLOSEST_POOL_CAP = 400


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
    query = db.query(Sponsor.supplier_id, Sponsor.tier).filter(active_sponsor_filter())
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
        rank = TIER_ORDER.get(normalized, 9)
        current = best.get(supplier_id)
        if current is None or rank < current[0]:
            best[supplier_id] = (rank, normalized)
    return {supplier_id: pair[1] for supplier_id, pair in best.items()}


# ── Derived public manufacturers (§1.4) + zero-result caches ────────────────
#
# Three sibling in-process TTL caches on one clock seam: the derived
# manufacturers list, the did-you-mean vocabulary assembled from it, and the
# popular-backfill part-id pool. One reset clears all three.

_CACHE_TTL_SECONDS = 600.0
_manufacturers_cache: tuple[float, list[dict], list[str]] | None = None
_vocab_cache: tuple[float, list[tuple[str, str, str | None]]] | None = None
_backfill_ids_cache: tuple[float, list] | None = None


def _now() -> float:
    """Clock seam — tests monkeypatch this to expire the caches."""
    return time.monotonic()


def _expired(cached: tuple | None) -> bool:
    """True when a (timestamp, …) cache tuple is absent or past the TTL."""
    return cached is None or _now() - cached[0] >= _CACHE_TTL_SECONDS


def _manufacturers_data(db: Session) -> tuple[list[dict], list[str]]:
    """(rows, lowered_names) — names lowered ONCE per refresh so the
    per-keystroke `_manufacturer_hits` substring scan never re-lowers the
    whole list."""
    global _manufacturers_cache
    cached = _manufacturers_cache
    if cached is None or _expired(cached):
        rows = (
            db.query(Part.manufacturer_name, func.count(Part.id))
            .filter(Part.manufacturer_name.isnot(None), Part.manufacturer_name != "")
            .group_by(Part.manufacturer_name)
            .order_by(func.count(Part.id).desc(), Part.manufacturer_name.asc())
            .all()
        )
        data = [{"name": name, "parts_count": int(count)} for name, count in rows]
        cached = (_now(), data, [name.lower() for name, _ in rows])
        _manufacturers_cache = cached
    return cached[1], cached[2]


def get_public_manufacturers(db: Session) -> list[dict]:
    """[{name, parts_count}, …] grouped from parts.manufacturer_name,
    count-desc (name-asc tiebreak), cached in-process for 600s."""
    return _manufacturers_data(db)[0]


def invalidate_catalog_caches() -> None:
    """Drop ALL three catalog-derived TTL caches at once.

    Two callers, one seam. (1) Every catalog MUTATION — part create/update/
    delete, batch import, supplier create/update/delete, and the end of a feed
    run — because a 600s TTL alone meant an admin's edit took up to ten minutes
    to reach the manufacturers list, the did-you-mean vocabulary and the
    zero-result backfill pool, which reads as "the site is broken" long before
    it reads as "the cache is warm". (2) An autouse conftest fixture, so one
    test's catalog can never leak into the next suite's.

    Cheap by construction: this only clears: the next reader re-derives. It is
    also PER-PROCESS — the nightly feed-import container has its own memory,
    and its writes reach the api through this same call only when the run is
    driven from the api process (an admin click), which is the case that
    matters."""
    global _manufacturers_cache, _vocab_cache, _backfill_ids_cache
    _manufacturers_cache = None
    _vocab_cache = None
    _backfill_ids_cache = None


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


def _category_hits(db: Session, pattern: str, limit: int = SECTION_LIMIT) -> list[dict]:
    """CategoryHit cards. A subcategory-name match surfaces the PARENT card
    with the child flagged; matched children order first. parts_count is
    own + sum(children), matching get_all_categories."""
    # children IS consumed below; only the supplier_associations selectin
    # cascade (the card's own AND each child's) is suppressed — the Category
    # mirror of the Part.listings raiseload in search().
    load_opts = (
        raiseload(Category.supplier_associations),
        defaultload(Category.children).raiseload(Category.supplier_associations),
    )
    matched = db.query(Category).options(*load_opts).filter(Category.name.ilike(pattern)).all()
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
    card_ids = card_ids[:limit]

    # Directly-matched cards are already in hand — fetch only the parents a
    # child match surfaced.
    card_id_set = set(card_ids)
    cards = {c.id: c for c in matched if c.id in card_id_set}
    missing = [cid for cid in card_ids if cid not in cards]
    if missing:
        for c in db.query(Category).options(*load_opts).filter(Category.id.in_(missing)).all():
            cards[c.id] = c

    relevant_ids = set(cards)
    for cat in cards.values():
        relevant_ids.update(ch.id for ch in cat.children or [])
    counts = part_counts_by_category(db, relevant_ids)

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


def _supplier_hits(db: Session, pattern: str, limit: int = SECTION_LIMIT) -> list[dict]:
    suppliers = (
        db.query(Supplier)
        .filter(Supplier.name.ilike(pattern))
        .order_by(Supplier.name)
        .limit(limit)
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
    data, lowered = _manufacturers_data(db)
    return [m for m, low in zip(data, lowered, strict=True) if needle in low][:SECTION_LIMIT]


# ── Zero-result fuzzy recovery (§1.5) ───────────────────────────────────────


def _suggestion_vocab(db: Session) -> list[tuple[str, str, str | None]]:
    """Category names (both levels) + supplier names + derived manufacturer
    names — deliberately NO part SKUs. Kit-parity dedup order: suppliers
    overwrite a colliding category name, manufacturers never overwrite.
    Cached on the shared TTL seam — assembly walks every name in the
    catalog and only serves the zero-result path."""
    global _vocab_cache
    cached = _vocab_cache
    if cached is None or _expired(cached):
        vocab: dict[str, tuple[str, str | None]] = {}
        for name, icon in db.query(Category.name, Category.icon).all():
            vocab[name] = ("category", icon)
        for (name,) in db.query(Supplier.name).all():
            vocab[name] = ("distributor", None)
        for m in get_public_manufacturers(db):
            vocab.setdefault(m["name"], ("manufacturer", None))
        cached = (_now(), [(term, kind, icon) for term, (kind, icon) in vocab.items()])
        _vocab_cache = cached
    return cached[1]


_BACKFILL_POOL_SIZE = CLOSEST_LIMIT * 2  # ≥ the old per-query LIMIT's max


def _popular_backfill_ids(db: Session) -> list:
    """Top part ids by aggregate stock (sku tiebreak) — the zero-result
    backfill pool, cached on the shared TTL seam so the aggregate join over
    the full catalog doesn't rerun per zero-result query."""
    global _backfill_ids_cache
    cached = _backfill_ids_cache
    if cached is None or _expired(cached):
        rows = (
            db.query(Part.id)
            .outerjoin(PartListing, PartListing.part_id == Part.id)
            .group_by(Part.id)
            .order_by(
                func.coalesce(func.sum(PartListing.stock_quantity), 0).desc(),
                Part.sku.asc(),
            )
            .limit(_BACKFILL_POOL_SIZE)
            .all()
        )
        cached = (_now(), [row[0] for row in rows])
        _backfill_ids_cache = cached
    return cached[1]


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
        # The pool is a cached SNAPSHOT of ids, so a part deleted since the
        # last refresh resolves to NOTHING. Resolve the whole remaining pool
        # (bounded: 2 × CLOSEST_LIMIT, still one query) and take the first N
        # rows that are still LIVE — slicing to N ids first made every stale
        # id cost a result row, so a zero-result page silently returned 13
        # suggestions instead of 15. Pool order is the ranking, so it is
        # preserved across both the filter and the refill.
        candidate_ids = [pid for pid in _popular_backfill_ids(db) if pid not in picked_ids]
        if candidate_ids:
            by_id = {
                p.id: p
                for p in db.query(Part)
                .options(raiseload(Part.listings))
                .filter(Part.id.in_(candidate_ids))
                .all()
            }
            live = [by_id[pid] for pid in candidate_ids if pid in by_id]
            picked.extend(live[: CLOSEST_LIMIT - len(picked)])
    return _build_search_parts(db, picked)


# ── The endpoint's whole answer ─────────────────────────────────────────────


def search(db: Session, query: str, suggest: bool = True, compact: bool = False) -> dict:
    """The full §1.3 response contract, serialized and JSON-ready.

    compact=True is the dropdown trim: parts capped at 5, categories and
    suppliers at 3, manufacturers omitted — same response shape, `total`
    still the sum of the returned section lengths."""
    t0 = time.perf_counter()
    # The route already 422s an over-long `q`; this is the belt to that
    # braces, because the fuzzy recovery below is superlinear in query length
    # and `search` is importable by anything (jobs, tests, a future route).
    # Truncating rather than raising keeps this a pure function of the text.
    query = query[:MAX_QUERY_LENGTH]
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
        .limit(COMPACT_PARTS_LIMIT if compact else PARTS_LIMIT)
        .all()
    )
    section_limit = COMPACT_SECTION_LIMIT if compact else SECTION_LIMIT
    parts = _build_search_parts(db, parts_raw)
    categories = _category_hits(db, pattern, limit=section_limit)
    suppliers = _supplier_hits(db, pattern, limit=section_limit)
    manufacturers = [] if compact else _manufacturer_hits(db, query)

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
