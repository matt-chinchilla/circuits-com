# Circular Logo Crop + Brand-Color Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A circular-frame crop dialog for every logo upload (admin sponsor/supplier forms + Platinum drag-n-drop demo) and a primary/secondary brand-color picker (identified swatch options) persisted on the sponsorship and rendered as a full brand takeover on the sold Platinum board.

**Architecture:** New `@shared` units (crop modal, palette extraction, color utils, image encode) consumed by both bounded contexts; two new nullable `String(9)` columns on `sponsors` (migration 018) with hex validation at the write boundary and `safeHexColor` at the render boundary; read-side precedence `sponsor.brand_* or supplier.brand_*` plus a `brand_takeover` flag so the frontend can distinguish explicit sponsorship colors from the legacy supplier fallback.

**Tech Stack:** React 19 + TypeScript (strict) + SCSS Modules, FastAPI + SQLAlchemy + Alembic, vitest, pytest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-logo-crop-brand-colors-design.md`
**Provenance:** anchors and code claims below were verified against the repo by a 4-critic adversarial review (2026-07-10); all findings are folded in.

## Global Constraints

- Work on branch `updates`. One commit per task. **Never add `Co-Authored-By` lines to commits.**
- Frontend gates (run from `frontend/`): `npx tsc -b` (NOT `tsc --noEmit` — it is a NO-OP here), `npx eslint --ext .ts,.tsx src/`, `npm test`. Backend gate (from `api/`): `pytest tests/ -v`.
- **vitest has NO globals** (`frontend/vitest.config.ts` sets no `globals: true`): every test file explicitly does `import { describe, expect, it } from 'vitest';` and uses `describe/it` — never bare `test(...)`. `*.test.ts` is excluded from `tsc -b` and eslint, so only `npm test` catches mistakes here. Files needing DOM declare `// @vitest-environment happy-dom` on line 1.
- ESLint boundaries: `@shared` must not import from `@public` or `@admin`; `@admin` ↛ `@public`; `@public` ↛ `@admin`. INSIDE `@shared`, use relative imports between shared modules (`../utils/color`), matching existing @shared style.
- New `@shared` SCSS modules open with `@use '@shared/styles/variables' as *;` and `@use '@shared/styles/mixins' as *;` (ErrorBoundary.module.scss precedent). Use `$nav-blue`/`$executive-blue`/`$error-red` tokens — no hardcoded brand hexes — and `@include responsive(...)` breakpoints, not raw `@media` pixel values.
- **csFx invariants:** GAP 19 / shimmer .36 / dome R 72 / flip .34·255, the `frame()` loop, and the `destroyed`-guard (resurrection-leak fix, csFx.tsx:517-532) are UNTOUCHED. The only csFx change in this plan is removing `extractBrandColors` (csFx.tsx:651-710) after it is rehomed — nothing inside `mountTileField` changes.
- Image encode caps verbatim: output 256×256, `canvas.toDataURL('image/webp', 0.82)` → JPEG `0.85` fallback, `MAX_DATA_URL_BYTES = 64000`.
- Brand colors are exactly `#RRGGBB` (7 chars; columns are `String(9)`). Server rejects anything else with 422; client render sites gate through `safeHexColor`.
- Brand fields must be stamped at BOTH public `SponsorResponse` construction sites — `category_service._sponsor_board_dict` AND `routes/sponsors.py` keyword route. Both take `supplier` as `Supplier | None`: every supplier-sourced value uses the `x if supplier else None` guard the neighboring lines already carry.
- `sessionStorage.setItem` is ALWAYS wrapped in `try { … } catch { /* storage unavailable */ }` (Safari private mode / hardened browsers), with the state-committing work placed AFTER/OUTSIDE the try so behavior survives storage failure.
- TS strict: no unused vars (do not `_`-prefix). `?:` catches only `undefined` — use `| null` unions. Non-ASCII glyphs in JSX via HTML entities. Every SCSS class needs ≥1 declaration.
- Python: ruff line-length 100 with a PostToolUse `ruff format` hook — write code blocks pre-wrapped the way ruff format will keep them (magic trailing commas explode lists one-per-line). `alembic/versions/` is excluded from ruff; match 017's header verbatim there.
- **Completion claims require superpowers:verification-before-completion evidence, then `/verify` (drive the live app), per explicit user instruction.**
- Anchors below use `file:line` from a 2026-07-10 read; verify each anchor against the current file before editing — content wins over line numbers.

**Before Task 1 (baseline):** run `cd api && pytest tests/ -v` and `cd frontend && npm test && npx tsc -b` — all green before any change. If not, STOP and report.

---

### Task 1: Backend write path — sponsor brand columns + hex validation

**Files:**
- Create: `api/app/utils/color.py`
- Create: `api/alembic/versions/018_add_sponsor_brand_colors.py`
- Modify: `api/app/models/sponsor.py` (columns block, ~lines 24-45)
- Modify: `api/app/schemas/sponsor.py` (`AdminSponsorCreate` ~56-73, `AdminSponsorUpdate` ~75-91, `AdminSponsorResponse` ~32-55)
- Modify: `api/app/routes/admin_sponsors.py` (`_serialize`, lines 38-55; the POST create handler if it constructs `Sponsor(...)` with an explicit field list)
- Test: `api/tests/test_sponsor_brand_colors.py`

**Interfaces:**
- Consumes: `validate_optional_image_url` wiring pattern (`api/app/utils/image_url.py:10-24`, used at `schemas/sponsor.py:70-73`) — mirror it exactly.
- Produces: `Sponsor.brand_primary`, `Sponsor.brand_secondary` (`String(9)`, nullable); `validate_optional_hex_color(value: str | None) -> str | None`; `brand_primary`/`brand_secondary` accepted on admin create/update and returned by `AdminSponsorResponse`.

- [ ] **Step 1: Write the failing tests**

```python
"""Sponsor brand-color columns + hex validation (spec 2026-07-10)."""

import pytest

from app.models.sponsor import Sponsor
from app.utils.color import validate_optional_hex_color


def test_hex_validator_accepts_none_and_valid():
    assert validate_optional_hex_color(None) is None
    assert validate_optional_hex_color("#1d3a8f") == "#1d3a8f"
    assert validate_optional_hex_color("#ABCDEF") == "#ABCDEF"


@pytest.mark.parametrize(
    "bad",
    [
        "1d3a8f",
        "#1d3a8",
        "#1d3a8f0",
        "#1d3a8f00",
        "red",
        "#12345g",
        "javascript:x",
        "#1d3a8f;}",
        "",
    ],
)
def test_hex_validator_rejects_invalid(bad):
    with pytest.raises(ValueError):
        validate_optional_hex_color(bad)


def test_sponsor_brand_columns_metadata():
    # SQLite ignores VARCHAR length — assert on metadata (CLAUDE.md pattern)
    for name in ("brand_primary", "brand_secondary"):
        column = Sponsor.__table__.c[name]
        assert column.nullable
        assert column.type.length >= 7
```

Also add an API roundtrip test in the same file. Find the nearest existing admin-sponsor POST test (`grep -rln "admin/sponsors" api/tests/`) and mirror its exact fixtures/auth-header arrangement; the act/assert body is:

```python
    # arrange exactly like the neighboring admin sponsor POST test, then:
    payload["brand_primary"] = "#1d3a8f"
    payload["brand_secondary"] = "#9bb8ff"
    res = client.post("/api/admin/sponsors/", json=payload, headers=headers)
    assert res.status_code in (200, 201)
    body = res.json()
    assert body["brand_primary"] == "#1d3a8f"
    assert body["brand_secondary"] == "#9bb8ff"

    bad = client.patch(
        f"/api/admin/sponsors/{body['id']}", json={"brand_primary": "#zzz"}, headers=headers
    )
    assert bad.status_code == 422
```

- [ ] **Step 2: Run to verify failure** — `cd api && pytest tests/test_sponsor_brand_colors.py -v` → FAIL: `ModuleNotFoundError: app.utils.color` (and missing columns).

- [ ] **Step 3: Implement**

`api/app/utils/color.py` (complete file):

```python
"""Hex-color validation for sponsor brand colors.

Write-boundary defense: these values are stored and later rendered into
inline CSS custom properties on the public site, so only exact #RRGGBB
values are accepted (CSS-injection guard; mirrors utils/image_url.py).
"""

import re

_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


def validate_optional_hex_color(value: str | None) -> str | None:
    if value is None:
        return value
    if _HEX_COLOR.fullmatch(value):
        return value
    raise ValueError("must be a hex color like #1d3a8f")
```

`api/alembic/versions/018_add_sponsor_brand_colors.py` — header matches 017 verbatim (Create Date line included; `from alembic import op` BEFORE `import sqlalchemy as sa`; `alembic/versions/` is ruff-excluded so nothing auto-fixes drift):

```python
"""add sponsor brand color columns

Revision ID: 018
Revises: 017
Create Date: 2026-07-10
"""

from alembic import op
import sqlalchemy as sa

revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sponsors", sa.Column("brand_primary", sa.String(9), nullable=True))
    op.add_column("sponsors", sa.Column("brand_secondary", sa.String(9), nullable=True))


def downgrade() -> None:
    op.drop_column("sponsors", "brand_secondary")
    op.drop_column("sponsors", "brand_primary")
```

`api/app/models/sponsor.py` — after the `image_url` column (String is already imported for `tier`):

```python
    brand_primary = Column(String(9), nullable=True)
    brand_secondary = Column(String(9), nullable=True)
```

`api/app/schemas/sponsor.py` — add to `AdminSponsorCreate`, `AdminSponsorUpdate`, AND `AdminSponsorResponse`:

```python
    brand_primary: str | None = None
    brand_secondary: str | None = None
```

and on `AdminSponsorCreate` + `AdminSponsorUpdate` only (below the existing `_validate_image_url`, same style):

```python
    @field_validator("brand_primary", "brand_secondary")
    @classmethod
    def _validate_brand_colors(cls, value: str | None) -> str | None:
        return validate_optional_hex_color(value)
```

with `from app.utils.color import validate_optional_hex_color` added beside the existing `validate_optional_image_url` import.

`api/app/routes/admin_sponsors.py` — in `_serialize` (lines 38-55) stamp both fields using the function's actual local variable name:

```python
        "brand_primary": sponsor.brand_primary,
        "brand_secondary": sponsor.brand_secondary,
```

If the POST handler builds `Sponsor(...)` from an explicit field list (mirror how `image_url` flows), add `brand_primary=body.brand_primary, brand_secondary=body.brand_secondary`. If it uses `model_dump()`, no change. PATCH uses `model_dump(exclude_unset=True)` + `setattr` — flows automatically; the single-slot guard checks only `{category_id, tier, status}` so colors never trigger it.

- [ ] **Step 4: Run to verify pass** — `pytest tests/test_sponsor_brand_colors.py -v` → PASS; then full `pytest tests/ -v` → all green.

- [ ] **Step 5: Commit** — `git add -A api && git commit -m "feat(api): sponsor brand_primary/brand_secondary columns + hex validation (migration 018)"`

---

### Task 2: Backend read path — precedence + brand_takeover

**Files:**
- Modify: `api/app/schemas/sponsor.py` (`SponsorResponse`, lines 10-29)
- Modify: `api/app/services/category_service.py` (`_sponsor_board_dict`, lines 81-103 — signature is `def _sponsor_board_dict(sponsor: Sponsor, supplier: Supplier | None) -> dict:`)
- Modify: `api/app/routes/sponsors.py` (keyword route, lines 10-30 — NOTE: it returns a SINGLE `SponsorResponse` via `.first()`, not a list; the public keyword page consumes one object. Do NOT change the response shape.)
- Test: `api/tests/test_partners_brand_colors.py`

**Interfaces:**
- Consumes: `Sponsor.brand_primary/brand_secondary` (Task 1); existing `Supplier.brand_primary/brand_secondary` (`api/app/models/supplier.py:27-28`).
- Produces: public `SponsorResponse.brand_takeover: bool` (default `False`); resolved `brand_primary`/`brand_secondary` = `sponsor value or (supplier value if supplier else None)` at both construction sites. Task 8 relies on the exact field name `brand_takeover`.

- [ ] **Step 1: Write the failing tests** — arrange with the same helpers the existing `/partners` tests use (`grep -rln "partners" api/tests/`); assertions:

```python
def test_partners_supplier_fallback_no_takeover(...):
    # supplier has brand colors, sponsor does not
    res = client.get(f"/api/categories/{slug}/partners")
    p = res.json()["platinum"]
    assert p["brand_primary"] == supplier_brand_primary
    assert p["brand_takeover"] is False


def test_partners_sponsor_overrides_supplier(...):
    # sponsor.brand_primary = "#112233" while supplier has different colors
    p = client.get(f"/api/categories/{slug}/partners").json()["platinum"]
    assert p["brand_primary"] == "#112233"
    assert p["brand_takeover"] is True


def test_keyword_sponsor_carries_brand_fields(...):
    # Route returns ONE sponsor object (query .first(), response_model=SponsorResponse)
    body = client.get(f"/api/sponsors/keyword/{keyword}").json()
    assert "brand_primary" in body
    assert "brand_takeover" in body
```

- [ ] **Step 2: Run to verify failure** — `pytest tests/test_partners_brand_colors.py -v` → FAIL (`brand_takeover` missing).

- [ ] **Step 3: Implement**

`SponsorResponse` gains:

```python
    brand_takeover: bool = False
```

`_sponsor_board_dict` — replace the two existing `brand_*` stamps (currently `supplier.brand_primary if supplier else None`, lines 101-102), KEEPING the None-guard every neighboring line carries, and add the flag:

```python
        "brand_primary": sponsor.brand_primary or (supplier.brand_primary if supplier else None),
        "brand_secondary": sponsor.brand_secondary
        or (supplier.brand_secondary if supplier else None),
        "brand_takeover": bool(sponsor.brand_primary or sponsor.brand_secondary),
```

`routes/sponsors.py` keyword route — extend its hand-built `SponsorResponse` with the same three stamps, using the SAME `x if supplier else None` guard style as its neighboring supplier fields (lines 18-29). Note the route's own inline comment about previously-missed fields — this is that trap.

- [ ] **Step 4: Run to verify pass** — `pytest tests/ -v` → all green (existing partners tests must not regress).

- [ ] **Step 5: Commit** — `git commit -am "feat(api): resolve sponsor-over-supplier brand colors + brand_takeover on public sponsor payloads"`

---

### Task 3: `@shared/utils/image.ts` — move + `canvasToDataUrl` + `loadImage`

**Files:**
- Move: `git mv frontend/src/admin/utils/image.ts frontend/src/shared/utils/image.ts` AND `git mv frontend/src/admin/utils/image.test.ts frontend/src/shared/utils/image.test.ts` (the test file EXISTS and imports `./image`, so a content-grep for "utils/image" misses it; it keeps its line-1 `// @vitest-environment happy-dom` directive)
- Modify: every importer found by `grep -rln "utils/image" frontend/src` (known: `frontend/src/admin/components/ImageUploadField.tsx:3`) → `@shared/utils/image`
- Test: `frontend/src/shared/utils/image.test.ts`

**Interfaces:**
- Produces (exact exports Tasks 5-8 rely on):
  - `canvasToDataUrl(canvas: HTMLCanvasElement): ImageEncodeResult`
  - `loadImage(url: string, crossOrigin?: 'anonymous'): Promise<HTMLImageElement>` (promote the existing internal helper — repo name is `loadImage` at image.ts:11; the spec's units table says `loadImageFromFile`, which is a stale name — to an export; set `img.crossOrigin` BEFORE `img.src` when provided)
  - `fileToDataUrl` moved BYTE-IDENTICAL (no internal refactor — Task 6 deletes it once consumer-less; refactoring it first is dead work)
  - `MAX_DATA_URL_BYTES`, `ImageEncodeResult` re-exported unchanged

- [ ] **Step 1: Write the failing tests** — append to the (moved) test file, matching its existing `import { describe, it, expect } from 'vitest';` style (use `it(...)`, NOT bare `test(...)` — vitest globals are off):

```ts
import { canvasToDataUrl, MAX_DATA_URL_BYTES } from './image';

const stubCanvas = (byMime: Record<string, string>) =>
  ({ toDataURL: (mime: string) => byMime[mime] ?? 'data:image/png;base64,x' }) as unknown as HTMLCanvasElement;

describe('canvasToDataUrl', () => {
  it('prefers webp', () => {
    const r = canvasToDataUrl(stubCanvas({ 'image/webp': 'data:image/webp;base64,ok' }));
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/webp;base64,ok' });
  });

  it('falls back to jpeg when webp encodes as png', () => {
    const r = canvasToDataUrl(stubCanvas({ 'image/jpeg': 'data:image/jpeg;base64,ok' }));
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,ok' });
  });

  it('rejects oversized output', () => {
    const huge = `data:image/webp;base64,${'a'.repeat(MAX_DATA_URL_BYTES)}`;
    const r = canvasToDataUrl(stubCanvas({ 'image/webp': huge }));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd frontend && npm test` → FAIL (`canvasToDataUrl` not exported).

- [ ] **Step 3: Implement** — `git mv` both files, update imports, then inside `image.ts`:

```ts
/**
 * Encode a canvas to a bounded data-URL: WebP 0.82 with JPEG 0.85 fallback
 * (Safari cannot encode WebP — toDataURL silently returns PNG there).
 */
export function canvasToDataUrl(canvas: HTMLCanvasElement): ImageEncodeResult {
  try {
    let dataUrl = canvas.toDataURL('image/webp', 0.82);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    }
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      return { ok: false, error: 'That image is too detailed to store. Try a simpler version.' };
    }
    return { ok: true, dataUrl };
  } catch (err) {
    console.error('canvasToDataUrl failed', err);
    return { ok: false, error: 'Your browser could not process this image.' };
  }
}
```

Promote `loadImage` to an export with the optional `crossOrigin` param (must assign `img.crossOrigin` before `img.src`). Leave `fileToDataUrl` byte-identical.

- [ ] **Step 4: Verify** — `npm test` PASS, `npx tsc -b` clean, `npx eslint --ext .ts,.tsx src/` clean (shared imports nothing from admin/public).

- [ ] **Step 5: Commit** — `git commit -am "refactor(shared): move image encode utils to @shared, add canvasToDataUrl + loadImage export"`

---

### Task 4: `@shared` color + palette utils; rehome extraction out of csFx

**Files:**
- Create: `frontend/src/shared/utils/color.ts`, `frontend/src/shared/utils/brandPalette.ts`
- Modify: `frontend/src/public/pages/category/components/csFx.tsx` (DELETE `extractBrandColors` at 651-710 + any private helpers only it used; `brandVars`/`_csMix`/`_csRGB` at 712-749 STAY; nothing inside `mountTileField` changes)
- Modify: `frontend/src/public/pages/category/components/CategorySponsor.tsx` (import swap at the `extractBrandColors` call, line ~416)
- Test: `frontend/src/shared/utils/color.test.ts`, `frontend/src/shared/utils/brandPalette.test.ts`

**Interfaces:**
- Produces (exact, relied on by Tasks 7-8):

```ts
// color.ts
export function safeHexColor(value: string | null | undefined): string | null; // strict /^#[0-9a-f]{6}$/i, trimmed
export function rgbToHex(r: number, g: number, b: number): string;             // clamps + rounds
export function mixHex(a: string, b: string, weightA: number): string;         // per-channel sRGB mix

// brandPalette.ts (imports './color' relatively — intra-@shared style)
export interface BrandPalette { primary: string; secondary: string; swatches: string[] }
export function paletteFromPixels(data: Uint8ClampedArray, pixelCount: number): BrandPalette; // pure core
export function extractBrandPalette(source: HTMLImageElement | HTMLCanvasElement): BrandPalette | null; // canvas shell; null on taint/decode failure
export const DEFAULT_PALETTE: BrandPalette;
```

**CRITICAL PARITY RULE:** first READ `csFx.tsx:651-710` and port the arithmetic 1:1 — sample size 28, alpha ≥140, lightness bounds 0.06/0.94 computed as `(max+min)/510`, saturation `(max-min)/max ≥ 0.28`, 24° hue buckets, primary = most-populated bucket average (fallback: all-surviving-pixel average, then `#3a6ea5`), secondary = runner-up bucket (> 20% of winner) mixed 72% toward `#ffffff`, else primary mixed 52% toward `#ffffff`. The ONLY intended change: `color-mix(...)` strings become concrete hex via `mixHex` (numerically identical), and the ranked bucket averages (top 6) are returned as `swatches`. On any discrepancy between this plan and the original code, the original wins.

- [ ] **Step 1: Write the failing tests**

```ts
// color.test.ts
import { describe, expect, it } from 'vitest';
import { mixHex, rgbToHex, safeHexColor } from './color';

describe('safeHexColor', () => {
  it('accepts exactly #RRGGBB (any case, trimmed)', () => {
    expect(safeHexColor('#1d3a8f')).toBe('#1d3a8f');
    expect(safeHexColor('  #ABCdef ')).toBe('#ABCdef');
    for (const bad of [null, undefined, '', '1d3a8f', '#1d3a8', '#1d3a8f00', 'red', '#12345g', 'url(x)'])
      expect(safeHexColor(bad)).toBeNull();
  });
});

describe('mixHex', () => {
  it('matches color-mix(in srgb) per-channel math', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#ff0000', '#ffffff', 0.72)).toBe(rgbToHex(255, 0.28 * 255, 0.28 * 255));
  });
});
```

```ts
// brandPalette.test.ts — synthetic pixel arrays, no canvas needed
import { describe, expect, it } from 'vitest';
import { paletteFromPixels } from './brandPalette';
import { mixHex } from './color';

const px = (colors: Array<[number, number, number, number]>) => {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach(([r, g, b, a], i) => data.set([r, g, b, a], i * 4));
  return data;
};

describe('paletteFromPixels', () => {
  it('single saturated hue wins as primary; secondary is the 52% white mix', () => {
    const p = paletteFromPixels(px(Array(20).fill([255, 0, 0, 255])), 20);
    expect(p.primary).toBe('#ff0000');
    expect(p.swatches[0]).toBe('#ff0000');
    expect(p.secondary).toBe(mixHex('#ff0000', '#ffffff', 0.52)); // parity with csFx 52% branch
  });

  it('runner-up hue above 20% drives the secondary via the 72% white mix', () => {
    const p = paletteFromPixels(
      px([...Array(10).fill([255, 0, 0, 255]), ...Array(5).fill([0, 0, 255, 255])]),
      15,
    );
    expect(p.swatches).toEqual(['#ff0000', '#0000ff']);
    expect(p.secondary).toBe(mixHex('#0000ff', '#ffffff', 0.72)); // parity with csFx 72% branch
  });

  it('near-white, near-black and transparent pixels are ignored', () => {
    const p = paletteFromPixels(px([[250, 250, 250, 255], [5, 5, 5, 255], [255, 0, 0, 10]]), 3);
    expect(p.primary).toBe('#3a6ea5'); // hard fallback — nothing survived
  });

  it('unsaturated pixels only reach the fallback average', () => {
    const p = paletteFromPixels(px(Array(4).fill([128, 128, 128, 255])), 4);
    expect(p.primary).toBe('#808080');
    expect(p.swatches).toEqual(['#808080']); // fallback primary is the only swatch
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL (modules missing).

- [ ] **Step 3: Implement** — `color.ts` complete:

```ts
/** Strict #RRGGBB gate for stored brand colors (defense-in-depth mirror of safeImageUrl). */
export function safeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : null;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** Per-channel sRGB mix — numerically equivalent to CSS color-mix(in srgb, a W%, b). */
export function mixHex(a: string, b: string, weightA: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const w = weightA;
  return rgbToHex(pa.r * w + pb.r * (1 - w), pa.g * w + pb.g * (1 - w), pa.b * w + pb.b * (1 - w));
}
```

`brandPalette.ts` — port per the PARITY RULE (shape below; original arithmetic wins). The hue helper is shown in full — it mirrors csFx.tsx:677-684 including the `d <= 0 → 0` branch:

```ts
import { mixHex, rgbToHex } from './color';

export interface BrandPalette { primary: string; secondary: string; swatches: string[] }

// Constants preserved 1:1 from csFx.tsx extractBrandColors (2026-07-10).
const SAMPLE = 28;
const ALPHA_MIN = 140;
const LIGHT_MAX = 0.94;
const LIGHT_MIN = 0.06;
const SAT_MIN = 0.28;
const BUCKET_DEG = 24;
const FALLBACK_PRIMARY = '#3a6ea5';
const MAX_SWATCHES = 6;

interface Bucket { n: number; r: number; g: number; b: number }

/** HSL hue in degrees — mirrors csFx.tsx:677-684 exactly, including d<=0 → 0. */
function rgbHue(r: number, g: number, b: number, max: number, min: number): number {
  const d = max - min;
  if (d <= 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

export function paletteFromPixels(data: Uint8ClampedArray, pixelCount: number): BrandPalette {
  const buckets = new Map<number, Bucket>();
  let fbN = 0;
  let fbR = 0;
  let fbG = 0;
  let fbB = 0;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const a = data[o + 3];
    if (a < ALPHA_MIN) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 510;
    if (l > LIGHT_MAX || l < LIGHT_MIN) continue;
    fbN += 1; fbR += r; fbG += g; fbB += b;
    if (max === 0 || (max - min) / max < SAT_MIN) continue;
    const key = Math.floor(rgbHue(r, g, b, max, min) / BUCKET_DEG);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1; bucket.r += r; bucket.g += g; bucket.b += b;
    buckets.set(key, bucket);
  }
  const sorted = [...buckets.values()].sort((x, y) => y.n - x.n);
  const avg = (k: Bucket) => rgbToHex(k.r / k.n, k.g / k.n, k.b / k.n);
  const primary = sorted[0] ? avg(sorted[0]) : fbN ? rgbToHex(fbR / fbN, fbG / fbN, fbB / fbN) : FALLBACK_PRIMARY;
  const secondary = sorted[1] && sorted[1].n > sorted[0].n * 0.2
    ? mixHex(avg(sorted[1]), '#ffffff', 0.72)
    : mixHex(primary, '#ffffff', 0.52);
  const swatches = sorted.slice(0, MAX_SWATCHES).map(avg);
  return { primary, secondary, swatches: swatches.length ? swatches : [primary] };
}

export function extractBrandPalette(source: HTMLImageElement | HTMLCanvasElement): BrandPalette | null {
  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    return paletteFromPixels(data, SAMPLE * SAMPLE);
  } catch (err) {
    console.error('extractBrandPalette failed (tainted canvas?)', err);
    return null;
  }
}

export const DEFAULT_PALETTE: BrandPalette = {
  primary: FALLBACK_PRIMARY,
  secondary: mixHex(FALLBACK_PRIMARY, '#ffffff', 0.52),
  swatches: [FALLBACK_PRIMARY],
};
```

Rewire: in `CategorySponsor.tsx` (line ~416) replace `extractBrandColors(img)` with `extractBrandPalette(img) ?? DEFAULT_PALETTE` (destructure `primary`/`secondary` as before — behavior identical). Delete `extractBrandColors` + its now-orphaned private helpers from `csFx.tsx` (grep first: `grep -rn "extractBrandColors" frontend/src` must show zero importers afterward).

- [ ] **Step 4: Verify** — `npm test` PASS; `npx tsc -b` clean; `npx eslint --ext .ts,.tsx src/` clean; `grep -rn "extractBrandColors" frontend/src` → empty.

- [ ] **Step 5: Commit** — `git commit -am "refactor(shared): rehome brand-color extraction to @shared/brandPalette with ranked swatches + safeHexColor"`

---

### Task 5: `LogoCropperModal` (@shared)

**Files:**
- Create: `frontend/src/shared/components/LogoCropperModal/geometry.ts`
- Create: `frontend/src/shared/components/LogoCropperModal/index.tsx`
- Create: `frontend/src/shared/components/LogoCropperModal/LogoCropperModal.module.scss`
- Test: `frontend/src/shared/components/LogoCropperModal/geometry.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (self-contained; consumers encode the canvas themselves).
- Produces: `LogoCropperModal({ file: File; title?: string; onApply: (canvas: HTMLCanvasElement) => void; onCancel: () => void })` — Apply hands back a 256×256 canvas (white underfill, cover-crop). Geometry exports: `coverScale`, `clampOffset`, `sourceRect`, `MIN_ZOOM = 1`, `MAX_ZOOM = 4`, `OUTPUT_SIZE = 256`.

**WYSIWYG rule:** the RENDERED frame element is the geometry authority. CSS caps the frame below 320px on narrow screens, so the component MEASURES the frame (`clientWidth` + ResizeObserver) into `frameSize` state and threads that — never the 320 constant — into every geometry call. Otherwise mobile crops include content the user never saw.

- [ ] **Step 1: Write the failing geometry tests**

```ts
import { describe, expect, it } from 'vitest';
import { clampOffset, coverScale, sourceRect } from './geometry';

describe('crop geometry', () => {
  it('coverScale uses the short edge so the frame is always covered', () => {
    expect(coverScale(1000, 500, 320)).toBeCloseTo(0.64);
    expect(coverScale(500, 1000, 320)).toBeCloseTo(0.64);
  });

  it('clamps offsets so the image never uncovers the frame', () => {
    const s = coverScale(1000, 500, 320); // display 640x320 → maxX 160, maxY 0
    expect(clampOffset(1000, 500, 320, s, 999, 50)).toEqual({ offsetX: 160, offsetY: 0 });
    expect(clampOffset(1000, 500, 320, s, -999, -50)).toEqual({ offsetX: -160, offsetY: 0 });
  });

  it('centers the source rect at zoom 1 / no pan', () => {
    const s = coverScale(1000, 500, 320);
    const r = sourceRect(1000, 500, 320, s, 0, 0);
    expect(r.size).toBeCloseTo(500);
    expect(r.sx).toBeCloseTo(250);
    expect(r.sy).toBeCloseTo(0);
  });

  it('panning fully right reaches the left edge of the source', () => {
    const s = coverScale(1000, 500, 320);
    expect(sourceRect(1000, 500, 320, s, 160, 0).sx).toBeCloseTo(0);
  });

  it('zooming shrinks the source window and stays in bounds', () => {
    const s = coverScale(1000, 500, 320) * 2;
    const r = sourceRect(1000, 500, 320, s, 0, 0);
    expect(r.size).toBeCloseTo(250);
    expect(r.sx).toBeGreaterThanOrEqual(0);
  });

  it('geometry follows a smaller measured frame (mobile)', () => {
    const s = coverScale(1000, 500, 280);
    const r = sourceRect(1000, 500, 280, s, 0, 0);
    expect(r.size).toBeCloseTo(500); // short edge still fills the smaller frame
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL (module missing).

- [ ] **Step 3: Implement geometry** (`geometry.ts`, complete):

```ts
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const OUTPUT_SIZE = 256;

/** Display scale at zoom 1: smallest scale where the image covers the square frame. */
export function coverScale(imgW: number, imgH: number, frame: number): number {
  return frame / Math.min(imgW, imgH);
}

/** Clamp a pan offset (display px, relative to centered) so the frame stays covered. */
export function clampOffset(
  imgW: number, imgH: number, frame: number, scale: number, offsetX: number, offsetY: number,
): { offsetX: number; offsetY: number } {
  const maxX = Math.max(0, (imgW * scale - frame) / 2);
  const maxY = Math.max(0, (imgH * scale - frame) / 2);
  return {
    offsetX: Math.min(maxX, Math.max(-maxX, offsetX)),
    offsetY: Math.min(maxY, Math.max(-maxY, offsetY)),
  };
}

/** Source rect (image px) shown in the frame — feeds the 9-arg drawImage. */
export function sourceRect(
  imgW: number, imgH: number, frame: number, scale: number, offsetX: number, offsetY: number,
): { sx: number; sy: number; size: number } {
  const size = frame / scale;
  const sx = (imgW - size) / 2 - offsetX / scale;
  const sy = (imgH - size) / 2 - offsetY / scale;
  return {
    sx: Math.min(Math.max(0, sx), Math.max(0, imgW - size)),
    sy: Math.min(Math.max(0, sy), Math.max(0, imgH - size)),
    size,
  };
}
```

- [ ] **Step 4: Verify geometry tests pass**, then **Step 5: implement the component** (`index.tsx`, complete):

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampOffset, coverScale, MAX_ZOOM, MIN_ZOOM, OUTPUT_SIZE, sourceRect } from './geometry';
import styles from './LogoCropperModal.module.scss';

interface LogoCropperModalProps {
  file: File;
  title?: string;
  onApply: (canvas: HTMLCanvasElement) => void;
  onCancel: () => void;
}

const FRAME_MAX = 320; // upper bound; the RENDERED size (frameSize state) is the geometry authority

export function LogoCropperModal({ file, title = 'Position your logo', onApply, onCancel }: LogoCropperModalProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [frameSize, setFrameSize] = useState(FRAME_MAX);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [loadError, setLoadError] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{ id: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const scale = dims ? coverScale(dims.w, dims.h, frameSize) * zoom : 1;

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setDims(null);
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    setLoadError(false);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // The rendered frame is the geometry authority (CSS caps it on narrow screens)
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setFrameSize(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loadError]);

  // Re-clamp the pan whenever the constraint inputs change
  useEffect(() => {
    if (!dims) return;
    const s = coverScale(dims.w, dims.h, frameSize) * zoom;
    setOffset((o) => {
      const c = clampOffset(dims.w, dims.h, frameSize, s, o.x, o.y);
      return c.offsetX === o.x && c.offsetY === o.y ? o : { x: c.offsetX, y: c.offsetY };
    });
  }, [dims, frameSize, zoom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const nodes = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const applyZoom = useCallback((next: number) => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  }, []);

  // Wheel zoom: subscribe once (zoomRef avoids stale-closure step-dropping on fast wheels)
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyZoom(zoomRef.current * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, loadError]);

  const onImgLoad = () => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) { setLoadError(true); return; }
    setDims({ w: img.naturalWidth, h: img.naturalHeight });
    sliderRef.current?.focus();
  };

  const pan = (x: number, y: number) => {
    if (!dims) return;
    const c = clampOffset(dims.w, dims.h, frameSize, scale, x, y);
    setOffset({ x: c.offsetX, y: c.offsetY });
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dims) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    pan(d.baseX + (e.clientX - d.startX), d.baseY + (e.clientY - d.startY));
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  };

  const onArrows = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 20 : 5;
    if (e.key === 'ArrowLeft') { e.preventDefault(); pan(offset.x - step, offset.y); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pan(offset.x + step, offset.y); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pan(offset.x, offset.y - step); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); pan(offset.x, offset.y + step); }
  };

  const apply = () => {
    const img = imgRef.current;
    if (!img || !dims) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) { onCancel(); return; }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    const rect = sourceRect(dims.w, dims.h, frameSize, scale, offset.x, offset.y);
    ctx.drawImage(img, rect.sx, rect.sy, rect.size, rect.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    onApply(canvas);
  };

  return createPortal(
    <div className={styles.scrim} onClick={onCancel} role="presentation">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className={styles.title}>{title}</h2>
        {loadError ? (
          <p className={styles.error}>Couldn&rsquo;t read that image. Try a PNG, JPEG or WebP file.</p>
        ) : (
          <div
            ref={frameRef}
            className={styles.frame}
            tabIndex={0}
            aria-label="Logo position. Use arrow keys to move, or drag."
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onArrows}
          >
            {imageUrl && (
              <img
                ref={imgRef}
                src={imageUrl}
                alt=""
                draggable={false}
                onLoad={onImgLoad}
                onError={() => setLoadError(true)}
                className={styles.image}
                style={dims
                  ? { width: dims.w * scale, height: dims.h * scale, transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)` }
                  : { visibility: 'hidden' }}
              />
            )}
            <div className={styles.mask} aria-hidden="true" />
          </div>
        )}
        <label className={styles.zoomRow}>
          <span>Zoom</span>
          <input
            ref={sliderRef}
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!dims}
            onChange={(e) => applyZoom(Number(e.target.value))}
            aria-label="Zoom"
          />
        </label>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>Cancel</button>
          <button type="button" className={styles.apply} onClick={apply} disabled={!dims || loadError}>Apply</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
```

`LogoCropperModal.module.scss` (complete; tokens via @shared variables, no hardcoded brand hexes; scrollable on short viewports so Cancel/Apply are always reachable):

```scss
@use '@shared/styles/variables' as *;
@use '@shared/styles/mixins' as *;

.scrim {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow-y: auto;
  background: rgba(10, 12, 14, 0.62);
}

.dialog {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
  padding: 20px;
  max-width: calc(100vw - 32px);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  margin: auto 0;
}

.title {
  margin: 0 0 14px;
  font-size: 17px;
  font-weight: 600;
  color: #1a222c;
}

.frame {
  position: relative;
  width: min(320px, 100%);
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 12px;
  background: #0e1216;
  cursor: grab;
  touch-action: none;

  &:active { cursor: grabbing; }
  &:focus-visible { outline: 2px solid $nav-blue; outline-offset: 2px; }
}

.image {
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: none;
  user-select: none;
  pointer-events: none;
}

.mask {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow: 0 0 0 9999px rgba(10, 12, 14, 0.55);
  border: 2px solid rgba(255, 255, 255, 0.85);
  pointer-events: none;
}

.zoomRow {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 14px 0;
  font-size: 13px;
  color: #4a5568;

  input { flex: 1; }
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.cancel,
.apply {
  border-radius: 8px;
  padding: 8px 18px;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.cancel {
  background: #fff;
  border: 1px solid #cbd5e0;
  color: #2d3748;
}

.apply {
  background: $executive-blue;
  border: 1px solid $executive-blue;
  color: #fff;

  &:disabled { opacity: 0.5; cursor: default; }
}

.error {
  margin: 0 0 12px;
  color: $error-red;
  font-size: 14px;
}

@include responsive($bp-admin-compact) {
  .dialog { padding: 14px; }
}
```

(Verify the `responsive()` mixin's exact invocation form and the breakpoint variable name in `frontend/src/shared/styles/_variables.scss` / `_mixins.scss` before use — if the mixin takes a raw value or the variable is named differently, match the codebase.)

- [ ] **Step 6: Verify** — `npm test` PASS; `npx tsc -b`; `npx eslint --ext .ts,.tsx src/`.
- [ ] **Step 7: Commit** — `git commit -am "feat(shared): LogoCropperModal — circular-frame crop dialog (pan/zoom/keyboard, portal, focus-trapped)"`

---

### Task 6: Crop step in admin `ImageUploadField`

**Files:**
- Modify: `frontend/src/admin/components/ImageUploadField.tsx` (`onPick` flow at lines 27-36)
- Delete: `fileToDataUrl` from `frontend/src/shared/utils/image.ts` + only its direct tests (AFTER confirming `grep -rn "fileToDataUrl" frontend/src` shows no remaining consumers — ImageUploadField.tsx:3 was the sole importer as of the critique read)

**Interfaces:**
- Consumes: `LogoCropperModal` (Task 5), `canvasToDataUrl` (Task 3).
- Produces: unchanged `ImageUploadField` public props — consumers (sponsor + supplier forms) need no edits.

- [ ] **Step 1: Implement** (component logic is DOM-bound; covered by the Verification gate e2e rather than unit tests):

```tsx
import { LogoCropperModal } from '@shared/components/LogoCropperModal';
import { canvasToDataUrl } from '@shared/utils/image';

// inside the component:
const [pendingFile, setPendingFile] = useState<File | null>(null);

const resetFileInput = () => { if (fileRef.current) fileRef.current.value = ''; };

const onPick = (file: File | undefined) => {
  if (!file) return;
  setError(null);
  if (!file.type.startsWith('image/') || file.size === 0) {
    setError('Please choose an image file.');
    resetFileInput();
    return;
  }
  setPendingFile(file);
};

const applyCrop = (canvas: HTMLCanvasElement) => {
  setPendingFile(null);
  resetFileInput();
  const result = canvasToDataUrl(canvas);
  if (result.ok) onChange(result.dataUrl);
  else setError(result.error);
};

const cancelCrop = () => {
  setPendingFile(null);
  resetFileInput();
};

// render, after the existing markup:
{pendingFile && (
  <LogoCropperModal file={pendingFile} onApply={applyCrop} onCancel={cancelCrop} />
)}
```

Remove the now-unused `fileToDataUrl` import and the `busy` state if nothing else uses it (TS strict will flag). Extend the field's hint copy: `Logos are cropped to a circular frame.` Then delete `fileToDataUrl` (and only its tests) from `@shared/utils/image.ts` — `loadImage`/`canvasToDataUrl` and their tests stay.

- [ ] **Step 2: Verify** — `npx tsc -b`; `npx eslint --ext .ts,.tsx src/`; `npm test`; manual: `npm run dev`, open `/admin/suppliers/<id>/edit`, pick a rectangular PNG → dialog opens → pan/zoom → Apply → preview shows the square crop; Cancel leaves the field untouched; re-picking the same file re-opens the dialog.
- [ ] **Step 3: Commit** — `git commit -am "feat(admin): circular crop dialog on logo upload (sponsor + supplier forms)"`

---

### Task 7: `BrandColorPicker` (@shared) + sponsor-form threading

**Files:**
- Create: `frontend/src/shared/components/BrandColorPicker.tsx` + `frontend/src/shared/components/BrandColorPicker.module.scss`
- Modify: `frontend/src/admin/pages/sponsors/form/index.tsx` (FormState ~55-66, `FormErrors` interface at 68-75, emptyForm ~77-90, hydration ~166, `validate()` — local errors variable is named `e`, line ~283 — `buildSponsor` ~326, Creative panel render ~656-684)
- Modify: `frontend/src/admin/types/admin.ts` (`AdminSponsor`, lines 176-191). NOTE: `SponsorCreate = Omit<AdminSponsor, 'id'>` is defined in `@admin/services/adminApi.ts:32` and inherits the new fields automatically — no edit needed there.

**Interfaces:**
- Consumes: `extractBrandPalette`/`DEFAULT_PALETTE` (Task 4), `loadImage` (Task 3), `safeHexColor` (Task 4) — all via RELATIVE imports (`../utils/...`) per the intra-@shared style rule.
- Produces (Task 8 relies on this exact signature):

```ts
export interface BrandColorPickerProps {
  logoSrc: string | null;
  primary: string | null;
  secondary: string | null;
  onChange: (role: 'primary' | 'secondary', hex: string) => void;
  allowCustom?: boolean;  // admin: free hex input
  compact?: boolean;      // public pitch: smaller chips
  className?: string;
}
export function BrandColorPicker(props: BrandColorPickerProps): JSX.Element;
```

- [ ] **Step 1: Implement the component** (complete). The "Board tint" preview strip is deliberate scope: it is the admin's only feedback about what the pair will look like before saving — keep it.

```tsx
import { useEffect, useState } from 'react';
import { DEFAULT_PALETTE, extractBrandPalette } from '../utils/brandPalette';
import { safeHexColor } from '../utils/color';
import { loadImage } from '../utils/image';
import styles from './BrandColorPicker.module.scss';

export interface BrandColorPickerProps {
  logoSrc: string | null;
  primary: string | null;
  secondary: string | null;
  onChange: (role: 'primary' | 'secondary', hex: string) => void;
  allowCustom?: boolean;
  compact?: boolean;
  className?: string;
}

const DEFAULT_SWATCHES = ['#1d3a8f', '#0a4a2e', '#a88d2e', '#7a1f2b', '#2b6777', '#464d55'];

export function BrandColorPicker({
  logoSrc, primary, secondary, onChange, allowCustom = false, compact = false, className,
}: BrandColorPickerProps) {
  const [swatches, setSwatches] = useState<string[]>(DEFAULT_SWATCHES);

  useEffect(() => {
    let cancelled = false;
    if (!logoSrc) {
      setSwatches(DEFAULT_SWATCHES);
      return undefined;
    }
    (async () => {
      try {
        const img = await loadImage(logoSrc, logoSrc.startsWith('data:') ? undefined : 'anonymous');
        const palette = extractBrandPalette(img) ?? DEFAULT_PALETTE;
        if (!cancelled) setSwatches(palette.swatches.length >= 2 ? palette.swatches : DEFAULT_SWATCHES);
      } catch {
        if (!cancelled) setSwatches(DEFAULT_SWATCHES);
      }
    })();
    return () => { cancelled = true; };
  }, [logoSrc]);

  const row = (role: 'primary' | 'secondary', current: string | null) => (
    <div className={styles.row}>
      <span className={styles.roleLabel}>{role === 'primary' ? 'Primary' : 'Secondary'}</span>
      <div className={styles.chips} role="radiogroup" aria-label={`${role} brand color`}>
        {swatches.map((hex) => (
          <button
            key={hex}
            type="button"
            role="radio"
            aria-checked={current != null && current.toLowerCase() === hex.toLowerCase()}
            aria-label={hex}
            className={current != null && current.toLowerCase() === hex.toLowerCase()
              ? `${styles.chip} ${styles.chipActive}`
              : styles.chip}
            style={{ backgroundColor: hex }}
            onClick={() => onChange(role, hex)}
          />
        ))}
        {allowCustom && (
          <input
            type="text"
            className={styles.hexInput}
            placeholder="#RRGGBB"
            value={current ?? ''}
            onChange={(e) => onChange(role, e.target.value)}
            aria-label={`Custom ${role} hex color`}
          />
        )}
      </div>
    </div>
  );

  const validPair = safeHexColor(primary) != null && safeHexColor(secondary) != null;

  return (
    <div className={compact ? `${styles.picker} ${styles.compact}${className ? ` ${className}` : ''}` : `${styles.picker}${className ? ` ${className}` : ''}`}>
      {row('primary', primary)}
      {row('secondary', secondary)}
      {validPair && (
        <div className={styles.preview} aria-hidden="true">
          <span
            className={styles.previewChip}
            style={{ background: `linear-gradient(135deg, ${safeHexColor(primary)}, ${safeHexColor(secondary)})` }}
          />
          <span className={styles.previewLabel}>Board tint</span>
        </div>
      )}
    </div>
  );
}
```

`BrandColorPicker.module.scss` (complete):

```scss
@use '@shared/styles/variables' as *;
@use '@shared/styles/mixins' as *;

.picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.roleLabel {
  min-width: 76px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #5a6572;
}

.chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid rgba(0, 0, 0, 0.12);
  cursor: pointer;
  padding: 0;

  &:focus-visible { outline: 2px solid $nav-blue; outline-offset: 2px; }
}

.chipActive {
  border-color: #fff;
  box-shadow: 0 0 0 2px $nav-blue;
}

.hexInput {
  width: 92px;
  padding: 5px 8px;
  border: 1px solid #cbd5e0;
  border-radius: 6px;
  font-family: $font-mono;
  font-size: 12px;
}

.preview {
  display: flex;
  align-items: center;
  gap: 8px;
}

.previewChip {
  width: 44px;
  height: 18px;
  border-radius: 5px;
  border: 1px solid rgba(0, 0, 0, 0.12);
}

.previewLabel {
  font-size: 12px;
  color: #5a6572;
}

.compact {
  gap: 6px;

  .roleLabel { min-width: 60px; font-size: 10px; }
  .chip { width: 18px; height: 18px; }
}
```

(Verify `$font-mono` exists in `_variables.scss`; fall back to `ui-monospace, monospace` if not.)

- [ ] **Step 2: Thread the sponsor form** — `frontend/src/admin/pages/sponsors/form/index.tsx`, mirroring `image_url`'s exact lifecycle:
  - `FormState`: `brand_primary: string; brand_secondary: string;`
  - **`FormErrors` (interface at 68-75): add `brand_primary?: string; brand_secondary?: string;`** — TS strict rejects the validate() assignment without this.
  - `emptyForm`: `brand_primary: '', brand_secondary: ''`
  - edit hydration: `brand_primary: existing.brand_primary ?? ''` (×2)
  - `buildSponsor`: `brand_primary: form.brand_primary.trim() || null` (×2)
  - `validate()` — the local errors variable is named `e`:

```ts
const hexOk = (v: string) => !v.trim() || /^#[0-9a-f]{6}$/i.test(v.trim());
if (!hexOk(form.brand_primary)) e.brand_primary = 'Use a hex color like #1d3a8f';
if (!hexOk(form.brand_secondary)) e.brand_secondary = 'Use a hex color like #1d3a8f';
```

  - Render in the Creative panel, as a sibling `.field` after the ImageUploadField block (before the section close at ~683). Neighboring labels use `className={styles.fieldLabel}` (index.tsx:662); there is NO existing `styles.hint` class — read the sibling fields first and reuse their label/error/help markup exactly (adding a new SCSS class only if needed, with ≥1 declaration). Include inline error nodes matching the sibling error markup:

```tsx
<div className={styles.field} data-field="brand_colors">
  <label className={styles.fieldLabel}>Brand colors</label>
  <BrandColorPicker
    logoSrc={form.image_url.trim() || null}
    primary={form.brand_primary.trim() || null}
    secondary={form.brand_secondary.trim() || null}
    onChange={(role, hex) => update(role === 'primary' ? 'brand_primary' : 'brand_secondary', hex)}
    allowCustom
  />
  {errors.brand_primary && <p className={/* sibling error classname */}>{errors.brand_primary}</p>}
  {errors.brand_secondary && <p className={/* sibling error classname */}>{errors.brand_secondary}</p>}
</div>
```

  - `frontend/src/admin/types/admin.ts` `AdminSponsor` gains `brand_primary: string | null; brand_secondary: string | null;`

- [ ] **Step 3: Verify** — `npx tsc -b`; `npx eslint --ext .ts,.tsx src/`; `npm test`; manual: edit a sponsor with an uploaded logo → swatches appear from the logo; pick both → save → reload → colors persist; invalid custom hex blocks submit with the inline field error. (Bypassing client validation, a hostile hex gets server 422 → the generic "Save failed" toast — `apiErrorDetail` intentionally returns `undefined` for array-shaped 422 details; that is expected behavior, not a bug.)
- [ ] **Step 4: Commit** — `git commit -am "feat(admin): brand-color picker on sponsor form (extracted swatches + custom hex)"`

---

### Task 8: Public Platinum board — demo crop, pitch swatches, sold-board takeover

**Files:**
- Modify: `frontend/src/public/types/sponsor.ts` (`PlatinumSponsor`, ~24-39)
- Modify: `frontend/src/public/pages/category/components/CategorySponsor.tsx` (`adoptLogoFile` 410-436, branded init 317-329, mapped 350-351, pitch render 538-578)
- Modify: `frontend/src/public/pages/category/components/categorySponsor.scss` (pitch swatch-strip layout)

**Interfaces:**
- Consumes: `LogoCropperModal`, `BrandColorPicker`, `canvasToDataUrl`, `extractBrandPalette`/`DEFAULT_PALETTE`, `safeHexColor` (all `@shared/...` — cross-context imports use the alias); `brand_takeover` from Task 2.
- Produces: none downstream.

- [ ] **Step 1: Types** — `PlatinumSponsor` gains `brand_takeover?: boolean | null;` (`?:` alone misses JSON `null` — CLAUDE.md gotcha).

- [ ] **Step 2: Sold-board takeover** — extend the existing `branded` lazy init (lines 317-329): when `sponsor` exists, initialize from `Boolean(sponsor.brand_takeover)` instead of `false`; keep the pitch-restore branch for `!sponsor` untouched. Add a sync effect with primitive deps only (a same-values refetch never stomps a visitor's manual toggle; no eslint-disable comment — the react-hooks plugin is not installed here):

```tsx
useEffect(() => {
  if (sponsor) setBranded(Boolean(sponsor.brand_takeover));
}, [sponsor?.id, sponsor?.brand_takeover]);
```

  At the `mapped` construction (350-351), wrap both colors: `safeHexColor(sponsor.brand_primary) ?? undefined` / `safeHexColor(sponsor.brand_secondary) ?? undefined`. No wave on load — `branded=true` at first paint just applies `boardStyle` statically, exactly like today's post-click state. The click-toggle (`toggleBrand`, 404-407) stays.

- [ ] **Step 3: Demo crop** — split `adoptLogoFile`. `sessionStorage.setItem` stays wrapped in try/catch (the existing code at 423-427 does this — Safari private mode), and the state-committing `runWave` sits AFTER the try so the takeover still happens when storage is unavailable:

```tsx
const [cropFile, setCropFile] = useState<File | null>(null);

const adoptLogoFile = (file: File | null | undefined) => {
  if (!file || !/^image\//.test(file.type)) return;
  setCropFile(file);
};

const applyCroppedLogo = (canvas: HTMLCanvasElement) => {
  const file = cropFile;
  setCropFile(null);
  if (!file) return;
  const encoded = canvasToDataUrl(canvas);
  if (!encoded.ok) return;
  const palette = extractBrandPalette(canvas) ?? DEFAULT_PALETTE;
  const next: PitchState = {
    logo: encoded.dataUrl,
    name: csPrettyName(file.name),
    primary: palette.primary,
    secondary: palette.secondary,
  };
  try {
    sessionStorage.setItem(pitchKey, JSON.stringify(next));
  } catch { /* storage unavailable */ }
  runWave(/* same args as the existing call at ~430 */, () => { setPitch(next); setBranded(true); });
};
```

  Keep the existing `runWave` invocation's exact argument shape (read lines 410-436 first — the FileReader/Image/extract block is replaced wholesale by the two functions above). Render `{cropFile && <LogoCropperModal file={cropFile} onApply={applyCroppedLogo} onCancel={() => setCropFile(null)} />}` once, in the `!sponsor` render branches. Storing the 256px cropped data-URL (instead of the raw full-size file) also removes the sessionStorage quota risk.

- [ ] **Step 4: Pitch swatch strip** — in the pitch render block (538-578), near the existing ✕ reset control:

```tsx
<div className="csb-swatches" data-enter>
  <BrandColorPicker
    compact
    logoSrc={pitch.logo}
    primary={pitch.primary}
    secondary={pitch.secondary}
    onChange={(role, hex) => {
      const next = { ...pitch, [role]: hex } as PitchState;
      try {
        sessionStorage.setItem(pitchKey, JSON.stringify(next));
      } catch { /* storage unavailable */ }
      runWave(/* same args */, () => setPitch(next));
    }}
  />
</div>
```

  `categorySponsor.scss` addition (layout only — chip colors are inline):

```scss
.csb-swatches {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
}
```

- [ ] **Step 5: Verify** — `npx tsc -b`; eslint; `npm test`; manual (`npm run dev`, an UNSOLD category): drag a logo → crop dialog → Apply → wave takeover with extracted colors; pick a different swatch → board re-waves; reload → pitch + colors persist for the session; a SOLD category with sponsor colors set (via Task 7) renders branded from first paint and click-toggles back to steel; a sold category WITHOUT sponsor colors behaves exactly as before.
- [ ] **Step 6: Commit** — `git commit -am "feat(public): crop dialog + swatch picker in Platinum demo; sold board honors brand_takeover"`

---

### Task 9: Circle completion at Gold / Silver / keyword render sites

**Files:**
- Modify: `frontend/src/shared/utils/url.ts` (+ its test file `url.test.ts` — it imports `{ describe, expect, it }`; use `it(...)`)
- Modify: `frontend/src/public/pages/category/components/SponsorBlock.tsx` (SbLogo img, ~478-489) + `SponsorBlock.module.scss` (~368)
- Modify: `frontend/src/public/pages/category/components/SilverPartners.tsx` (~115-120) + `silverPartners.scss` (~274-279)
- Modify: `frontend/src/public/pages/keyword/index.tsx` (~179-193) + `KeywordSponsorPage.module.scss` (~75-79)

**Interfaces:**
- Produces: `isDataImage(src: string | null | undefined): boolean` in `@shared/utils/url.ts`.

**Gating rule (IMPORTANT — squareness, not just data-URL-ness):** the PRE-EXISTING upload pipeline (live since 2026-06-22) is aspect-preserving — stored data-URL logos from before this feature are generally RECTANGULAR, and blindly circle-cropping them would mangle wordmarks. The circle-completion class is applied only when BOTH hold: `isDataImage(src)` AND the decoded image is square (`naturalWidth === naturalHeight`, checked in `onLoad`). New crops are always square; old rectangular data-URLs and remote wordmark URLs keep today's letterbox rendering untouched.

- [ ] **Step 1: Failing test** (append to `url.test.ts`, matching its `describe/it` style):

```ts
describe('isDataImage', () => {
  it('flags only data:image sources', () => {
    expect(isDataImage('data:image/webp;base64,x')).toBe(true);
    expect(isDataImage('https://acme.com/logo.png')).toBe(false);
    expect(isDataImage(null)).toBe(false);
    expect(isDataImage(undefined)).toBe(false);
    expect(isDataImage('data:text/html,x')).toBe(false);
  });
});
```

- [ ] **Step 2: Implement** — `url.ts`:

```ts
/** True for data:image/* sources — candidates for crop-pipeline output (pair with a squareness check). */
export const isDataImage = (src: string | null | undefined): boolean =>
  typeof src === 'string' && src.startsWith('data:image/');
```

Each render site gains a small `cropped` state set in the img's `onLoad`:

```tsx
const [cropped, setCropped] = useState(false);
// on the <img>:
onLoad={(e) => setCropped(
  isDataImage(src) && e.currentTarget.naturalWidth === e.currentTarget.naturalHeight,
)}
```

Gold (`SponsorBlock.tsx` — SbLogo is already a stateful subcomponent with an `onError` handler; add the `onLoad` + conditional class): `className={cropped ? `${styles.logo} ${styles.logoCropped}` : styles.logo}`; `SponsorBlock.module.scss`:

```scss
.logoCropped {
  width: 58%;
  height: 58%;
  max-width: none;
  max-height: none;
  object-fit: cover;
  border-radius: 50%;
}
```

Silver (`SilverPartners.tsx` — the mark img is rendered inline inside a `.map()`; extract a tiny local `SvpMarkImg` subcomponent to hold the `cropped` state per row): conditional extra class `svp-markimg-cropped`; `silverPartners.scss` (global classnames file, so the plain dashed class is fine):

```scss
.svp-markimg-cropped {
  border-radius: 50%;
}
```

Keyword (`keyword/index.tsx` hero img — single img, local state fine): conditional `${styles.logo} ${styles.logoFull}`; `KeywordSponsorPage.module.scss`:

```scss
.logoFull {
  max-width: 100%;
  max-height: 100%;
}
```

- [ ] **Step 3: Verify** — `npm test`; `npx tsc -b`; eslint; manual: a Gold/Silver sponsor with a NEW cropped (square data-URL) logo shows a full circular disc; a legacy rectangular data-URL logo AND a remote wordmark URL are pixel-identical to before (compare screenshots before/after this task).
- [ ] **Step 4: Commit** — `git commit -am "feat(public): square cropped logos render as full circles at Gold/Silver/keyword sites"`

---

## Verification gate (after all tasks — REQUIRED, user-mandated)

Run superpowers:verification-before-completion — no completion claims without this evidence:

1. `cd api && pytest tests/ -v` → all green (expect ~365+).
2. `cd frontend && npm test && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm run build` → all clean.
3. `docker compose up --build -d`, then `docker compose exec -T api alembic upgrade head < /dev/null` sanity (migration 018 applies).
4. `/verify` — drive the real app with chrome-devtools MCP:
   - Admin: `/admin/sponsors/<platinum-id>/edit` → upload rectangular logo → crop dialog (pan, wheel-zoom, keyboard arrows, Esc, focus trap) → Apply → pick primary+secondary swatches → Save → reload: values persist.
   - Public sold board: category renders brand-tinted from first paint (`data-branded` present); click logo pad toggles steel; navigate away/back — no duplicate rAF loops (wrap `requestAnimationFrame`, count calls/sec ≈ 60 per visible board, interaction-then-navigate probe per CLAUDE.md).
   - Public demo (unsold category): drag logo → crop → Apply → wave; swatch pick → re-wave; sessionStorage `cs-pitch-*` holds the small cropped data-URL.
   - Render sites: NEW cropped logos are full circles at Platinum/Gold/Silver/keyword; legacy logos (rectangular data-URLs AND remote URLs) pixel-identical to before.
   - Mobile WYSIWYG: at 375px width the crop frame shrinks, the mask stays a CIRCLE (aspect-ratio 1), and the applied crop matches what was visible in the frame.
   - a11y (a11y-debugging skill): modal contrast, roles, keyboard-only pass (trap skips disabled controls).
   - Screenshots at 430x932 and 1280x800 for the modal + branded board.
5. Reduced-motion: with `prefers-reduced-motion: reduce`, swatch pick recolors without wave (existing csFx branch) and the modal remains fully usable.
