"""Load a catalog_export.py JSONL into THIS environment's DB by natural keys.

Additive/upsert only — never deletes anything the export doesn't mention, so
prod-only rows (sponsors, users, page_views...) are untouched. Idempotent:
re-running converges to the same state.

RECONCILES, NEVER REPLACES (2026-08-28 rework — the importer's price-ladder
cure, applied to the transfer). The old loader issued one SELECT per listing
line (~212k round-trips), DELETEd and re-INSERTed every price break on every
pass (~850k row-ops and ~1/2 GB of WAL for a pull that changed nothing), and
refreshed best prices on every part the file mentioned. This one preloads
compare-state in one pass per table and writes ONLY the diffs: a no-change
pull writes ~0 rows and refreshes 0 parts.

PART IDENTITY for transfer = (upper(sku), canon(manufacturer_name)) — the
2026-08-23 identity key expressed in natural keys. The old sku-only key
folded the 49 real MPN pairs that span manufacturers (test_part_identity's
load-bearing examples) into ONE local row and cross-wrote their fields on
every pull. canon() lets per-environment manufacturer spellings still meet;
a side whose manufacturer is blank falls back to the sku-only bucket (adopt
the unlinked row) rather than minting a twin.

Memory note: compare-state for the full catalog is a few hundred MB of
Python. Fine locally; on a `circuits push` it runs inside prod's api
container on a t3.small — swap absorbs it, but don't add more preloads
casually.

Run (inside the api container):  python - export.jsonl < catalog_load.py
"""

import json
import sys
import uuid
from decimal import Decimal

from sqlalchemy import delete, insert, select, update

from app.db.session import SessionLocal
from app.models import Category, Part, PartListing, PriceBreak, Supplier
from app.services.manufacturer_canon import canon
from app.services.part_pricing import refresh_best_prices

# manufacturer_id: a per-environment surrogate (036) — never applied even if
# an old export file carries it; seed_manufacturers step 5 re-links by name.
PART_SKIP = {"category_slug", "t", "manufacturer_id"}
SUPPLIER_SKIP = {"manufacturer_id"}
LISTING_NATURAL = {"part_sku", "part_manufacturer", "supplier_name", "price_breaks", "t"}

db = SessionLocal()
cats = {c.slug: c for c in db.query(Category).all()}
sups = {s.name: s for s in db.query(Supplier).all()}

counts = {
    "suppliers_new": 0,
    "suppliers_updated": 0,
    "parts_new": 0,
    "parts_updated": 0,
    "parts_skipped_no_category": 0,
    "listings_new": 0,
    "listings_updated": 0,
    "listings_skipped": 0,
    "breaks_written": 0,
    "breaks_repriced": 0,
    "breaks_deleted": 0,
    # Twin lines: a SOURCE database that still carries duplicate part rows
    # (same sku + same maker, one twin unlinked — the open seed-backfill
    # collision class; 48 measured locally 2026-08-28) exports both. First
    # line per identity wins, later twins are skipped — without this the two
    # lines rewrote the same local row ALTERNATELY and every pull oscillated
    # instead of converging.
    "twin_part_lines_skipped": 0,
    "twin_listing_lines_skipped": 0,
    "best_prices_refreshed": 0,
}


# ── column plans: how each column compares against a JSON export value ──────
def _plan(table, skip):
    plan = {}
    for c in table.columns:
        if c.name in skip or c.name == "id":
            continue
        t = str(c.type)
        if t.startswith(("DATETIME", "TIMESTAMP")):
            continue  # keep this environment's timestamps
        plan[c.name] = "num" if t.startswith(("NUMERIC", "DECIMAL")) else "plain"
    return plan


PART_COLS = [c.name for c in Part.__table__.columns]
PART_IDX = {n: i for i, n in enumerate(PART_COLS)}
PART_PLAN = _plan(Part.__table__, PART_SKIP)
LISTING_COLS = [c.name for c in PartListing.__table__.columns]
LISTING_IDX = {n: i for i, n in enumerate(LISTING_COLS)}
LISTING_PLAN = _plan(PartListing.__table__, LISTING_NATURAL)


def diff_fields(rec, stored, idx, plan):
    """Export columns whose value differs from the stored row (a mutable list
    aligned to the table's column order — tuples not dicts, deliberately:
    compare-state for 200k+ rows at dict-per-row weight is a memory problem
    on the push side)."""
    changes = {}
    for key, val in rec.items():
        kind = plan.get(key)
        if kind is None:
            continue
        if kind == "num" and val is not None:
            val = Decimal(str(val))
        if stored[idx[key]] != val:
            changes[key] = val
    return changes


def apply_changes(stored, idx, changes):
    for key, val in changes.items():
        stored[idx[key]] = val


# ── compare-state preloads: one pass per table, Core tuples ─────────────────
def part_identity(sku, manufacturer):
    return (sku.upper(), canon(manufacturer or ""))


parts_by_identity = {}  # identity -> mutable [col values...]
parts_by_sku = {}  # upper(sku) -> same list; the blank-manufacturer fallback
for row in db.execute(select(Part.__table__).execution_options(yield_per=5000)):
    vals = list(row)
    parts_by_identity.setdefault(
        part_identity(vals[PART_IDX["sku"]], vals[PART_IDX["manufacturer_name"]]), vals
    )
    parts_by_sku.setdefault(vals[PART_IDX["sku"]].upper(), vals)

listings = {}  # (part_id, supplier_id) -> mutable [col values...]
for row in db.execute(select(PartListing.__table__).execution_options(yield_per=5000)):
    vals = list(row)
    listings[(vals[LISTING_IDX["part_id"]], vals[LISTING_IDX["supplier_id"]])] = vals

ladders = {}  # listing_id -> {min_quantity: [break_id, unit_price]}
stray_break_ids = []  # duplicate (listing, qty) rows — nothing forbids them
for bid, lid, qty, price in db.execute(
    select(
        PriceBreak.id, PriceBreak.listing_id, PriceBreak.min_quantity, PriceBreak.unit_price
    ).execution_options(yield_per=5000)
):
    ladder = ladders.setdefault(lid, {})
    if qty in ladder:
        stray_break_ids.append(bid)  # keep the first, drop the twin
    else:
        ladder[qty] = [bid, price]


def find_part(sku, manufacturer):
    """Identity first; the sku-only bucket only when ONE side lacks a maker —
    two named makers sharing an MPN are two parts (the 6.8V/68V rule) and must
    never meet through the fallback."""
    entry = parts_by_identity.get(part_identity(sku, manufacturer))
    if entry is not None:
        return entry
    fallback = parts_by_sku.get(sku.upper())
    if fallback is None:
        return None
    if not manufacturer or not fallback[PART_IDX["manufacturer_name"]]:
        return fallback
    return None


# Parts whose offers this file MOVED (new listing, moved unit_price, or any
# rung change) — the only ones parts.best_price* (migration 046) can be stale
# on. The old loader added every part the file mentioned.
repriced_part_ids = set()

# Batched Core writes, flushed with each commit. Break updates are a uniform
# {id, unit_price} shape so they can ride one executemany; listing/part
# updates change ragged column sets and go out as individual statements.
break_inserts: list[dict] = []
break_updates: list[dict] = []
break_deletes: list[uuid.UUID] = list(stray_break_ids)


def flush_breaks():
    # Pending ORM adds (new listings) must reach the DB before Core inserts
    # that reference their ids — never assume the session autoflushes.
    db.flush()
    if break_inserts:
        db.execute(insert(PriceBreak), break_inserts)
        counts["breaks_written"] += len(break_inserts)
        break_inserts.clear()
    if break_updates:
        db.execute(update(PriceBreak), break_updates)
        counts["breaks_repriced"] += len(break_updates)
        break_updates.clear()
    if break_deletes:
        db.execute(delete(PriceBreak).where(PriceBreak.id.in_(break_deletes)))
        counts["breaks_deleted"] += len(break_deletes)
        break_deletes.clear()


def set_fields(obj, data, skip):
    """New-row construction: copy export values onto the ORM row, only for
    columns the model has (ids are minted client-side, so no flush needed)."""
    cols = {c.name for c in obj.__table__.columns}
    for key, val in data.items():
        if key in skip or key not in cols or key == "id":
            continue
        col = obj.__table__.columns[key]
        if val is not None and str(col.type).startswith(("NUMERIC", "DECIMAL")):
            val = Decimal(str(val))
        if str(col.type).startswith(("DATETIME", "TIMESTAMP")):
            continue
        setattr(obj, key, val)


seen_part_identities: set = set()
seen_listing_keys: set = set()

pending = 0
for line_no, line in enumerate(open(sys.argv[1], encoding="utf-8"), 1):
    rec = json.loads(line)
    kind = rec.pop("t")

    if kind == "supplier":
        row = sups.get(rec["name"])
        if row is None:
            row = Supplier(id=uuid.uuid4(), name=rec["name"])
            set_fields(row, rec, skip=SUPPLIER_SKIP)
            db.add(row)
            sups[row.name] = row
            counts["suppliers_new"] += 1
        else:
            changed = False
            for key, val in rec.items():
                if key in SUPPLIER_SKIP or key == "id":
                    continue
                col = row.__table__.columns.get(key)
                if col is None or str(col.type).startswith(("DATETIME", "TIMESTAMP")):
                    continue
                if val is not None and str(col.type).startswith(("NUMERIC", "DECIMAL")):
                    val = Decimal(str(val))
                if getattr(row, key) != val:
                    setattr(row, key, val)
                    changed = True
            if changed:
                counts["suppliers_updated"] += 1

    elif kind == "part":
        cat = cats.get(rec.get("category_slug"))
        if cat is None:
            counts["parts_skipped_no_category"] += 1
            continue
        identity = part_identity(rec["sku"], rec.get("manufacturer_name"))
        if identity in seen_part_identities:
            counts["twin_part_lines_skipped"] += 1
            continue
        seen_part_identities.add(identity)
        entry = find_part(rec["sku"], rec.get("manufacturer_name"))
        if entry is None:
            row = Part(id=uuid.uuid4(), sku=rec["sku"], category_id=cat.id)
            set_fields(row, rec, skip=PART_SKIP)
            db.add(row)
            vals = [getattr(row, c) for c in PART_COLS]
            parts_by_identity[part_identity(rec["sku"], rec.get("manufacturer_name"))] = vals
            parts_by_sku.setdefault(rec["sku"].upper(), vals)
            counts["parts_new"] += 1
        else:
            changes = diff_fields(rec, entry, PART_IDX, PART_PLAN)
            if entry[PART_IDX["category_id"]] != cat.id:
                changes["category_id"] = cat.id
            if changes:
                db.execute(update(Part).where(Part.id == entry[PART_IDX["id"]]).values(**changes))
                # An adoption (blank-maker fallback) gains a manufacturer here;
                # register the new identity so this file's own listing lines
                # find it, and the stored name keeps a SECOND maker from
                # adopting the same row.
                if "manufacturer_name" in changes:
                    apply_changes(entry, PART_IDX, changes)
                    parts_by_identity.setdefault(
                        part_identity(rec["sku"], rec["manufacturer_name"]), entry
                    )
                else:
                    apply_changes(entry, PART_IDX, changes)
                counts["parts_updated"] += 1

    elif kind == "listing":
        part_entry = find_part(rec["part_sku"], rec.get("part_manufacturer"))
        sup = sups.get(rec["supplier_name"])
        if part_entry is None or sup is None:
            counts["listings_skipped"] += 1
            continue
        pid = part_entry[PART_IDX["id"]]
        lkey = (pid, sup.id)
        if lkey in seen_listing_keys:
            counts["twin_listing_lines_skipped"] += 1
            continue
        seen_listing_keys.add(lkey)
        lentry = listings.get(lkey)
        if lentry is None:
            row = PartListing(id=uuid.uuid4(), part_id=pid, supplier_id=sup.id)
            set_fields(row, rec, skip=LISTING_NATURAL)
            db.add(row)
            lid = row.id
            listings[lkey] = [getattr(row, c) for c in LISTING_COLS]
            counts["listings_new"] += 1
            repriced_part_ids.add(pid)
        else:
            lid = lentry[LISTING_IDX["id"]]
            changes = diff_fields(rec, lentry, LISTING_IDX, LISTING_PLAN)
            if changes:
                db.execute(update(PartListing).where(PartListing.id == lid).values(**changes))
                apply_changes(lentry, LISTING_IDX, changes)
                counts["listings_updated"] += 1
                if "unit_price" in changes:
                    repriced_part_ids.add(pid)

        # Rung-by-rung ladder reconcile — the importer's semantics, over the
        # preloaded state instead of a per-listing SELECT.
        wanted = {
            int(pb["min_quantity"]): Decimal(str(pb["unit_price"]))
            for pb in rec.get("price_breaks", [])
        }
        have = ladders.setdefault(lid, {})
        moved = False
        for qty, price in wanted.items():
            cur = have.get(qty)
            if cur is None:
                nid = uuid.uuid4()
                break_inserts.append(
                    {"id": nid, "listing_id": lid, "min_quantity": qty, "unit_price": price}
                )
                have[qty] = [nid, price]
                moved = True
            elif cur[1] != price:
                break_updates.append({"id": cur[0], "unit_price": price})
                cur[1] = price
                moved = True
        for qty in [q for q in have if q not in wanted]:
            break_deletes.append(have.pop(qty)[0])
            moved = True
        if moved:
            repriced_part_ids.add(pid)

    pending += 1
    if pending >= 2000:
        flush_breaks()
        db.commit()
        pending = 0
        if line_no % 50000 < 2000:
            print(f"...line {line_no}", file=sys.stderr)

flush_breaks()
db.commit()

# AFTER the load, not during it: the export writes a part's listings across
# several lines, so a per-line refresh would recompute the same part once per
# distributor and still be wrong until the last one landed. Batched internally.
print(f"...refreshing best prices on {len(repriced_part_ids)} parts", file=sys.stderr)
counts["best_prices_refreshed"] = refresh_best_prices(db, repriced_part_ids)
db.commit()
print(json.dumps(counts, indent=2))
