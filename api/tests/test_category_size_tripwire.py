"""Deferred-paging TRIPWIRE — guards the fetch-everything category model.

The category page fetches every part for a top-level category in ONE request
(`per_page=500`), then filters/sorts/paginates client-side. Per the approved
spec (docs/superpowers/specs/2026-06-07-category-page-performance-design.md),
server-side paging is DEFERRED because at today's scale it would hurt nav
fluidity for a negligible cold-load gain. This test is the automatic signal
for if/when that ever needs to flip.

It computes, for the SEEDED real catalog, each top-level category's part
rollup — the SUM of its children's parts, which is exactly what
`category_service._build_popular_parts` loads for a parent page (the biggest
single-page set) — and asserts the max stays below 90% of the 500 cap.

WHY MEASURE THE CATALOG JSON DIRECTLY (not the conftest fixture, not a full
`seed(db)`):
  - The conftest `seeded_db` fixture has only 2 parts — asserting against it
    would give false comfort (it can never trip). The REAL ~3,600-part catalog
    is what matters.
  - A full `seed(db)` reproduces the exact prod rollup (PMICs = 325) but costs
    ~35s — too heavy for a guard that runs in every suite run.
  - `api/app/db/catalog_data/*.json` IS the real catalog prod seeds from. This
    test replays seed's own attachment logic — map each `sub_slug` to its
    parent via `CATEGORY_DATA`, dedupe parts by SKU exactly as
    `_seed_real_catalog` does (`if existing: continue`) — so the number tracks
    the real data, in milliseconds, with no DB.
  - Small known delta: this yields 320 vs the DB's 325 (the difference is the
    handful of `_DEMO_CATALOG` demo parts the full seed also adds). Both are
    far below the 450 threshold; the JSON figure is slightly conservative.
  - The ULTIMATE check is prod: the live `/api/categories/` rollup sums.
"""

import json
from pathlib import Path

from app.db.seed import CATEGORY_DATA

# 90% of the 500 fetch-everything cap (per_page=500 at the 3 call sites).
ROLLUP_THRESHOLD = 450
CATALOG_DIR = Path(__file__).resolve().parents[1] / "app" / "db" / "catalog_data"


def _rollup_by_top_level() -> dict[str, int]:
    """Parts per top-level category = sum over its children, deduped by SKU —
    mirrors `_seed_real_catalog` (sorted files, skip already-seen SKU) and the
    `category_service._build_popular_parts` self+children rollup."""
    sub_to_parent: dict[str, str] = {}
    for _name, parent_slug, _icon, subs in CATEGORY_DATA:
        for _sub_name, sub_slug, _sub_icon in subs:
            sub_to_parent[sub_slug] = parent_slug

    seen_skus: set[str] = set()
    rollup: dict[str, int] = {}
    for jf in sorted(CATALOG_DIR.glob("*.json")):
        data = json.loads(jf.read_text())
        for sub_slug, parts_list in data.items():
            parent_slug = sub_to_parent.get(sub_slug)
            if parent_slug is None:
                continue  # unknown sub_slug — seed warns + skips it too
            for part in parts_list:
                sku = part["sku"]
                if sku in seen_skus:
                    continue  # _seed_real_catalog: `if existing: continue`
                seen_skus.add(sku)
                rollup[parent_slug] = rollup.get(parent_slug, 0) + 1
    return rollup


def test_catalog_dir_present():
    """Sanity: the real catalog is what we measure. If it ever moves, this
    tripwire must fail loudly rather than silently pass on an empty rollup."""
    assert CATALOG_DIR.is_dir(), f"catalog_data dir missing at {CATALOG_DIR}"
    assert any(CATALOG_DIR.glob("*.json")), "no catalog JSON files to measure"


def test_no_category_rollup_exceeds_fetch_everything_threshold():
    rollup = _rollup_by_top_level()
    assert rollup, "rollup empty — catalog JSON not measured (see CATALOG_DIR)"
    biggest_slug = max(rollup, key=lambda k: rollup[k])
    biggest = rollup[biggest_slug]
    assert biggest < ROLLUP_THRESHOLD, (
        f"DEFERRED-PAGING TRIPWIRE TRIPPED: top-level category "
        f"'{biggest_slug}' has grown to {biggest} parts in its rollup, past "
        f"the safe threshold of {ROLLUP_THRESHOLD} (90% of the 500 "
        f"fetch-everything cap). A category has grown past the safe threshold "
        f"for the fetch-everything model — time to build server-side paging. "
        f"See docs/superpowers/specs/2026-06-07-category-page-performance-"
        f"design.md (the 'Deferred' section)."
    )
