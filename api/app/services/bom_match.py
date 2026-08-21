"""BOM matcher — the ladder (spec §5) and the pure recommendation rule.

Ladder per line, first rung wins:
  1. EXACT   upper(sku) == upper(mpn)          (ix_parts_sku_upper)
  2. APPROX  bidirectional prefix family, min 5 chars, ranked
  3. no MPN  → resolve query "{value} {footprint_token}" — NO catalog guessing
  4. MISS    → resolve by the MPN itself

`recommend()` is a PURE function and one of the +20% rule's TWO MIRRORED
HOMES — the other is frontend/src/public/pages/bom/lib/priceBreaks.ts. The
test case names are shared between test_bom_recommend.py and
priceBreaks.test.ts; change the rule in one home and the other's table fails.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import case, func, literal, or_
from sqlalchemy.orm import Session

from app.models import Part, PartListing, Sponsor

MIN_APPROX_LEN = 5


def footprint_token(footprint: str | None) -> str | None:
    text = (footprint or "").strip()
    if not text:
        return None
    if ":" in text:
        text = text.split(":", 1)[1].strip()
    return text or None


def build_resolve_query(value: str | None, footprint: str | None) -> str | None:
    val = (value or "").strip()
    if not val:
        return None
    token = footprint_token(footprint)
    return f"{val} {token}" if token else val


def package_warning(line_package: str | None, part_package: str | None) -> str | None:
    a = (line_package or "").strip()
    b = (part_package or "").strip()
    if not a or not b or a.lower() == b.lower():
        return None
    return f"package differs: {a} → {b}"


@dataclass(frozen=True)
class CandidateStub:
    """A ranking/stub row for the approx ladder. Scalar columns ONLY — the
    candidate queries must never hydrate Part ORM objects, whose lazy=selectin
    listings→price_breaks cascade fires on load and would drag hundreds of
    discarded rows per approx line (the seed-speedup lesson, 2026-08-21
    review finding #1). Attribute names mirror Part so _similar_stub reads
    either."""

    id: object
    sku: str
    manufacturer_name: str | None
    description: str | None
    package: str | None
    lifecycle_status: str | None
    lifecycle_verified_at: object | None


@dataclass(frozen=True)
class LineMatch:
    status: str  # "exact" | "approx" | "resolve" | "none"
    part: Part | None
    approx_reason: str | None
    resolve_query: str | None
    # The APPROX ladder's ranked runner-ups (best excluded) — the "Similar"
    # column's comparable options. Always empty for exact/resolve/none: a
    # perfect match needs no menu (owner spec 2026-08-21).
    candidates: tuple[CandidateStub, ...] = ()


def match_line(db: Session, mpn: str | None, value: str | None, footprint: str | None) -> LineMatch:
    wanted = (mpn or "").strip()
    if not wanted:
        query = build_resolve_query(value, footprint)
        return LineMatch("resolve" if query else "none", None, None, query)

    up = wanted.upper()
    exact = (
        db.query(Part)
        .filter(func.upper(Part.sku) == up)
        .order_by(Part.lifecycle_verified_at.desc().nullslast(), Part.sku)
        .first()
    )
    if exact is not None:
        return LineMatch("exact", exact, None, None)

    if len(wanted) >= MIN_APPROX_LEN:
        like_escaped = up.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        # Scalar columns only — Part rows loaded here would fire the
        # lazy=selectin listings→price_breaks cascade for up to 50 candidates
        # that are then discarded (review finding, 2026-08-21). Only the
        # single winner is re-fetched as a full ORM Part below.
        cols = (
            Part.id,
            Part.sku,
            Part.manufacturer_name,
            Part.description,
            Part.package,
            Part.lifecycle_status,
            Part.lifecycle_verified_at,
        )
        forward = (
            db.query(*cols)
            .filter(func.upper(Part.sku).like(f"{like_escaped}%", escape="\\"))
            .limit(25)
            .all()
        )
        reverse = (
            db.query(*cols)
            .filter(func.length(Part.sku) >= MIN_APPROX_LEN)
            .filter(literal(up).like(func.upper(Part.sku).concat("%")))
            .limit(25)
            .all()
        )
        seen: dict = {}
        for row in [*forward, *reverse]:
            seen.setdefault(row[0], CandidateStub(*row))
        candidates = list(seen.values())
        if candidates:
            stock = {
                row[0]: int(row[1] or 0)
                for row in db.query(PartListing.part_id, func.sum(PartListing.stock_quantity))
                .filter(PartListing.part_id.in_(list(seen.keys())))
                .group_by(PartListing.part_id)
                .all()
            }
            candidates.sort(
                key=lambda c: (
                    abs(len(c.sku) - len(wanted)),
                    0 if c.lifecycle_verified_at is not None else 1,
                    -stock.get(c.id, 0),
                    c.sku,
                )
            )
            best_stub = candidates[0]
            best = db.get(Part, best_stub.id)
            if best is not None:
                reason = (
                    "ordering-code suffix differs"
                    if best.sku.upper().startswith(up)
                    else "base part of the pasted ordering code"
                )
                return LineMatch("approx", best, reason, None, tuple(candidates[1:9]))

    return LineMatch("resolve", None, None, wanted)


# THE sponsor-preference number (D4, owner-approved). Mirrored — see module
# docstring. 1.20 == "within +20% of the best in-stock price".
SPONSOR_BAND = 1.20


@dataclass(frozen=True)
class Offer:
    supplier_id: str
    stock_quantity: int
    unit_price: float
    breaks: tuple[tuple[int, float], ...]  # (min_quantity, unit_price) ASC
    price_stale: bool


def price_at(offer: Offer, qty: int) -> float:
    price = offer.unit_price
    for min_qty, unit in sorted(offer.breaks):
        if min_qty <= qty:
            price = unit
        else:
            break
    return price


def recommend(
    offers: list[Offer], line_qty: int, tier_rank: dict[str, tuple[int, str]]
) -> str | None:
    in_stock = [o for o in offers if o.stock_quantity > 0]
    if not in_stock:
        return None
    best = min(price_at(o, line_qty) for o in in_stock)
    sponsored = sorted(
        (o for o in in_stock if o.supplier_id in tier_rank),
        key=lambda o: (*tier_rank[o.supplier_id], price_at(o, line_qty)),
    )
    if sponsored and price_at(sponsored[0], line_qty) <= SPONSOR_BAND * best:
        return sponsored[0].supplier_id
    in_stock.sort(
        key=lambda o: (
            price_at(o, line_qty),
            0 if o.supplier_id in tier_rank else 1,
            -o.stock_quantity,
        )
    )
    return in_stock[0].supplier_id


def load_tier_rank(db: Session, supplier_ids: set) -> dict[str, tuple[int, str]]:
    """Active sponsorship rank per supplier — Active OR NULL status (legacy
    seed), tier lowered (the tier-casing gotcha), platinum<gold<silver, oldest
    created_at as the tiebreaker. A supplier with several placements keeps its
    best (lowest) rank."""
    if not supplier_ids:
        return {}
    # SQLAlchemy's UUID bind processor rejects plain strings, and callers hold
    # supplier ids as strings (Offer.supplier_id). Coerce, dropping anything
    # that is not a uuid rather than raising on a hostile/legacy value.
    wanted: list[uuid.UUID] = []
    for raw in supplier_ids:
        if isinstance(raw, uuid.UUID):
            wanted.append(raw)
            continue
        try:
            wanted.append(uuid.UUID(str(raw)))
        except (ValueError, AttributeError, TypeError):
            continue
    if not wanted:
        return {}
    tier_order = case(
        (func.lower(Sponsor.tier) == "platinum", 0),
        (func.lower(Sponsor.tier) == "gold", 1),
        (func.lower(Sponsor.tier) == "silver", 2),
        else_=9,
    )
    rows = (
        db.query(Sponsor.supplier_id, tier_order, Sponsor.created_at)
        .filter(Sponsor.supplier_id.in_(wanted))
        .filter(or_(Sponsor.status == "Active", Sponsor.status.is_(None)))
        .all()
    )
    rank: dict[str, tuple[int, str]] = {}
    for supplier_id, order, created in rows:
        if order == 9:
            continue
        key = str(supplier_id)
        entry = (int(order), created.isoformat() if created else "9999")
        if key not in rank or entry < rank[key]:
            rank[key] = entry
    return rank


def _offers_for_part(db: Session, part: Part) -> tuple[list[dict], dict[str, Offer]]:
    """All listings as wire offers (price-ascending) + pure Offer inputs for
    recommend(). price_stale = listing not updated in 30 days (spec §5)."""
    from datetime import UTC, datetime, timedelta

    stale_before = datetime.now(UTC) - timedelta(days=30)
    wire: list[dict] = []
    pure: dict[str, Offer] = {}
    for li in part.listings:
        supplier = li.supplier
        breaks = sorted((pb.min_quantity, float(pb.unit_price)) for pb in li.price_breaks)
        last = li.last_updated
        if last is not None and last.tzinfo is None:
            last = last.replace(tzinfo=UTC)
        stale = last is not None and last < stale_before
        sid = str(li.supplier_id)
        wire.append(
            {
                "supplier_id": sid,
                "supplier_name": supplier.name if supplier else "",
                "supplier_website": supplier.website if supplier else None,
                "tier": None,  # stamped by build_row from tier_rank
                "stock_quantity": li.stock_quantity or 0,
                "unit_price": float(li.unit_price),
                "currency": li.currency or "USD",
                "price_stale": stale,
                "breaks": [{"min_quantity": q, "unit_price": p} for q, p in breaks],
            }
        )
        # One pure Offer per supplier: keep the cheapest listing if a supplier
        # somehow has two rows for the same part.
        candidate = Offer(
            supplier_id=sid,
            stock_quantity=li.stock_quantity or 0,
            unit_price=float(li.unit_price),
            breaks=tuple(breaks),
            price_stale=stale,
        )
        if sid not in pure or candidate.unit_price < pure[sid].unit_price:
            pure[sid] = candidate
    wire.sort(key=lambda o: o["unit_price"])
    return wire, pure


_TIER_NAME = {0: "platinum", 1: "gold", 2: "silver"}


def _similar_stub(part: "Part | CandidateStub") -> dict:
    """A light row for the Similar picker — identity only. Picking one
    re-matches the line by this SKU, which brings the full offer set."""
    return {
        "id": str(part.id),
        "sku": part.sku,
        "manufacturer_name": part.manufacturer_name,
        "description": part.description,
        "package": part.package,
        "lifecycle_status": part.lifecycle_status,
        "lifecycle_verified": part.lifecycle_verified_at is not None,
    }


def build_row(
    db: Session,
    index: int,
    status: str,
    part: Part | None,
    approx_reason: str | None,
    resolve_query: str | None,
    line_package: str | None,
    similar_parts: list[Part] | None = None,
) -> dict:
    row: dict = {
        "index": index,
        "status": status,
        "approx_reason": approx_reason,
        "package_warning": None,
        "resolve_query": resolve_query,
        "part": None,
        "recommended_supplier_id": None,
        "offers": [],
        "similar": [_similar_stub(p) for p in similar_parts or []],
    }
    if part is None:
        return row
    wire, pure = _offers_for_part(db, part)
    tier_rank = load_tier_rank(db, set(pure.keys()))
    for o in wire:
        entry = tier_rank.get(o["supplier_id"])
        o["tier"] = _TIER_NAME.get(entry[0]) if entry else None
    row["part"] = {
        "id": str(part.id),
        "sku": part.sku,
        "slug": part.slug,
        "manufacturer_name": part.manufacturer_name,
        "description": part.description,
        "package": part.package,
        "lifecycle_status": part.lifecycle_status,
        "lifecycle_verified": part.lifecycle_verified_at is not None,
        "image_url": part.image_url,
        "datasheet_url": part.datasheet_url,
    }
    row["package_warning"] = package_warning(line_package, part.package)
    # Server default pick at the break ladder's base qty (=1); the client
    # re-runs the IDENTICAL rule at the real line qty (the mirrored home).
    row["recommended_supplier_id"] = recommend(list(pure.values()), 1, tier_rank)
    row["offers"] = wire
    return row
