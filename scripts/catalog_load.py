"""Load a catalog_export.py JSONL into THIS environment's DB by natural keys.

Additive/upsert only — never deletes anything the export doesn't mention, so
prod-only rows (sponsors, users, page_views...) are untouched. Idempotent:
re-running converges to the same state. Price breaks are replaced wholesale
per listing (importer semantics).

Run (inside the api container):  python catalog_load.py export.jsonl
"""

import json
import sys
import uuid
from decimal import Decimal

from app.db.session import SessionLocal
from app.models import Category, Part, PartListing, PriceBreak, Supplier

# manufacturer_id: a per-environment surrogate (036) — never applied even if
# an old export file carries it; seed_manufacturers step 5 re-links by name.
PART_SKIP = {"category_slug", "t", "manufacturer_id"}
SUPPLIER_SKIP = {"manufacturer_id"}
LISTING_NATURAL = {"part_sku", "part_manufacturer", "supplier_name", "price_breaks", "t"}

db = SessionLocal()
cats = {c.slug: c for c in db.query(Category).all()}
sups = {s.name: s for s in db.query(Supplier).all()}
parts = {p.sku: p for p in db.query(Part).yield_per(500)}

counts = {
    "suppliers_new": 0, "suppliers_updated": 0,
    "parts_new": 0, "parts_updated": 0, "parts_skipped_no_category": 0,
    "listings_new": 0, "listings_updated": 0, "listings_skipped": 0,
    "breaks_written": 0,
}


def set_fields(obj, data, skip):
    """Copy export values onto the row, only for columns the model has."""
    cols = {c.name for c in obj.__table__.columns}
    changed = False
    for key, val in data.items():
        if key in skip or key not in cols or key in ("id",):
            continue
        col = obj.__table__.columns[key]
        if val is not None and str(col.type).startswith(("NUMERIC", "DECIMAL")):
            val = Decimal(str(val))
        if str(col.type).startswith(("DATETIME", "TIMESTAMP")):
            continue  # keep this environment's timestamps
        if getattr(obj, key) != val:
            setattr(obj, key, val)
            changed = True
    return changed


pending = 0
for line_no, line in enumerate(open(sys.argv[1], encoding="utf-8"), 1):
    rec = json.loads(line)
    kind = rec.pop("t")

    if kind == "supplier":
        row = sups.get(rec["name"])
        if row is None:
            row = Supplier(id=uuid.uuid4(), name=rec["name"])
            set_fields(row, rec, skip=SUPPLIER_SKIP)  # BEFORE flush: NOT NULL columns
            db.add(row)
            db.flush()
            sups[row.name] = row
            counts["suppliers_new"] += 1
        elif set_fields(row, rec, skip=SUPPLIER_SKIP):
            counts["suppliers_updated"] += 1

    elif kind == "part":
        cat = cats.get(rec.get("category_slug"))
        if cat is None:
            counts["parts_skipped_no_category"] += 1
            continue
        # Keyed on sku ALONE (2026-08-20 unification): seed.py and
        # part_feed/importer.py both key on sku; the old (sku, manufacturer)
        # key created a SECOND row when the same part arrived under a
        # different manufacturer spelling ("Diodes Inc." vs "Diodes
        # Incorporated") — prerequisite for a future UNIQUE(sku).
        key = rec["sku"]
        row = parts.get(key)
        if row is None:
            row = Part(id=uuid.uuid4(), sku=rec["sku"], category_id=cat.id)
            set_fields(row, rec, skip=PART_SKIP)  # BEFORE flush: NOT NULL columns
            db.add(row)
            db.flush()
            parts[key] = row
            counts["parts_new"] += 1
        else:
            changed = set_fields(row, rec, skip=PART_SKIP)
            if row.category_id != cat.id:
                row.category_id = cat.id
                changed = True
            if changed:
                counts["parts_updated"] += 1

    elif kind == "listing":
        part = parts.get(rec["part_sku"])
        sup = sups.get(rec["supplier_name"])
        if part is None or sup is None:
            counts["listings_skipped"] += 1
            continue
        row = (
            db.query(PartListing)
            .filter(PartListing.part_id == part.id, PartListing.supplier_id == sup.id)
            .first()
        )
        if row is None:
            row = PartListing(id=uuid.uuid4(), part_id=part.id, supplier_id=sup.id)
            set_fields(row, rec, skip=LISTING_NATURAL)  # BEFORE flush: NOT NULL columns
            db.add(row)
            db.flush()
            counts["listings_new"] += 1
        elif set_fields(row, rec, skip=LISTING_NATURAL):
            counts["listings_updated"] += 1
        db.query(PriceBreak).filter(PriceBreak.listing_id == row.id).delete()
        for pb in rec.get("price_breaks", []):
            db.add(
                PriceBreak(
                    id=uuid.uuid4(),
                    listing_id=row.id,
                    min_quantity=pb["min_quantity"],
                    unit_price=Decimal(str(pb["unit_price"])),
                )
            )
            counts["breaks_written"] += 1

    pending += 1
    if pending >= 500:
        db.commit()
        pending = 0
        print(f"...line {line_no}", file=sys.stderr)

db.commit()
print(json.dumps(counts, indent=2))
