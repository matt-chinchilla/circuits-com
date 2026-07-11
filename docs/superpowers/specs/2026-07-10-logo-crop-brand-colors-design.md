# Circular Logo Crop Tool + Brand-Color Picker — Design

**Date:** 2026-07-10 · **Status:** Approved (design presented and approved in-session, including the sold-board default flip to branded)

## Problem

1. Uploaded sponsor/supplier logos render letterboxed inside circular frames — "a rectangle inside a circle" — at the four public render sites (Platinum `CsLogo`, Gold `SbLogo`, Silver `svp-markimg`, keyword hero). There is no way to frame the logo so it fills the circle.
2. The Platinum board's brand colors are either auto-extracted with no user say (drag-n-drop demo) or seed-only `Supplier.brand_primary/brand_secondary` columns with no API write path and no admin UI. The sold board rests steel until a visitor clicks the logo pad.

## User-approved decisions

- **Color storage:** on the sponsorship — new `Sponsor.brand_primary` / `Sponsor.brand_secondary` (`String(9)`, nullable, migration 018). Existing `Supplier.brand_primary/brand_secondary` (migration 014) remain the read-side **fallback** so seeded flagships keep today's behavior.
- **Crop UX:** pop-up dialog on file select — circular mask preview, drag-to-pan, zoom slider + wheel, Apply/Cancel. Both hosts: admin `ImageUploadField` (sponsors AND suppliers, shared field) and the Platinum drag-n-drop demo.
- **Banner tint:** **full brand takeover** — when sponsorship-level colors are set, the sold board renders brand-tinted from first paint for every visitor (static CSS vars, no wave on load). The click-toggle back to steel stays. Boards *without* sponsorship colors keep today's exact behavior (steel + click-to-brand using the supplier fallback).

## Technical decisions

- **Crop output = opaque square cover-crop**, 256×256, white underfill, WebP 0.82 → JPEG 0.85 fallback, ≤64,000-char data-URL cap (the existing pipeline's caps). No baked circular alpha mask: the JPEG fallback has no alpha, so a transparent-corner disc would silently grow opaque corners on browsers that can't encode WebP.
- **Circle clipping happens at the render sites**, conditionally on `data:image/` source AND natural squareness (`naturalWidth === naturalHeight`, checked in `onLoad`): the pre-existing upload pipeline (live since 2026-06-22) is aspect-preserving, so older stored data-URLs are generally rectangular wordmarks that must NOT be circle-cropped. New crops are always square. Legacy rectangular data-URLs and remote wordmark URLs keep today's letterbox rendering — no visual harm to existing content. Platinum already circle-clips everything; admin thumbnails stay rounded-square.
- **Palette extraction is hoisted to `@shared`** (`extractBrandPalette`): the algorithm moves verbatim from `csFx.tsx:651-710` (28×28 downscale, alpha≥140, 0.06<lightness<0.94, saturation≥0.28, 15×24° hue buckets, population-ranked) and now also returns the ranked bucket averages as `swatches` (the "identified, provided options"). `color-mix()` strings are replaced by equivalent per-channel sRGB math (`mixHex`) so results are concrete hex — required for DB storage. Single source; `CategorySponsor` consumes it from `@shared`; the copy in `csFx.tsx` is removed (`brandVars` and its canvas-readback helpers stay in `csFx` untouched).
- **`brand_takeover: bool`** on the public `SponsorResponse` (default `False`, stamped `bool(sponsor.brand_primary or sponsor.brand_secondary)`) tells the frontend "explicit sponsorship colors exist → auto-brand". Without it the frontend cannot distinguish sponsor-level colors from the supplier fallback once the API resolves precedence.
- **Hex validation at both boundaries:** server-side `validate_optional_hex_color` (`#RRGGBB` fullmatch → else 422) as a `field_validator` on `AdminSponsorCreate/Update` (mirror of `validate_optional_image_url`); client-side `safeHexColor` guard before any stored color enters an inline `style` (CSS-injection defense-in-depth, mirror of `safeImageUrl`).

## Units

| Unit | Location | Purpose |
|---|---|---|
| `image.ts` (moved) | `@shared/utils/image.ts` | `loadImage` (exported, optional `crossOrigin`), `canvasToDataUrl` (encode + caps), `MAX_DATA_URL_BYTES`. Moves from `@admin/utils/image.ts` (now ≥2 consumers: admin field + public demo). |
| `color.ts` | `@shared/utils/color.ts` | `safeHexColor`, `mixHex`, `rgbToHex` — pure, vitest-covered. |
| `brandPalette.ts` | `@shared/utils/brandPalette.ts` | Pure pixel-bucket core (`paletteFromPixels`) + thin canvas shell (`extractBrandPalette`). |
| `LogoCropperModal` | `@shared/components/LogoCropperModal/` | Portal dialog: pan (pointer capture) + zoom (slider/wheel/keyboard), circular mask, Apply → 256² canvas. Pure geometry in `geometry.ts` (vitest). Focus-trapped, Esc closes, `aria-modal`, body scroll-lock, reduced-motion safe. |
| `BrandColorPicker` | `@shared/components/BrandColorPicker.tsx` | Two labeled swatch rows (Primary/Secondary) from `extractBrandPalette(logoSrc)`; `allowCustom` hex input (admin), `compact` mode (public pitch). Cancel-flagged extraction effect; curated default swatches when extraction is impossible. |
| Backend write path | migration 018, `models/sponsor.py`, `schemas/sponsor.py`, `utils/color.py`, `routes/admin_sponsors.py` | Columns + validators + admin serialize. |
| Backend read path | `services/category_service.py`, `routes/sponsors.py`, `schemas/sponsor.py` | `sponsor.brand_* or supplier.brand_*` precedence + `brand_takeover`; keyword route stamps the same fields (documented asymmetry trap). |
| Admin integration | `ImageUploadField.tsx`, `pages/sponsors/form/index.tsx`, `types/admin.ts` | Crop step in `onPick`; Brand Colors field in the Creative panel; FormState/hydrate/buildSponsor/validate threading. |
| Public integration | `CategorySponsor.tsx` | Demo: drop → crop modal → palette → pitch → wave; pitch swatch strip re-waves; sold board `branded` initializes from `brand_takeover`; `safeHexColor` guards. |
| Render CSS | `SponsorBlock`, `silverPartners.scss`, keyword page | Conditional circle-completion classes for `data:` logos via shared `isDataImage`. |

## Data flow

- **Admin upload:** file → `LogoCropperModal` → 256² canvas → `canvasToDataUrl` → `form.image_url`/`logo_url` → POST/PATCH (image validators unchanged) → DB `Text` column → render sites via `safeImageUrl`.
- **Admin colors:** logo data-URL → `extractBrandPalette` → swatches → admin picks (or custom hex) → `form.brand_primary/secondary` → hex validator → `sponsors.brand_*` → `/partners` resolves precedence + `brand_takeover` → `CategorySponsor` → `brandVars()` inline CSS vars → board.
- **Public demo:** drop → crop modal → canvas → data-URL + palette → `PitchState` (sessionStorage `cs-pitch-<slug>`, now stores the small cropped data-URL instead of the raw full-size file — fixes a latent quota risk) → `runWave`. Swatch pick → new PitchState → sessionStorage → `runWave`.

## Error handling

- Encode failure / >64KB → field error via the existing error path; modal decode failure → inline error + Cancel remains available.
- Invalid hex → client `validate()` message + server 422 surfaced via `apiErrorDetail`.
- Extraction impossible (tainted cross-origin canvas, broken image) → curated default swatches; custom hex input still works.
- `safeHexColor` returns `null` on anything not `#RRGGBB` → board falls back to defaults, never injects.

## Performance & stability invariants

- csFx visual consts (GAP 19 / shimmer .36 / dome R 72 / flip .34·255), the frame loop, and the destroyed-guard are **untouched**. Recoloring uses only the existing `brandVars()` + `wave()`/reduced-motion path.
- The modal starts no persistent loops; pointer capture is released on up/cancel; object URLs revoked in `finally`/unmount; all effects cancel-flagged. Interaction-then-navigate rAF probe must show no new loops.
- Extraction canvas is 28×28 — negligible.

## Testing

- **vitest:** cropper geometry (cover scale, offset clamp, source rect), `canvasToDataUrl` cap/fallback logic (stub canvas), `paletteFromPixels` on synthetic pixel arrays (ranking, skip rules, secondary mix parity), `safeHexColor`/`mixHex`, `isDataImage`.
- **pytest:** hex validator accept/reject/None; column metadata (`length >= 7`); admin POST/PATCH roundtrip + 422; `/partners` precedence (sponsor overrides supplier; fallback; `brand_takeover`); keyword route carries the fields.
- **chrome-devtools e2e (verification gate):** admin upload → crop → save → sold board branded from first paint; drag-n-drop → crop → swatch pick → wave; four render sites circular for cropped logos; modal a11y (focus trap, keyboard zoom/pan, Esc, contrast); rAF interaction-then-navigate leak probe.
- **Completion gates (user-mandated):** `superpowers:verification-before-completion` + `/verify` before any claim of done — `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm test`, `npm run build`, `pytest tests/ -v`, plus live-app observation.

## Out of scope

- Supplier-form color editing (columns stay seed/fallback-only), keyword-page hero tinting, animated-GIF preservation through crop (output is a static frame), re-cropping already-stored logos (re-upload instead), seed changes (prod boards stay steel until an admin sets colors — the migration only adds NULL columns).
