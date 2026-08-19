"""Export the local catalog (suppliers/parts/listings/breaks) as JSONL on
stdout, keyed by NATURAL keys — category slug, (sku, manufacturer), supplier
name — because UUIDs differ per environment. Paired with catalog_load.py.

Run:  docker compose exec -T api python - < catalog_export.py > export.jsonl
"""

import json
import sys
from datetime import date, datetime

from app.db.session import SessionLocal
from app.models import Category, Part, PartListing, PriceBreak, Supplier

db = SessionLocal()


def row_dict(obj, skip=("id",)):
    out = {}
    for col in obj.__table__.columns:
        if col.name in skip:
            continue
        val = getattr(obj, col.name)
        if isinstance(val, (datetime, date)):
            val = val.isoformat()
        elif val is not None and not isinstance(val, (str, int, float, bool)):
            val = str(val)  # UUID / Decimal / enum -> str
        out[col.name] = val
    return out


cat_slug = {c.id: c.slug for c in db.query(Category).all()}
sup_name = {s.id: s.name for s in db.query(Supplier).all()}

n = 0
for s in db.query(Supplier).all():
    print(json.dumps({"t": "supplier", **row_dict(s)}))
    n += 1

part_key = {}  # part_id -> (sku, manufacturer)
for p in db.query(Part).yield_per(500):
    d = row_dict(p, skip=("id", "category_id"))
    d["category_slug"] = cat_slug.get(p.category_id)
    part_key[p.id] = (p.sku, p.manufacturer_name)
    print(json.dumps({"t": "part", **d}))
    n += 1

breaks_by_listing = {}
for b in db.query(PriceBreak).yield_per(2000):
    breaks_by_listing.setdefault(b.listing_id, []).append(
        {"min_quantity": b.min_quantity, "unit_price": str(b.unit_price)}
    )

for li in db.query(PartListing).yield_per(500):
    pk = part_key.get(li.part_id)
    sn = sup_name.get(li.supplier_id)
    if not pk or not sn:
        continue
    d = row_dict(li, skip=("id", "part_id", "supplier_id"))
    d.update(
        part_sku=pk[0],
        part_manufacturer=pk[1],
        supplier_name=sn,
        price_breaks=sorted(
            breaks_by_listing.get(li.id, []), key=lambda x: x["min_quantity"]
        ),
    )
    print(json.dumps({"t": "listing", **d}))
    n += 1

print(f"exported {n} records", file=sys.stderr)
