"""Export the local catalog (suppliers/parts/listings/breaks) as JSONL on
stdout, keyed by NATURAL keys — category slug, (sku, manufacturer), supplier
name — because UUIDs differ per environment. Paired with catalog_load.py.

CORE COLUMN SELECTS, NOT ORM ROWS (2026-08-28 rework). `Part` and
`PartListing` carry ``lazy="selectin"`` cascades, so hydrating them as ORM
objects dragged every listing and price break along per batch — the same
disease the seed's catalog probe was cured of. Measured on the full local
catalog (405,983 records): 2:06 as ORM rows, ~25s as tuples, byte-identical
output contract.

Run:  docker compose exec -T api python - < catalog_export.py > export.jsonl
"""

import json
import sys
from datetime import date, datetime

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import Category, Part, PartListing, PriceBreak, Supplier

db = SessionLocal()


def jsonable(val):
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    if val is None or isinstance(val, (str, int, float, bool)):
        return val
    return str(val)  # UUID / Decimal / enum -> str


def row_dict(mapping, skip=("id",)):
    return {k: jsonable(v) for k, v in mapping.items() if k not in skip}


cat_slug = {c.id: c.slug for c in db.query(Category).all()}
sup_name = {s.id: s.name for s in db.query(Supplier).all()}

n = 0
for row in db.execute(select(Supplier.__table__)).mappings():
    print(json.dumps({"t": "supplier", **row_dict(row, skip=("id", "manufacturer_id"))}))
    n += 1

part_key = {}  # part_id -> (sku, manufacturer)
for row in db.execute(select(Part.__table__).execution_options(yield_per=2000)).mappings():
    # manufacturer_id is a surrogate into a PER-ENVIRONMENT table (036) —
    # the importing side's seed re-links by name (seed_manufacturers step 5).
    d = row_dict(row, skip=("id", "category_id", "manufacturer_id"))
    d["category_slug"] = cat_slug.get(row["category_id"])
    part_key[row["id"]] = (row["sku"], row["manufacturer_name"])
    print(json.dumps({"t": "part", **d}))
    n += 1

breaks_by_listing = {}
for lid, qty, price in db.execute(
    select(PriceBreak.listing_id, PriceBreak.min_quantity, PriceBreak.unit_price).execution_options(
        yield_per=5000
    )
):
    breaks_by_listing.setdefault(lid, []).append({"min_quantity": qty, "unit_price": str(price)})

for row in db.execute(select(PartListing.__table__).execution_options(yield_per=2000)).mappings():
    pk = part_key.get(row["part_id"])
    sn = sup_name.get(row["supplier_id"])
    if not pk or not sn:
        continue
    d = row_dict(row, skip=("id", "part_id", "supplier_id", "manufacturer_id"))
    d.update(
        part_sku=pk[0],
        part_manufacturer=pk[1],
        supplier_name=sn,
        price_breaks=sorted(breaks_by_listing.get(row["id"], []), key=lambda x: x["min_quantity"]),
    )
    print(json.dumps({"t": "listing", **d}))
    n += 1

print(f"exported {n} records", file=sys.stderr)
