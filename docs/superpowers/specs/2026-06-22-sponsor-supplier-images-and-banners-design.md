# Sponsor/Supplier image uploads + Gold copy + Silver "Preferred Partners" banner

**Date:** 2026-06-22
**Branch:** `updates`
**Status:** Approved (design), pending implementation plan

## Summary

Four edits to the circuits.com sponsor/supplier surfaces:

1. **Sponsor image upload** — admins can upload a photo/icon for a sponsorship
   instead of only pasting an image URL.
2. **Supplier photo** — admins can set a supplier's logo/photo during create or
   edit (reusing the existing-but-unexposed `Supplier.logo_url` column), and it
   surfaces in admin views and across all sponsor boards.
3. **Gold empty-ad copy** — the unsold Gold ("Advertise Here") card mentions the
   "Visit Website" direct-link benefit.
4. **Silver "Preferred Partners" banner** — a floating center pill on the Silver
   board, mirroring Platinum's badge, keeping Silver the same height as Gold.

## Decisions (locked with the user)

- **Image storage = base64 data-URL in the DB.** The uploaded file is downscaled
  + compressed client-side and stored as a `data:image/...;base64,...` string in
  the existing image column (widened to `Text`). Rationale: the API container has
  **no volume mount** (CLAUDE.md gotcha — disk writes are wiped on every rebuild),
  so filesystem upload is actively broken; the DB *does* have a persistent volume.
  Public `<img src>` renders data-URLs natively, so no render-path change is
  needed. S3 is overkill for a one-EC2 demo.
- **Supplier photo = reuse `logo_url`, show everywhere.** `Supplier.logo_url`
  already exists (`String(500)`), already flows through `supplier_to_dict`,
  `SupplierResponse`, `AdminSupplier`, and the public board dict, and Platinum
  already falls back to it (`image_url ?? logo_url`). We expose it in the form and
  extend Gold + Silver to use it too — one upload benefits every tier.
- **Silver banner = floating center pill** (not a top header band), mirroring
  Platinum's `.csb-badge`, with the sticky column-label headrow nudged down to
  clear it.

## Current-state findings (from codebase exploration)

- `Sponsor.image_url` = `String(500)`, nullable (`api/app/models/sponsor.py:28`).
  Already in `AdminSponsorCreate/Update/Response` and the admin sponsor form's
  `buildSponsor` — rendered today as a plain text input.
- `Supplier.logo_url` = `String(500)`, nullable (`api/app/models/supplier.py:21`).
  **Not** in `SupplierCreate`/`SupplierUpdate` (`api/app/routes/suppliers.py:33,46`)
  and **not** in the supplier admin form — but `supplier_to_dict` returns it
  (`:68`), the `AdminSupplier` TS type has it (`admin.ts:123`), and `update_supplier`
  uses `model_dump(exclude_unset=True)` + `setattr` (`:165`), so adding it to the
  Update schema auto-wires PUT; only `create_supplier` (`:107`) needs an explicit
  `logo_url=body.logo_url`.
- Public render passes logo `src` straight to `<img>` (no sanitization);
  `safeHttpUrl` is only on the `website` hyperlink. A `data:` URL renders fine and
  would be *rejected* by `safeHttpUrl` (http/https only) — so we must NOT route
  logos through `safeHttpUrl`; instead add a dedicated `safeImageUrl`.
- An existing client-only `FileReader`/`readAsDataURL` pattern lives in
  `CategorySponsor.tsx` (the prospect pitch demo, sessionStorage-only, never
  persisted) — reference, not reuse.
- Gold reads `sponsor.image_url` only (`SponsorBlock.tsx:526`); Silver renders no
  logo at all (lettermark only). The board dict (`category_service._sponsor_board_dict`)
  already maps both `image_url` (sponsor) and `logo_url` (supplier).
- Silver board has **no** top banner today; topmost element is the sticky
  `.svp-headrow` column labels (`Company / Sales Contact / Phone / Email`). Silver
  height is driven externally by `.tierRowMain > .svp { position:absolute; inset:0 }`
  + `.tierRow { align-items:stretch }`, so an internal banner doesn't change height.

## Architecture

### Shared building blocks

- **`@admin/utils/image.ts` — `fileToDataUrl(file, opts?)`**
  - Draw the image to a `<canvas>`, downscale the **longest edge to 256px** (only
    downscale, never upscale), export **WebP @ quality 0.82** with a **JPEG @ 0.85
    fallback** when the browser lacks WebP encode.
  - Reject non-image MIME, reject anything still over a hard cap (**~64 KB**) after
    compression, return `{ ok: true, dataUrl }` / `{ ok: false, error }`.
  - Pure async helper (no React); revoke the object URL and drop the `Image`/`File`
    references after encode (memory-leak hygiene).
- **`@admin/components/ImageUploadField.tsx`**
  - Props: `value: string`, `onChange(next: string)`, `label`, `id`, optional
    `hint`. Renders: a preview thumbnail (when `value` is set), a file picker /
    drop-zone button ("Upload image"), a "Clear" button, **and** the existing
    "paste a URL" text input as an alternative path. Upload → `fileToDataUrl` →
    `onChange(dataUrl)`; URL input → `onChange(text)`.
  - Accessibility: real `<label htmlFor>`, keyboard-activable picker, `alt` on the
    preview, an `aria-live` region for upload errors (too-big / not-an-image).
  - Consumed by both the sponsor form and the supplier form (≥2 consumers, both in
    `@admin` — satisfies the boundary rule).
- **`@shared/utils/url.ts` — `safeImageUrl(input)`** (new, beside `safeHttpUrl`)
  - Allow: `http:`/`https:` (via the existing URL parse), and raster data-URLs
    `data:image/(png|jpeg|jpg|webp|gif|avif);base64,...`.
  - Reject: `javascript:`, `data:text/html`, `data:image/svg+xml` (SVG can carry
    script), and anything else → returns `null` (caller hides the image / shows the
    lettermark).
  - Applied at the three logo render sites (CsLogo / SbLogo / Silver chip).

### Edit 1 — Sponsor image upload
- `frontend/src/admin/pages/sponsors/form/index.tsx`: swap the bare `image_url`
  `<input type="text">` (the "Creative" panel) for `<ImageUploadField value={form.image_url}
  onChange={(v) => update('image_url', v)} ... />`. No schema/service change.

### Edit 2 — Supplier photo
- `api/app/routes/suppliers.py`: add `logo_url: str | None = None` to
  `SupplierCreate` and `SupplierUpdate`; add `logo_url=body.logo_url` to the
  `Supplier(...)` ctor in `create_supplier`. (`update_supplier` + `supplier_to_dict`
  already handle it.)
- `frontend/src/admin/pages/suppliers/form/index.tsx`: add `logo_url` to `FormData`,
  `emptyForm`, the hydrate map, and the submit payload; render `<ImageUploadField>`
  in the Identity panel ("Logo / Photo").
- `frontend/src/admin/pages/suppliers/list/index.tsx` + `.../detail/index.tsx`:
  render a small logo thumbnail (fallback to the existing lettermark when absent).
- Public render fallbacks:
  - `SponsorBlock.tsx` (Gold): `SbLogo src={safeImageUrl(sponsor.image_url ?? sponsor.logo_url)}`
    (the board dict already provides `logo_url`).
  - `SilverPartners.tsx` (Silver): render the `logo_url` avatar via `safeImageUrl`
    when present; lettermark otherwise.
  - `CategorySponsor.tsx` (Platinum): route its existing `image_url ?? logo_url`
    through `safeImageUrl`.

### Edit 3 — Gold empty-ad copy
- `frontend/src/public/pages/category/components/SponsorBlock.tsx:504-506`: extend
  the pitch sentence to name the Visit-Website direct link. Final wording tuned in
  frontend-design; working draft: *"Reach buyers actively browsing this category.
  Get featured placement with your brand, logo, direct contact details, and a
  'Visit Website' button linking straight to your store."*

### Edit 4 — Silver "Preferred Partners" floating pill
- `frontend/src/public/pages/category/components/SilverPartners.tsx`: add a floating
  center pill (reuse the `.csb-badge` look from `categorySponsor.scss`, or a new
  `.svp-badge` mirroring it) reading **"◆ PREFERRED PARTNERS"**, positioned
  `absolute; top; left:50%; translateX(-50%)` above the board surface.
- `silverPartners.scss`: nudge the sticky `.svp-headrow` `top`/`padding` down so the
  column labels clear the pill. No height change needed (external absolute sizing).

### Migration 017 (the only DB change)
- `api/alembic/versions/017_widen_image_columns_to_text.py` (revision `017`,
  down_revision `016`): `ALTER COLUMN` `sponsor.image_url` and `supplier.logo_url`
  from `String(500)` → `Text`. On Postgres `varchar→text` is a metadata-only,
  non-destructive widening. `downgrade()` narrows back to `String(500)` (data
  longer than 500 chars would be truncated/blocked — acceptable for a down).
- Model edits: `Sponsor.image_url` and `Supplier.logo_url` → `Column(Text, ...)`.

## Testing strategy (TDD-first)

- **Backend (pytest, SQLite):**
  - `logo_url` round-trips: `POST /api/suppliers/` with `logo_url` → `GET` returns
    it; `PUT` sets it. (auth-gated create/update.)
  - A `>500`-char data-URL persists and round-trips (proves the `Text` widening; on
    SQLite, also assert column metadata is `Text`/length `None`, since SQLite
    ignores `String(N)` length).
  - Migration `017` up/down smoke (revision chain intact).
- **Frontend (vitest):**
  - `safeImageUrl` allow/deny table (http/https/data:image-raster allowed;
    javascript:/data:text/html/data:image/svg+xml/garbage rejected) —
    `frontend/src/shared/utils/url.test.ts`.
  - `fileToDataUrl` guard logic: non-image rejected, over-cap rejected — with a
    stubbed canvas/`Image` (happy-dom).
- **Visual + a11y (chrome-devtools):** Silver pill + Gold copy at 1440/900/430px;
  a11y check on `ImageUploadField` (label, keyboard, alt, error `aria-live`).

## Risks & mitigations

- **Response bloat:** base64 logos inflate `/partners` payloads. Mitigated by the
  256px/WebP downscale (a few KB each) and the endpoint's existing ETag + no-cache.
- **XSS via image strings:** admins now store free-form image strings; `safeImageUrl`
  blocks `javascript:`/`data:text/html`/`data:image/svg+xml` at every render site.
- **Memory:** the canvas/`FileReader` encode path must revoke object URLs and drop
  large `File`/`Image` refs after producing the data-URL.
- **Migration safety:** `varchar(500)→text` is non-destructive on Postgres
  (metadata-only). The `migration-safety-check.sh` commit hook will see the new
  revision.

## Out of scope

- No file-upload endpoint / object storage / nginx static route.
- No new supplier column (reusing `logo_url`).
- No change to the sponsor single-slot block logic (recently shipped).
