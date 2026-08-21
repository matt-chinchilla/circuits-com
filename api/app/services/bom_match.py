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

from app.models import Part, Sponsor

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
class LineMatch:
    status: str  # "exact" | "approx" | "resolve" | "none"
    part: Part | None
    approx_reason: str | None
    resolve_query: str | None


def _total_stock(part: Part) -> int:
    return sum(li.stock_quantity or 0 for li in part.listings)


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
        forward = (
            db.query(Part)
            .filter(func.upper(Part.sku).like(f"{like_escaped}%", escape="\\"))
            .limit(25)
            .all()
        )
        reverse = (
            db.query(Part)
            .filter(func.length(Part.sku) >= MIN_APPROX_LEN)
            .filter(literal(up).like(func.upper(Part.sku).concat("%")))
            .limit(25)
            .all()
        )
        seen: dict = {}
        for p in [*forward, *reverse]:
            seen.setdefault(p.id, p)
        candidates = list(seen.values())
        if candidates:
            candidates.sort(
                key=lambda p: (
                    abs(len(p.sku) - len(wanted)),
                    0 if p.lifecycle_verified_at is not None else 1,
                    -_total_stock(p),
                    p.sku,
                )
            )
            best = candidates[0]
            reason = (
                "ordering-code suffix differs"
                if best.sku.upper().startswith(up)
                else "base part of the pasted ordering code"
            )
            return LineMatch("approx", best, reason, None)

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
