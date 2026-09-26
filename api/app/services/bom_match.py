"""BOM matcher — the ladder (spec §5) and the pure recommendation rule.

Ladder per line, first rung wins:
  1. EXACT   upper(sku) == upper(mpn)          (ix_parts_sku_upper)
  2. APPROX  bidirectional prefix family, min 5 chars, ranked
  3. no MPN  → read what the line DOES say, never the SKU column:
       a. a Value that is a part number (`BSS138`) takes rungs 1-2 by that
          value, answered as APPROX (the design never said it was an MPN);
       b. a passive whose class and chip size are certain (`10k` on
          `R_0805_2012Metric`) matches catalog parts by description + package,
          best-stocked first, as APPROX with its runner-ups as the Similar menu
          (bom_value reads the line; `_value_candidates` is ONE scan per BOM);
       c. otherwise → resolve query "{value} {package}", where the package is
          the chip size when the footprint names one (`10k 0805`, spec §5),
          else the footprint token (`BSS138 SOT-23`)
  4. MISS    → resolve by the MPN itself

Rung 3 was "NO catalog guessing" until 2026-09-26, when a downloaded KiCad
keyboard priced 1 of 8 lines: every line had no MPN, so none was ever put to a
catalog of 808k parts that held all four of its passives in stock.

`recommend()` is a PURE function and one of the +20% rule's TWO MIRRORED
HOMES — the other is frontend/src/public/pages/bom/lib/priceBreaks.ts. The
test case names are shared between test_bom_recommend.py and
priceBreaks.test.ts; change the rule in one home and the other's table fails.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import and_, case, func, literal, or_, select, union_all
from sqlalchemy.orm import Session

from app.models import Part, PartListing, Sponsor
from app.services.bom_value import (
    CLASS_TERMS,
    ValueSpec,
    looks_like_part_number,
    package_code,
    read_value_spec,
)
from app.services.part_feed.registry import match_provider

MIN_APPROX_LEN = 5


def footprint_token(footprint: str | None) -> str | None:
    text = (footprint or "").strip()
    if not text:
        return None
    if ":" in text:
        text = text.split(":", 1)[1].strip()
    return text or None


def build_resolve_query(value: str | None, footprint: str | None) -> str | None:
    """The keyword a distributor is asked for an MPN-less line.

    The CHIP SIZE, not KiCad's footprint name: a distributor indexes "0805",
    never `R_0805_2012Metric_Pad1.20x1.40mm_HandSolder`, and asking for the
    latter returned zero rows for every passive on the 2026-09-26 keyboard.
    A footprint with no chip size keeps its token (`SOT-23` is already a
    package term)."""
    val = (value or "").strip()
    if not val:
        return None
    token = line_package(footprint)
    return f"{val} {token}" if token else val


def package_warning(line_package: str | None, part_package: str | None) -> str | None:
    a = (line_package or "").strip()
    b = (part_package or "").strip()
    if not a or not b or a.lower() == b.lower():
        return None
    # Chip sizes compare by CODE: a KiCad footprint and a feed's package field
    # never share a spelling ("R_0805_2012Metric" vs "0805 (2012 Metric)"), so
    # comparing the strings warned on every correct 0805 match.
    code_a, code_b = package_code(a), package_code(b)
    if code_a is not None and code_b is not None and code_a == code_b:
        return None
    return f"package differs: {a} → {b}"


def line_package(footprint: str | None) -> str | None:
    """What a line's package is compared AS: its chip size when the footprint
    names one, else the footprint token."""
    return package_code(footprint) or footprint_token(footprint)


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


_MPN_COLS = (
    Part.id,
    Part.sku,
    Part.manufacturer_name,
    Part.description,
    Part.package,
    Part.lifecycle_status,
    Part.lifecycle_verified_at,
)


def _match_mpn(db: Session, wanted: str) -> LineMatch | None:
    """Rungs 1-2 for one part number: EXACT, else the APPROX prefix family,
    else None (the caller decides what a miss becomes)."""
    up = wanted.upper()
    # After migration 041 one manufacturer cannot hold this MPN twice, so the
    # rows this can still pick between are DIFFERENT manufacturers' parts that
    # share a part number — 49 such pairs exist on production, and they are
    # unrelated products (a Desco taper tap and a Simpson panel meter). So the
    # tie-break decides whose part a buyer's BOM line resolves to, and the only
    # honest thing it can say is "prefer one a feed has actually confirmed".
    #
    # It orders on PRESENCE, not recency. `lifecycle_verified_at` means "when a
    # feed established the lifecycle this row currently claims" (see
    # _stamp_feed_facts), so ordering by it descending would have preferred the
    # part whose lifecycle changed most RECENTLY — i.e. the least settled one,
    # which is close to backwards. `sku` then breaks the remaining tie
    # deterministically, as before.
    exact = (
        db.query(Part)
        .filter(func.upper(Part.sku) == up)
        .order_by(
            (Part.lifecycle_verified_at.is_(None)).asc(),
            Part.sku,
        )
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
        forward = (
            db.query(*_MPN_COLS)
            .filter(func.upper(Part.sku).like(f"{like_escaped}%", escape="\\"))
            .limit(25)
            .all()
        )
        reverse = (
            db.query(*_MPN_COLS)
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
    return None


# Rung 3's reasons, rendered in the Matches column and the share export. The
# owner's copy rule applies: plain spoken words, no dashes.
VALUE_AS_MPN_REASON = "part number read from the value field"
VALUE_MATCH_REASON = "no part number in the design; best stocked match for its value and package"

# Distinct value specs per catalog scan. Each batch is ONE pass over `parts`
# (the pool CTE); a real board has well under this many distinct passives.
VALUE_BATCH = 40
# Best + the Similar menu's eight, the same shape rung 2 returns.
VALUE_TOP_N = 9


def _value_candidates(db: Session, specs: list[ValueSpec]) -> dict[ValueSpec, list[CandidateStub]]:
    """Rung 3b for every spec at once: the best-stocked catalog parts whose
    description names the spec's class and value and whose package (or
    description) names its chip size.

    ONE heap scan per batch, whatever the line count. The catalog has no text
    index, so each ILIKE filter is a sequential scan of `parts` (0.5 s for one
    line on 808k rows, measured 2026-09-26); per-line queries would make a
    40-passive board wait 20 s. Instead a pool CTE takes every row any spec in
    the batch could want (package AND class, once), and each spec ranks its
    own top N out of that pool in a UNION ALL branch. Postgres materializes a
    CTE referenced more than once, so the branches read the pool, not the
    table. Scalar columns only (the CandidateStub rule)."""
    out: dict[ValueSpec, list[CandidateStub]] = {}
    for start in range(0, len(specs), VALUE_BATCH):
        batch = specs[start : start + VALUE_BATCH]

        def package_is(cols, code: str):
            return or_(cols.package.ilike(f"{code}%"), cols.description.ilike(f"% {code}%"))

        def class_is(cols, kind: str):
            include, exclude = CLASS_TERMS[kind]
            return and_(
                or_(*[cols.description.ilike(p) for p in include]),
                *[~cols.description.ilike(p) for p in exclude],
            )

        pairs = sorted({(spec.code, spec.kind) for spec in batch})
        pool = (
            select(*_MPN_COLS, Part.total_stock)
            .where(
                or_(*[and_(package_is(Part, code), class_is(Part, kind)) for code, kind in pairs])
            )
            .cte("bom_value_pool")
        )
        c = pool.c
        lifecycle_rank = case(
            (c.lifecycle_status == "obsolete", 2), (c.lifecycle_status == "nrnd", 1), else_=0
        )
        branches = []
        for tag, spec in enumerate(batch):
            conds = [package_is(c, spec.code), class_is(c, spec.kind)]
            if spec.value_terms:
                conds.append(or_(*[c.description.ilike(f"%{term}%") for term in spec.value_terms]))
            ranked = (
                select(literal(tag).label("tag"), *[c[col.key] for col in _MPN_COLS])
                .where(and_(*conds))
                .order_by(lifecycle_rank, c.total_stock.desc(), c.sku)
                .limit(VALUE_TOP_N)
                .subquery()
            )
            branches.append(select(ranked))
        statement = branches[0] if len(branches) == 1 else union_all(*branches)
        for row in db.execute(statement).all():
            spec = batch[row[0]]
            out.setdefault(spec, []).append(CandidateStub(*row[1:]))
    return out


def match_lines(
    db: Session, lines: list[tuple[str | None, str | None, str | None]]
) -> list[LineMatch]:
    """The ladder for a whole BOM: `(mpn, value, footprint)` per line, answers
    in the same order. Rung 3b is batched across ALL lines (see
    `_value_candidates`), which is why this, not `match_line`, is what the
    route calls."""
    results: list[LineMatch | None] = [None] * len(lines)
    pending: dict[ValueSpec, list[int]] = {}
    for i, (mpn, value, footprint) in enumerate(lines):
        wanted = (mpn or "").strip()
        if wanted:
            results[i] = _match_mpn(db, wanted) or LineMatch("resolve", None, None, wanted)
            continue
        text = (value or "").strip()
        if looks_like_part_number(text):
            hit = _match_mpn(db, text)
            if hit is not None:
                reason = VALUE_AS_MPN_REASON
                if hit.approx_reason:
                    reason = f"{reason}; {hit.approx_reason}"
                results[i] = LineMatch("approx", hit.part, reason, None, hit.candidates)
            continue  # a part number the catalog lacks goes to the provider, never to 3b
        spec = read_value_spec(text, footprint)
        if spec is not None:
            pending.setdefault(spec, []).append(i)

    found = _value_candidates(db, list(pending)) if pending else {}
    for spec, indexes in pending.items():
        candidates = found.get(spec) or []
        best = db.get(Part, candidates[0].id) if candidates else None
        if best is None:
            continue
        for i in indexes:
            results[i] = LineMatch(
                "approx", best, VALUE_MATCH_REASON, None, tuple(candidates[1:VALUE_TOP_N])
            )

    for i, (_mpn, value, footprint) in enumerate(lines):
        if results[i] is None:
            query = build_resolve_query(value, footprint)
            results[i] = LineMatch("resolve" if query else "none", None, None, query)
    return [r for r in results if r is not None]


def match_line(db: Session, mpn: str | None, value: str | None, footprint: str | None) -> LineMatch:
    return match_lines(db, [(mpn, value, footprint)])[0]


# THE sponsor-preference number (D4, owner-approved). Mirrored — see module
# docstring. 1.20 == "within +20% of the best in-stock price".
SPONSOR_BAND = 1.20


# Provenance, NOT recency. See _offers_for_part for why the distinction is the
# whole point and why there is no third value for "confirmed recently".
PRICE_SOURCE_LIVE = "live"
PRICE_SOURCE_STATIC = "static"


@dataclass(frozen=True)
class Offer:
    supplier_id: str
    stock_quantity: int
    unit_price: float
    breaks: tuple[tuple[int, float], ...]  # (min_quantity, unit_price) ASC
    # PRICE_SOURCE_LIVE | PRICE_SOURCE_STATIC. Carried on the pure Offer to
    # mirror the TS `Offer` in priceBreaks.ts. recommend() does not read it and
    # must not: provenance is rendered, never silently re-ranked — the same
    # posture the old staleness flag had, and the one thing about it that was
    # right.
    #
    # REQUIRED here, OPTIONAL there, and that asymmetry is deliberate rather
    # than drift. This object is only ever built from a live database row in
    # _offers_for_part, which always knows the answer. The TS one is built from
    # a wire payload that may be a share link created before the field existed,
    # so over there absent is a real state and every render site has to branch
    # three ways. Making it required on the client would not add safety, it
    # would just make `undefined` lie about its type.
    price_source: str


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


def _offers_for_part(
    db: Session, part: Part, live_slugs: frozenset[str]
) -> tuple[list[dict], dict[str, Offer]]:
    """All listings as wire offers (price-ascending) + pure Offer inputs for
    recommend().

    THE PROVENANCE PAIR — `price_source` + `price_as_of` — replaces the old
    `price_stale` boolean, which was measuring the wrong thing and telling
    buyers about it.

    `price_stale` was `last_updated < now() - 30 days`. But
    `part_listings.last_updated` has `default=` and NO `onupdate=`: it is
    stamped once at INSERT and no writer has ever bumped it. It means
    "created". So a Mouser row the nightly feed confirms every single night
    still crossed the 30-day line on its own, and `availabilityRail` tested
    that flag ABOVE both stock branches — meaning the BOM table would have
    stopped reporting stock on EVERY row in the catalog on 2026-09-24
    (measured: 38,442 listings read stale today, 97,580 on 2026-09-20,
    167,823 of 167,823 on 2026-09-24).

    What replaces it deliberately claims LESS:

      live    a distributor API is registered for this supplier AND we hold a
              key for it today, so this row is reachable and does get
              rewritten when its numbers change.
      static  no live source. The number is REAL — the ~37,095 listings behind
              the 57 sourceless suppliers were collected, not invented — but
              nothing re-reads it.

    It does NOT say "confirmed recently", because nothing in the schema can
    support that claim and every available proxy was checked and rejected:
    `last_updated` has one reader and zero writers; `updated_at` moves only
    when a VALUE changed, which is at most 6,477 of 130,728 Mouser listings
    (5.0%) — so at least 95% of confirmed rows look untouched;
    `supplier_feeds.last_synced_at` is stamped by a job that by construction
    refreshes nothing; `lifecycle_verified_at` covers 1.8% of parts. The word
    "confirmed" must never appear beside either label.

    `price_as_of` is WHEN THIS OFFER ENTERED THE CATALOG, never "when the
    price was read", and it is rendered unconditionally beside the label so
    the pair is never split. It can under-claim: 1,352 Mouser listings still
    carry the 2026-06-03 seed date and 137 of those have
    `updated_at > last_updated + 1s`, i.e. a feed demonstrably rewrote them in
    August while this field will print June. Under-claiming is safe. The
    obvious "fix" — stamping `last_updated` on every confirming pass — is NOT:
    that is ~130k UPDATEs on an 8-index table per sweep, exactly the per-pass
    write churn that 9e4abd0 ("perf(feed): reconcile price ladders instead of
    replacing them", 828,673 row-ops -> 0) removed, and the same mistake
    `lifecycle_verified_at` made before its guard was tightened.

    `live_slugs` is computed ONCE per request by the caller
    (registry.live_feed_slugs) and passed down. `match_provider` costs nothing
    here: this loop already dereferences `li.supplier` for the name and the
    website, so the Supplier object is in hand and matching is a pure string
    scan over it — zero added queries per listing.
    """
    wire: list[dict] = []
    pure: dict[str, Offer] = {}
    for li in part.listings:
        supplier = li.supplier
        breaks = sorted((pb.min_quantity, float(pb.unit_price)) for pb in li.price_breaks)
        matched = match_provider(supplier) if supplier is not None else None
        source = (
            PRICE_SOURCE_LIVE
            if matched is not None and matched[0] in live_slugs
            else PRICE_SOURCE_STATIC
        )
        # Per LISTING, never hoisted onto the supplier: two of a supplier's
        # rows can and do carry different dates, and printing one row's age
        # against another's price is the kind of quiet lie this field exists
        # to prevent.
        as_of = li.last_updated.isoformat() if li.last_updated is not None else None
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
                "price_source": source,
                "price_as_of": as_of,
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
            price_source=source,
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
    live_slugs: frozenset[str],
    similar_parts: list[Part] | None = None,
) -> dict:
    """One wire row for one BOM line.

    `live_slugs` is REQUIRED and has no default on purpose. Defaulting it to
    the empty set would render perfectly — every offer would simply read
    `static`, which libels a live distributor by omission and shows nothing
    wrong in a screenshot. Defaulting it to "compute it myself" would move a
    credential lookup inside the caller's per-line loop, and the
    schema lets a BOM carry 2,000 lines. Callers hoist it once per request
    (`registry.live_feed_slugs`); the two call sites are in `routes/bom.py`.
    """
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
    wire, pure = _offers_for_part(db, part, live_slugs)
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
