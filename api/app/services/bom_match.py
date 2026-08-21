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

from dataclasses import dataclass

from sqlalchemy import func, literal
from sqlalchemy.orm import Session

from app.models import Part

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
