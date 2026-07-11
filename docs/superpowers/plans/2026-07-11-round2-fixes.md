# Round 2: Flush Logos, Color-Selection Screen, Color Remap, Slogan Glow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Four user-evaluation fixes on the logo-crop/brand-color feature: (1) cropped logos sit flush against the solid rim at all four circular render sites; (2) a color-selection screen (%-ranked swatches, hex, nearest CSS color name, Primary/Secondary picks) appears after every crop — admin sponsor form, admin supplier form (with supplier-level storage + propagation to active Platinum sponsorships), and the public demo; (3) brand-color mapping: primary → board surface only, secondary → all PCB components/traces/dots — with the underglow PINNED to its stock color (user amendment: never varies per sponsorship); (4) the hero slogan gets a bold backlit-marquee glow treatment.

**Architecture:** No new migrations (supplier brand columns exist since 014). One new shared modal (`BrandColorSelectModal`) consuming an extended `BrandPalette` (percentage-ranked swatches) + a new `nearestCssColor` util. Flush rendering reuses the Task-9 squareness gate (added to Platinum's CsLogo, which lacks it). The csFx change is two derivation swaps in `refreshColor` + one new non-branded SCSS token — zero animation-const changes.

**Tech Stack:** unchanged. **Branch:** `updates`.

**Recon provenance:** all anchors verified 2026-07-11 by workflow wf_bdb6f29a-6a1 (3 readers). Content wins over line numbers.

## Global Constraints

- One commit per task; NEVER add `Co-Authored-By` lines.
- Gates: `cd frontend && npm test && npx tsc -b && npx eslint --ext .ts,.tsx src/` (baseline 57 vitest); `cd api && python -m pytest tests/ -v` (baseline 371).
- vitest has NO globals — `import { describe, expect, it } from 'vitest';`, `it(...)` style; pure tests need no environment directive.
- Intra-@shared imports RELATIVE; @shared SCSS opens with `@use '@shared/styles/variables' as *;` + mixins; tokens over hardcoded brand hexes; every class ≥1 declaration.
- **csFx invariants:** GAP 19 / SH_SPEED .36 / dome R 72 / WAVE_SPEED .34 / FLIPLEN 255, `frame()`, and the destroyed-guard UNTOUCHED. Allowed csFx edits in this round: `refreshColor` color-derivation lines + the `col` struct defaults ONLY.
- **UNDERGLOW CONSTRAINT (user, binding):** the Platinum board's underglow (buildGlow sprite under lifted tiles) must NOT change with sponsorship colors — same stock color for every sponsor. brandVars must never influence it.
- **Perf constraints for the slogan:** never animate `drop-shadow`/`filter`; compositor-only animation (transform/opacity); pre-baked gradients; static `text-shadow` layers; `prefers-reduced-motion` → static glow, no rotation/pulse; no permanent `will-change`; do NOT add `overflow: hidden` to `.hero` (SearchBar popover).
- `sessionStorage.setItem` stays inside try/catch with state-committing work outside (existing pattern).
- Legacy rendering pixel-identity: flush classes apply ONLY via the squareness gate (`isDataImage(src) && naturalWidth === naturalHeight` in onLoad); legacy letterboxed logos unchanged.
- Hex format `#RRGGBB`; `validate_optional_hex_color` (api/app/utils/color.py:13) at write boundaries; `safeHexColor` at render boundaries.
- Completion claims require superpowers:verification-before-completion + `/verify` live e2e (user-mandated).

---

### Task 1: Backend — expose supplier brand colors

**Files:**
- Modify: `api/app/routes/suppliers.py` (`SupplierCreate` 34-50, `SupplierUpdate` 53-67, `supplier_to_dict` 70-82, `create_supplier` explicit `Supplier(...)` kwargs 120-131; `update_supplier` 179-181 is a generic setattr loop — no change)
- Test: `api/tests/test_supplier_brand_colors.py`

**Interfaces:**
- Consumes: existing `Supplier.brand_primary/brand_secondary` columns (models/supplier.py:27-28, migration 014 — NO new migration); `validate_optional_hex_color` (api/app/utils/color.py:13).
- Produces: `brand_primary`/`brand_secondary` accepted on supplier create/update (hex-validated → 422) and returned by `supplier_to_dict` (feeds admin list + detail). Public fallback read-sites (category_service.py:101, routes/sponsors.py:30-33) already consume these columns — untouched.

- [ ] **Step 1: Failing tests** — mirror `api/tests/test_supplier_board_fields.py:32-83` (`test_create_supplier_round_trips_board_fields` / `test_update_supplier_sets_board_fields`) arrange-style exactly:

```python
def test_create_supplier_round_trips_brand_colors(...):
    payload["brand_primary"] = "#1d3a8f"
    payload["brand_secondary"] = "#c45a16"
    res = client.post(...)  # same route/auth as the mirrored test
    assert res.status_code == 200  # matches test_supplier_board_fields.py:52 exactly
    assert res.json()["brand_primary"] == "#1d3a8f"
    # GET detail re-asserts both fields


def test_update_supplier_sets_brand_colors(...):
    # PUT/PATCH per the mirrored test; assert persisted + echoed


def test_supplier_brand_color_rejects_invalid_hex(...):
    # brand_primary="#zzz" → 422 (mirror test_image_url_validation.py rejection pattern)
```

- [ ] **Step 2: RED** — `pytest tests/test_supplier_brand_colors.py -v` fails (fields silently dropped: echoed as None).
- [ ] **Step 3: Implement** — add to BOTH schemas:

```python
    brand_primary: str | None = None
    brand_secondary: str | None = None

    @field_validator("brand_primary", "brand_secondary")
    @classmethod
    def _validate_brand_colors(cls, value: str | None) -> str | None:
        return validate_optional_hex_color(value)
```

(import beside the existing logo_url validator import; placement mirrors suppliers.py:47-50/64-67). Add both keys to `supplier_to_dict` and both kwargs to the explicit `Supplier(...)` construction in `create_supplier`.

- [ ] **Step 4: GREEN** — focused file, then full `pytest tests/ -v`.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): expose supplier brand colors on create/update/read (columns from migration 014)"`

---

### Task 2: Shared — percentage-ranked palette + nearest CSS color name

**Files:**
- Modify: `frontend/src/shared/utils/brandPalette.ts` (+ its test)
- Create: `frontend/src/shared/utils/cssColorNames.ts` (+ test)
- Modify: `frontend/src/shared/components/BrandColorPicker.tsx` (adapt to the new swatch type — sole existing consumer)

**Interfaces (produced — T3/T4 rely on these EXACT shapes):**

```ts
// brandPalette.ts — BREAKING CHANGE to swatches:
export interface RankedSwatch { hex: string; pct: number }  // pct = rounded % of analyzed (alpha≥140, non-near-white/black) pixels in this hue bucket; min 1
export interface BrandPalette { primary: string; secondary: string; swatches: RankedSwatch[] }
// primary/secondary derivations UNCHANGED (parity preserved); swatches ranked by bucket population desc, up to 6.

// cssColorNames.ts
export interface NamedColor { name: string; exact: boolean }        // name is display-cased, e.g. "Dark Slate Blue"
export function nearestCssColor(hex: string): NamedColor | null;    // null for invalid input; exact=true on case-insensitive hex equality with a CSS named color; otherwise nearest by sRGB Euclidean distance
```

- [ ] **Step 1: Failing tests**

```ts
// append to brandPalette.test.ts (existing describe/it style)
it('ranks swatches with percentage coverage of analyzed pixels', () => {
  const p = paletteFromPixels(px([...Array(15).fill([255, 0, 0, 255]), ...Array(5).fill([0, 0, 255, 255])]), 20);
  expect(p.swatches[0]).toEqual({ hex: '#ff0000', pct: 75 });
  expect(p.swatches[1]).toEqual({ hex: '#0000ff', pct: 25 });
});

it('percentage denominator excludes transparent and near-white pixels', () => {
  const p = paletteFromPixels(px([[255, 0, 0, 255], [255, 0, 0, 255], [250, 250, 250, 255], [255, 0, 0, 10]]), 4);
  expect(p.swatches[0]).toEqual({ hex: '#ff0000', pct: 100 }); // 2 analyzed, both red
});
```

```ts
// cssColorNames.test.ts
import { describe, expect, it } from 'vitest';
import { nearestCssColor } from './cssColorNames';

describe('nearestCssColor', () => {
  it('returns exact matches for CSS named colors', () => {
    expect(nearestCssColor('#ff0000')).toEqual({ name: 'Red', exact: true });
    expect(nearestCssColor('#FF0000')).toEqual({ name: 'Red', exact: true });
  });
  it('returns the nearest name otherwise', () => {
    const r = nearestCssColor('#fe0102');
    expect(r).toEqual({ name: 'Red', exact: false });
  });
  it('handles arbitrary brand hexes', () => {
    const r = nearestCssColor('#1d3a8f');
    expect(r?.exact).toBe(false);
    expect(typeof r?.name).toBe('string');
  });
  it('rejects invalid input', () => {
    expect(nearestCssColor('zzz')).toBeNull();
  });
});
```

- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.** `paletteFromPixels`: denominator = count of pixels that PASSED the alpha + lightness gates (the `fbN` accumulator counts exactly these — reuse it); `pct = Math.max(1, Math.round((bucket.n / fbN) * 100))`. Fallback single-swatch cases: `swatches: [{ hex: primary, pct: 100 }]`. `cssColorNames.ts`: full 148-entry CSS named-color table as `Array<{ name: string; hex: string }>` with display names ("Rebecca Purple", "Dark Slate Blue"…; skip duplicate aliases — keep Gray over Grey variants, keep both Aqua/Cyan → prefer Cyan, Fuchsia/Magenta → prefer Magenta); `nearestCssColor` validates via the same `#RRGGBB` regex as safeHexColor, exact-match first, else min Euclidean distance in sRGB. Update the OTHER swatch sites tsc will flag: `DEFAULT_PALETTE.swatches` → `[{ hex: FALLBACK_PRIMARY, pct: 100 }]` (brandPalette.ts:110); `BrandColorPicker.tsx` keeps its `useState<string[]>` state — change ONLY line 34 to `setSwatches(palette.swatches.length >= 2 ? palette.swatches.map((s) => s.hex) : DEFAULT_SWATCHES);` (the render JSX stays byte-identical). Also update the THREE existing swatch assertions in brandPalette.test.ts to the new shape: line 15 → `expect(p.swatches[0]).toEqual({ hex: '#ff0000', pct: 100 })`; line 24 → `expect(p.swatches).toEqual([{ hex: '#ff0000', pct: 67 }, { hex: '#0000ff', pct: 33 }])`; line 36 → `expect(p.swatches).toEqual([{ hex: '#808080', pct: 100 }])`.
- [ ] **Step 4: GREEN** — full frontend gates (BrandColorPicker consumers compile).
- [ ] **Step 5: Commit** — `git commit -m "feat(shared): percentage-ranked palette swatches + nearest CSS color names"`

---

### Task 3: Shared — `BrandColorSelectModal` (the second screen)

**Files:**
- Create: `frontend/src/shared/components/BrandColorSelectModal/index.tsx` + `BrandColorSelectModal.module.scss`

**Interfaces (produced — T4 consumes verbatim):**

```ts
export interface BrandColorSelectModalProps {
  source: HTMLCanvasElement | string;       // cropped canvas (preferred) or data-URL/img src
  initialPrimary?: string | null;
  initialSecondary?: string | null;
  title?: string;                            // default 'Choose brand colors'
  onApply: (primary: string, secondary: string) => void;   // both always #RRGGBB
  onSkip: () => void;                        // "keep existing / auto colors" — host decides semantics
}
export function BrandColorSelectModal(props: BrandColorSelectModalProps): JSX.Element;
```

Behavior:
- On mount, extract `extractBrandPalette(sourceElement) ?? DEFAULT_PALETTE` (for a string source, decode via `loadImage(src, src.startsWith('data:') ? undefined : 'anonymous')`, cancel-flagged).
- Render one row per ranked swatch (max 6), each row: color chip · `pct%` · hex (mono) · nearest CSS name (`nearestCssColor` — prefix `≈` via `{'≈'}` or `&asymp;` when `exact === false`) · a **Primary** radio · a **Secondary** radio (two radiogroups spanning the rows, roving selection by row).
- A "Custom" row at the bottom with two `#RRGGBB` text inputs (mono, validated live with the safeHexColor regex) that deselect the radios when used.
- Preselection: `initialPrimary/Secondary` if they match a swatch or are valid hex (custom inputs), else `swatches[0].hex` → Primary and `palette.secondary` → Secondary (custom slot).
- Footer: `Skip` (calls onSkip) + `Apply colors` (disabled until both values are valid hex; calls onApply). A small live preview strip `linear-gradient(135deg, primary, secondary)`.
- Chrome mirrors `LogoCropperModal` exactly: `createPortal` to body, scrim click = Skip, Esc = Skip, capture-phase keydown removed on unmount, focus trap skipping `:disabled`, initial focus on the first radio, body scroll-lock with prior-value restore, `role="dialog" aria-modal aria-label`, `.scrim { overflow-y: auto }` + `.dialog { max-height: calc(100dvh - 32px); overflow-y: auto }`.
- SCSS: shared-tokens header, neutral light card (renders over admin AND the dark public board), chips 26px circles, table-like rows with `gap`, every class ≥1 declaration.

- [ ] **Step 1: Implement** (component is DOM-bound — covered by e2e; the logic it leans on was TDD'd in R2-T2).
- [ ] **Step 2: Gates** — `npm test`, `tsc -b`, eslint.
- [ ] **Step 3: Commit** — `git commit -m "feat(shared): BrandColorSelectModal — ranked swatches with names/percentages and Primary/Secondary selection"`

---

### Task 4: Hosts — two-step upload flow (sponsor form, supplier form + propagation, public demo)

**Files:**
- Modify: `frontend/src/admin/components/ImageUploadField.tsx` (add optional `onCroppedCanvas?: (canvas: HTMLCanvasElement) => void` prop, called in `applyCrop` after a successful `onChange(result.dataUrl)` — lets hosts chain the color modal without re-decoding)
- Modify: `frontend/src/admin/pages/sponsors/form/index.tsx`
- Modify: `frontend/src/admin/pages/suppliers/form/index.tsx` (FormData 14-24, emptyForm 31-43, hydrate 88-111, payload 135-148, ImageUploadField 268-276; FormErrors analog if present)
- Modify: `frontend/src/admin/types/admin.ts` (`AdminSupplier` 113-127 gains `brand_primary: string | null; brand_secondary: string | null;`)
- Modify: `frontend/src/public/pages/category/components/CategorySponsor.tsx` (demo chain)

**Interfaces:**
- Consumes: `BrandColorSelectModal` (T3), `RankedSwatch` palette (T2), `adminApi.getSponsors()` / `updateSponsor(id, Partial<SponsorCreate>)` (adminApi.ts:179-191, bustingAfter-wrapped), `normalizeSponsorTier`/`isActiveSponsor` from `@admin/services/sponsorTier` (CLAUDE.md: tier casing MUST normalize).

Flows:
1. **Sponsor form:** `<ImageUploadField ... onCroppedCanvas={setColorSource} />`; when `colorSource` set, render `BrandColorSelectModal source={colorSource} initialPrimary={form.brand_primary.trim() || null} ...` → `onApply(p, s)` = `update('brand_primary', p); update('brand_secondary', s); setColorSource(null)`; `onSkip` = `setColorSource(null)` (keeps existing colors). Existing inline `BrandColorPicker` field stays (edit colors without re-upload).
2. **Supplier form:** thread `brand_primary`/`brand_secondary` through FormData/emptyForm/hydrate (`s.brand_primary ?? ''`)/payload (`.trim() || null`), + same both-or-neither & hex `validate()` rules as the sponsor form (extend its errors type). Same `onCroppedCanvas` → modal chain. **Propagation:** in `handleSubmit`, after a successful `updateSupplier`/`createSupplier` where `brand_primary && brand_secondary` — and BEFORE setting the success toast or scheduling the existing 900ms navigate (suppliers/form/index.tsx:150-160) — run:

```ts
const sponsors = await adminApi.getSponsors();
const targets = sponsors.filter(
  (s) => s.supplier_id === id && normalizeSponsorTier(s.tier) === 'Platinum' && isActiveSponsor(s.status),
);
const results = await Promise.allSettled(
  targets.map((s) => adminApi.updateSponsor(s.id, { brand_primary, brand_secondary })),
);
```

(`isActiveSponsor` takes a STATUS, not a sponsor — sponsorTier.ts:31-34. `Promise.allSettled` so one rejected PATCH cannot abort the rest — a supplier may legally hold multiple active Platinum slots across categories; getSponsors is unpaginated so all rows are visible. A brand-only PATCH does not trip `_reject_if_slot_taken` — the guard requires category_id/tier/status keys.) Count rejects: the success toast becomes `Supplier updated.` or `Supplier updated — N Platinum placement(s) not updated.`; wrap the whole block in try/catch so a getSponsors failure degrades to the plain success toast. Only then schedule the navigate. (Shipped as edit-only: the create branch has no propagation call — a brand-new supplier's id cannot yet be referenced by any existing `Sponsor` row, so create-path propagation would be unreachable code; intentional, not a partial implementation.) Add a one-line hint under the picker: `Applies to this supplier's active Platinum placement too.`
3. **Public demo (CategorySponsor):** `applyCroppedLogo` no longer waves immediately. New state `colorStage: { canvas: HTMLCanvasElement; provisional: PitchState } | null`. `applyCroppedLogo` = encode (existing `cropError` path stays FIRST and untouched) → build the PROVISIONAL PitchState with the auto palette (`extractBrandPalette(canvas) ?? DEFAULT_PALETTE`) and persist it to sessionStorage inside the usual try/catch (preserves today's reload-durability — a navigation while the color screen is open keeps the crop with auto colors) → `setColorStage({ canvas, provisional })` — NO wave yet. `commitPitch(stage, p, s)` = `{ ...stage.provisional, primary: p, secondary: s }` → try/catch-setItem → `runWave(...)` exactly as today with `setPitch(next); setBranded(true)` → `setColorStage(null)`. Render `{colorStage && <BrandColorSelectModal source={colorStage.canvas} initialPrimary={colorStage.provisional.primary} initialSecondary={colorStage.provisional.secondary} onApply={(p, s) => commitPitch(colorStage, p, s)} onSkip={() => commitPitch(colorStage, colorStage.provisional.primary, colorStage.provisional.secondary)} />}` in **BOTH `!sponsor` return branches, directly beside each existing `{cropFile && <LogoCropperModal/>}` block** (the pitch branch keeps dropProps — a re-drop from an active pitch must reach the modal too; open-slot branch ~line 718, pitch branch ~line 623). The pitch swatch strip (BrandColorPicker compact) stays for post-hoc tweaks.

- [ ] **Step 1: Implement** hosts in the order above (each keeps gates green).
- [ ] **Step 2: Gates** + manual smoke: sponsor upload → crop → color screen → Apply → fields set; supplier save propagates to its active Platinum sponsorship (verify via /partners response); demo upload → crop → color screen → Apply → wave.
- [ ] **Step 3: Commit** — `git commit -m "feat: color-selection screen after crop at sponsor form, supplier form (with Platinum propagation) and public demo"`

---

### Task 5: Board — flush logos + secondary remap + pinned underglow

**Files:**
- Modify: `frontend/src/public/pages/category/components/CategorySponsor.tsx` (CsLogo 295-299: add onLoad squareness gate — it has onError only; keyed by src at 507 so state resets)
- Modify: `frontend/src/public/pages/category/components/categorySponsor.scss` (`.csbA-logoimg` cropped variant; new `--underglow` token)
- Modify: `frontend/src/public/pages/category/components/SponsorBlock.module.scss` (`.logoCropped` 377-384)
- Modify: `frontend/src/public/pages/category/components/silverPartners.scss` (`.svp-markimg-cropped` 283-285)
- Modify: `frontend/src/public/pages/keyword/KeywordSponsorPage.module.scss` (`.logoFull` 84-87)
- Modify: `frontend/src/public/pages/category/components/csFx.tsx` (refreshColor 204-226 + col defaults 75-87 ONLY)

**Flush (squareness-gated everywhere; solid rims are INSET box-shadows that paint under the img — sizes leave the rim visible):**
- Platinum: CsLogo gains `const [cropped, setCropped] = useState(false)` + `onLoad={(e) => setCropped(isDataImage(src) && e.currentTarget.naturalWidth === e.currentTarget.naturalHeight)}` (import `isDataImage` — CategorySponsor doesn't import it yet) + conditional class `csbA-logoimg-flush`. SCSS: `.csbA-logoimg-flush { width: calc(100% - 4px); height: calc(100% - 4px); object-fit: cover; }` (rim = 2px inset at scss:376; dashed `.csbA-ring` at inset -6px already outside — untouched). Applies in pitch mode too (same CsLogo path). Place `.csbA-logoimg-flush` immediately AFTER the `.csbA-logoimg` rule (scss:398-403) — equal (0,1,0) specificity, so source order must favor the flush variant or it silently loses.
- Gold: `.logoCropped` → `width: calc(100% - 4px); height: calc(100% - 4px);` (keep `max-*: none; object-fit: cover; border-radius: 50%;`) — rim 2px (module.scss:355), dashed ::after outside.
- Silver: `.svp-markimg-cropped` → add `width: calc(100% - 3px); height: calc(100% - 3px); object-fit: cover;` (rim 1.5px, scss:261-263).
- Keyword: `.logoFull` → `width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: cover; border-radius: 50%;` (the base `.logo` rule on the SAME element caps at `max-width/height: 80%` — dropping the max-* lines would clamp width:100% to 80% and silently un-flush this site; wrap has no rim).

**Remap + underglow pin (csFx `refreshColor` + `col` defaults — NOTHING else in csFx):**
- Dots → secondary: RELOCATE the `col.dot` assignment to AFTER the `--gold` probe resolves `col.acc` (after csFx.tsx:223 — today col.dot computes at :214 BEFORE the probe; an in-place rewrite would read the STALE previous accent, giving one-refresh-behind dots). Use a DARKER mix than the old board-derived formula so UNBRANDED boards keep a similar resting luminance (stock csbA accent #c5bfd6 through the old ×0.5+20 shape would brighten the grid ~5×): `const a = col.acc; col.dot = \`rgba(${Math.round(a[0] * 0.3 + 8)},${Math.round(a[1] * 0.3 + 8)},${Math.round(a[2] * 0.3 + 8)},.22)\`;` — then visually spot-check the resting dot grid on an UNBRANDED Platinum board before/after. (Traces/electrons/components/emblem already follow secondary via the scss `--gold`-family tokens — no change.)
- Underglow pin: new token in `categorySponsor.scss` beside the existing token blocks — base `.csb { --underglow: #e8c252; }` (scss:45-56 block) and Platinum override `.csb.csbA { --underglow: #c5bfd6; }` (scss:77-86 block). `refreshColor` probes `--underglow` into a new `col.glow` (default `[232,194,82]` in the col struct); `buildGlow` (csFx.tsx:99-110) uses `col.glow` instead of `col.acc`. brandVars NEVER sets `--underglow` → the lifted-tile glow is identical for every sponsorship, branded or steel. Emblem tint keeps `col.acc` (emblem only exists on unbranded open-slot boards).
- Tile walls (`drawTile`/`drawFlipTile` shades from g2) stay PRIMARY — they are the board slab, per the recon recommendation.

- [ ] **Step 1: Implement flush** (4 sites) → gates → visual spot-check.
- [ ] **Step 2: Implement remap + pin** → gates.
- [ ] **Step 3: Commit** — `git commit -m "fix(public): cropped logos flush to rim at all sites; dots follow secondary; underglow pinned to stock"`

---

### Task 6: Slogan — backlit-marquee glow ("ALL CIRCUITS ALL THE TIME")

**Files:**
- Modify: `frontend/src/public/pages/home/components/HeroSection.module.scss` (`.subtitle`, lines 48-58; TSX unchanged — pseudo-elements only)

Design (frontend-design pass, signature = the searchlight rig; everything else untouched):

```scss
.subtitle {
  position: relative;
  font-family: $font-body;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: #ffffff;
  margin: 0;
  animation: fade-in-up 0.6s ease 0.15s both;
  // Static layered glow — text-shadow is never animated (CLAUDE.md)
  text-shadow:
    0 0 6px rgba(255, 255, 255, 0.55),
    0 0 18px rgba(255, 255, 255, 0.28),
    0 0 42px rgba(120, 190, 255, 0.22);

  // Searchlight rig: pre-baked conic spokes, transform-only rotation,
  // radial mask (rotation-invariant) fades beams before they reach content
  &::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 400px;
    height: 400px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: -1;
    background: repeating-conic-gradient(
      from 0deg,
      rgba(255, 255, 255, 0) 0deg 9deg,
      rgba(160, 205, 255, 0.10) 12deg,
      rgba(255, 255, 255, 0.16) 15deg,
      rgba(255, 255, 255, 0) 18deg 30deg
    );
    -webkit-mask-image: radial-gradient(circle closest-side, #000 18%, transparent 70%);
    mask-image: radial-gradient(circle closest-side, #000 18%, transparent 70%);
    animation: slogan-beams 46s linear infinite;
  }

  // Soft core bloom behind the letters (opacity-only pulse)
  &::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 340px;
    height: 120px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: -1;
    background: radial-gradient(closest-side, rgba(255, 255, 255, 0.20), rgba(140, 195, 255, 0.10) 55%, transparent 75%);
    animation: slogan-bloom 6.5s ease-in-out infinite;
  }

  @include responsive($bp-mobile) {
    font-size: 1rem;
    letter-spacing: 0.14em;

    &::before { width: 300px; height: 300px; }
    &::after { width: 250px; height: 90px; }
  }

  @media (prefers-reduced-motion: reduce) {
    &::before,
    &::after { animation: none; }
  }
}
```

Keyframes (add at file end — CSS Modules hashes @keyframes; since these are referenced from the same module file, plain local `@keyframes` here is correct; the sibling-plain-file rule only applies inside `:global` blocks):

```scss
@keyframes slogan-beams {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(360deg); }
}

@keyframes slogan-bloom {
  0%, 100% { opacity: 0.65; }
  50% { opacity: 1; }
}
```

Rules that bind this task: the ROTATING element must be the pseudo itself (transform-only, one composited layer); the mask is a **CIRCLE on a SQUARE box** — an elliptical mask (the default for a non-square box) tumbles end-over-end with the rotation, sweeping beams across the heading/quick-links and past the 420px backdrop seam; `z-index: -1` confines the beams to `.subtitle`'s OWN stacking context (fade-in-up's filled transform creates one) — below the slogan glyphs and above the backdrop, technically above the heading/quick-links (acceptable: low-alpha wash — verify no visible wash on the heading in Step 2); nothing on `.hero` gains `overflow: hidden`; no `filter`, no `mix-blend-mode`, no `will-change`; entrance is inherited from the existing `fade-in-up` on `.subtitle` (pseudos fade with the parent). Note `transform: translate(-50%, -50%)` on pseudos is exempt from the sub-pixel TEXT blur gotcha (no glyphs inside the pseudos).

- [ ] **Step 1: Implement** → gates (`tsc -b` no-op for scss; the PostToolUse scss hook runs).
- [ ] **Step 2: Visual check** at 1280x800 + 430x932 + reduced-motion; confirm beams don't intercept clicks (SearchBar + quick links still operable) and don't visibly clip at the backdrop seam.
- [ ] **Step 3: Commit** — `git commit -m "feat(home): backlit-marquee glow + searchlight beams on the hero slogan"`

---

## Verification gate (after all tasks — REQUIRED)

1. `cd api && pytest tests/ -v` (371 + new) · `cd frontend && npm test && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm run build`.
2. Rebuild local stack frontend (`docker compose -f docker-compose.yml -f <scratch>/db-noport.override.yml up -d --build frontend nginx`).
3. `/verify` live e2e (chrome-devtools):
   - **Flush:** at Platinum/Gold/Silver, cropped-logo rendered box ≈ pad box minus 2×rim (measure clientWidth vs pad clientWidth); legacy letterboxed logo unchanged.
   - **Color screen:** upload at sponsor form, supplier form, AND demo → crop → the selection screen appears with %-ordered rows (descending), hex values, `≈ Name` labels, Primary/Secondary radios; Apply sets both; Skip keeps prior/auto.
   - **Propagation:** supplier-form color save updates its active Platinum sponsorship → /partners carries the pair + `brand_takeover: true` → board branded.
   - **Remap:** on a branded board, sample computed styles/canvas — board gradient from primary; dots/traces/components from secondary.
   - **UNDERGLOW:** capture the lifted-tile glow color (cursor over board, sample the glow-sprite-tinted pixels) on a BRANDED board and an UNBRANDED board — must be the SAME stock color both times. This is the user's binding amendment.
   - **Slogan:** bold + glow renders; beams rotate (transform sampling across rAF frames); reduced-motion freezes them; SearchBar/quick-links clicks unaffected; leak probe — rAF calls/sec unchanged on home (CSS animations don't use rAF).
   - Screenshots: slogan (desktop + mobile), color-selection screen, flush board.
