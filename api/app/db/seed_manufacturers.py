"""Seed + merge the manufacturers universe (synthesis §5.3 steps 1-6).

Auto-merge boundary = canon equality, NOTHING else. Slash-head and prefix
similarities become manufacturer_merge_candidates for HUMAN review — the
measured cost of auto-prefix was folding Amphenol's 26 deliberately-distinct
brands into one row. Idempotent: keyed on canonical_key / alias_canon; a
re-run creates zero rows. Bulk reads only (the 2026-08-20 seed-perf lesson:
never a per-row existence probe).
"""

from __future__ import annotations

import csv
import re
import uuid
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session, aliased

from app.models import Manufacturer, ManufacturerAlias, ManufacturerMergeCandidate, Part
from app.services.manufacturer_canon import canon, domain_of

_NEVER_MERGE = [
    # (left canon, right canon, evidence) — from the call list's own warning.
    (
        "microchip technology",
        "microchip usa",
        "call list: 'INDEPENDENT — not Microchip Technology'",
    ),
]


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")
    return s or "manufacturer"


def seed_manufacturers(db: Session, csv_path: Path | None = None) -> dict:
    path = csv_path or Path(__file__).parent / "seed_data" / "manufacturers.csv"
    if not path.exists():
        print("Seed: manufacturers.csv not found, skipping manufacturers.")
        return {}

    counts = {
        "manufacturers_csv": 0,
        "manufacturers_created": 0,
        "catalog_names": 0,
        "provisional_created": 0,
        "aliases_created": 0,
        "candidates_created": 0,
        "parts_backfilled": 0,
        "parts_collision_skipped": 0,
    }

    by_canon = {m.canonical_key: m for m in db.query(Manufacturer).all()}
    existing_slugs = {m.slug for m in by_canon.values()}
    alias_by_canon = {a.alias_canon: a.manufacturer_id for a in db.query(ManufacturerAlias).all()}
    existing_candidates = {
        (str(c.left_manufacturer_id), c.right_alias, c.rule)
        for c in db.query(ManufacturerMergeCandidate).all()
    }

    def unique_slug(name: str) -> str:
        base = _slugify(name)
        slug, n = base, 2
        while slug in existing_slugs:
            slug, n = f"{base}-{n}", n + 1
        existing_slugs.add(slug)
        return slug

    def add_alias(m: Manufacturer, raw: str, key: str, source: str) -> None:
        if key in alias_by_canon:
            return
        db.add(
            ManufacturerAlias(
                manufacturer_id=m.id,
                alias_canon=key,
                alias=raw[:200],
                source=source,
                confidence="auto",
            )
        )
        alias_by_canon[key] = m.id
        counts["aliases_created"] += 1

    def add_candidate(
        left: Manufacturer, right_alias: str, rule: str, evidence: str, status: str = "pending"
    ) -> None:
        sig = (str(left.id), right_alias[:200], rule)
        if sig in existing_candidates:
            return
        db.add(
            ManufacturerMergeCandidate(
                id=uuid.uuid4(),
                left_manufacturer_id=left.id,
                right_alias=right_alias[:200],
                rule=rule,
                evidence=evidence,
                status=status,
            )
        )
        existing_candidates.add(sig)
        counts["candidates_created"] += 1

    def get_or_create(
        name: str, key: str, source: str, website: str | None = None, external: int | None = None
    ) -> Manufacturer:
        m = by_canon.get(key)
        if m is not None:
            return m
        m = Manufacturer(
            id=uuid.uuid4(),
            name=name[:200],
            slug=unique_slug(name),
            canonical_key=key,
            website=(website or None),
            external_part_count=external,
            external_part_count_source="breakdown_csv" if external is not None else None,
            source=source,
        )
        db.add(m)
        by_canon[key] = m
        counts["manufacturers_created"] += 1
        return m

    # ── Step 1: the breakdown CSV ────────────────────────────────────────
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("Company") or "").strip()]
    counts["manufacturers_csv"] = len(rows)

    csv_first_name: dict[str, str] = {}
    for r in rows:
        name = r["Company"].strip()
        key = canon(name)
        dom = domain_of(r.get("URL"))
        external = (
            int(r["Number of parts"])
            if str(r.get("Number of parts", "")).strip().isdigit()
            else None
        )
        first = csv_first_name.get(key)
        if first is not None and first != name:
            # CSV-internal canon collision (Amphenol / Amphenol Ltd): keep BOTH
            # rows — the URL column disagrees, so merging is a human's call.
            key2 = f"{key}|{dom or _slugify(name)}"[:220]
            m2 = get_or_create(name, key2, "csv", r.get("URL", "").strip() or None, external)
            add_alias(m2, name, key2, "breakdown")
            add_candidate(
                by_canon[key],
                name,
                "csv-collision",
                f"same canon '{key}' as '{first}'; domains differ",
            )
            continue
        csv_first_name[key] = name
        m = get_or_create(name, key, "csv", r.get("URL", "").strip() or None, external)
        add_alias(m, name, key, "breakdown")

    db.flush()

    # ── Step 2-3: live catalog names attach or create provisional rows ───
    catalog_names = [n for (n,) in db.query(Part.manufacturer_name).distinct() if n]
    counts["catalog_names"] = len(catalog_names)
    for raw in catalog_names:
        key = canon(raw)
        if not key:
            continue
        m = by_canon.get(key)
        if m is None:
            m = get_or_create(raw, key, "catalog")
            counts["provisional_created"] += 1
        add_alias(m, raw, key, "catalog")

    db.flush()

    # ── Step 4: review candidates (NEVER auto-applied) ───────────────────
    for raw in catalog_names:
        if "/" in raw:
            head = canon(raw.split("/")[0])
            key = canon(raw)
            if head and head != key and head in by_canon:
                add_candidate(
                    by_canon[head],
                    raw,
                    "slash-head",
                    f"'{raw}' head-matches '{by_canon[head].name}'",
                )
    keys_sorted = sorted(by_canon)
    for i, key in enumerate(keys_sorted):
        prefix = key + " "
        j = i + 1
        while j < len(keys_sorted) and keys_sorted[j].startswith(prefix):
            longer = by_canon[keys_sorted[j]]
            add_candidate(
                by_canon[key], longer.name, "prefix", f"'{longer.canonical_key}' extends '{key}'"
            )
            j += 1

    for left_key, right_key, evidence in _NEVER_MERGE:
        left, right = by_canon.get(left_key), by_canon.get(right_key)
        if left is not None and right is not None:
            add_candidate(left, right.name, "never", evidence, status="rejected")

    db.flush()

    # ── Step 5: backfill parts.manufacturer_id (bulk, per manufacturer) ──
    #
    # COLLISION-TOLERANT (hardened 2026-08-30, after the second crash-loop).
    # An unlinked TWIN — same sku and maker as a row that is already linked,
    # legal under uq_parts_manufacturer_sku_upper only because NULLs compare
    # distinct — cannot be linked: the UPDATE would collide with the original
    # and kill the boot (6 twins did exactly that on 2026-08-27; 48 more
    # existed by 2026-08-28). Such twins are left unlinked ON PURPOSE — they
    # are duplicate ROWS, and linking is not the tool that merges rows. They
    # are counted out loud below so the backlog is visible, not silent.
    raw_to_mid: dict[str, uuid.UUID] = {}
    for raw in catalog_names:
        mid = alias_by_canon.get(canon(raw))
        if mid is not None:
            raw_to_mid[raw] = mid
    mids: dict[uuid.UUID, list[str]] = {}
    for raw, mid in raw_to_mid.items():
        mids.setdefault(mid, []).append(raw)
    for mid, names in mids.items():
        linked_twin = aliased(Part)
        collides = (
            db.query(linked_twin.id)
            .filter(
                linked_twin.manufacturer_id == mid,
                func.upper(linked_twin.sku) == func.upper(Part.sku),
            )
            .exists()
        )
        counts["parts_backfilled"] += (
            db.query(Part)
            .filter(Part.manufacturer_name.in_(names), Part.manufacturer_id.is_(None), ~collides)
            .update({Part.manufacturer_id: mid}, synchronize_session=False)
        )
    if raw_to_mid:
        counts["parts_collision_skipped"] = (
            db.query(func.count(Part.id))
            .filter(Part.manufacturer_name.in_(list(raw_to_mid)), Part.manufacturer_id.is_(None))
            .scalar()
            or 0
        )

    # ── Step 6: recompute catalog_part_count (one GROUP BY) ──────────────
    live = dict(
        (row[0], row[1])
        for row in db.query(Part.manufacturer_id, func.count(Part.id))
        .filter(Part.manufacturer_id.isnot(None))
        .group_by(Part.manufacturer_id)
        .all()
    )
    for m in by_canon.values():
        m.catalog_part_count = live.get(m.id, 0)

    db.flush()
    print(
        f"Seed: manufacturers — {counts['manufacturers_created']} created "
        f"({counts['provisional_created']} provisional), {counts['aliases_created']} aliases, "
        f"{counts['candidates_created']} review candidates, {counts['parts_backfilled']} parts linked, "
        f"{counts['parts_collision_skipped']} collision twins left unlinked."
    )
    return counts
