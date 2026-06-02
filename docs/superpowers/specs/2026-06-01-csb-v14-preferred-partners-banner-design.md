# CSB v14 — Preferred Partners Banner

**Date:** 2026-06-01
**Status:** Approved — proceeding to implementation
**Branch:** `updates`
**Supersedes:** v13 (reverted in `09ad6e1` — sponsor rep fields are gone)

## One-paragraph summary

Take the v9 fixed-banner aesthetic (gold PCB board, IC chips, copper bus,
flashlight, click-to-energize, copy chips) and use it as the presentation
layer for the EXISTING `CategorySupplier.is_featured + rank` data. Replaces
both `CategorySponsorBanner` (parent-cat surface) and `SupplierTable`
(sub-cat surface). One unified component across every category page. Zero
new schema; admin promotes a supplier via the existing CategorySupplier
mechanism. Backend gains a small supplier-rollup for parent-cat so a
parent page surfaces preferred partners from its children, dedup'd by
supplier id.

## Why

- v13 over-built: added a `Sponsor` rep-contact pipeline that duplicated
  what `CategorySupplier` + `Supplier` already model. User's call:
  "combine the preferred Distributors column with the Category Sponsors —
  that is all it has to be."
- The v9 design's visual treatment is the keeper. The information
  architecture changes: instead of one sponsor per category (with rep
  contact), the banner showcases ALL preferred partners for the category
  (with their own contact info already on `Supplier`).
- Admin authoring stays where it is — `is_featured` toggle on the existing
  CategorySupplier admin surface. No new form, no new fields.

## Data

- **Source:** `category.suppliers` filtered to `is_featured === true`,
  sorted by `rank` asc.
- **Backend rollup:** extend `category_service.get_category_by_slug` so
  parent-cat pages aggregate suppliers from children. Predicate:
  `CategorySupplier.category_id IN (self.id + child ids)`. Dedup by
  `supplier.id` — among duplicates, prefer the row with `is_featured=true`
  and lowest `rank`. Mirrors `_build_popular_parts` rollup pattern.
- **Per-chip fields** from existing `Supplier` TS interface:
  `logo_url`, `name`, `phone`, `email`, `website`. Description omitted
  (too long for a chip).

## Behavior

### Layout

- **Desktop:** horizontal rail of IC-chip cards (~280-320px each, fixed
  min width). Rail uses `overflow-x: auto` when the count exceeds
  available width. NO left identity block — the rail spans full banner
  width. Character comes from rim + 4 corner fiducials + bottom-right
  designator (`"CS1 · PREFERRED PARTNERS"`) + top copper bus with a via
  per chip.
- **Mobile (≤1080px):** chips stack vertically. Bus + connector stubs
  hidden.
- **Empty state:** `return null`. No CTA, no open slot, no placeholder.

### Per-chip IC card

- Pin-1 gold dot top-left (orientation marker, v9 convention)
- Refdes top-right: `U1` / `U2` / `U3` / … `U{i}` based on index
- Logo top-center (~56-64px square): `<img src={supplier.logo_url}>` with
  `onError` fallback to a lettermark (2 chars from `name`)
- Supplier name (heading, `.fbConame` class)
- Phone row: `<a href="tel:{...}">{phone}</a>` + CopyAffordance ✓ chip
- Email row: `<a href="mailto:{...}">{email}</a>` + CopyAffordance ✓ chip
- Website row: external link displayed as hostname only
  (e.g. "digikey.com" — `displayHostname()` helper from existing
  SupplierTable, preserve)

### Interactivity (preserved from v9)

- **useFlashlight** — RAF-throttled `pointermove` → `--mx`/`--my` CSS
  vars + `data-lit="true"` on banner root. Attaches only on
  `(hover: hover) AND (pointer: fine) AND prefers-reduced-motion: no-preference`.
- **useEntrance** — Web Animations API double-RAF stagger on
  `[data-enter]` chips (460ms, 50+i*80ms delay,
  `cubic-bezier(.2,.8,.3,1)`, `fill: 'none'` so chips never strand
  invisible).
- **Click-to-energize** — chip onClick → adds `.is-live` class to chip +
  its sibling `.fbVia` (by index, NOT CSS sibling combinator) for 1500ms
  via setTimeout. Tracks active indices in state.
- **CopyAffordance** — `navigator.clipboard.writeText` + 1500ms ✓
  transient + clearTimeout on unmount + `e.stopPropagation()` so chip
  click doesn't co-fire.

### Tier display

Dropped. The current `TopPartners` widget hardcodes `"Silver"` for every
row — not real data. New banner has no tier badge.

## Removed (full delete)

- `frontend/src/public/pages/category/components/CategorySponsorBanner.tsx`
  (the v12 PCB grammar, ~1349 LOC)
- `frontend/src/public/pages/category/components/CategorySponsorBanner.module.scss`
- `frontend/src/public/pages/category/components/SupplierTable.tsx`
- `frontend/src/public/pages/category/components/SupplierTable.module.scss`

## Kept (untouched)

- `frontend/src/public/pages/category/components/SponsorBlock.tsx` —
  sub-cat sponsor card with flashlight reveal. Separate surface; the
  unification with this banner is the future Claude Design round.
- `frontend/src/public/pages/category/components/TopPartners.tsx` —
  sidebar widget. Small + complementary; can be reviewed for removal
  later if redundant.

## File map

| Action | Path |
|---|---|
| Edit | `api/app/services/category_service.py` — supplier rollup for parent-cat |
| New | `api/tests/test_category_supplier_rollup.py` — TDD gate |
| New | `frontend/src/public/hooks/useFlashlight.ts` |
| New | `frontend/src/public/hooks/useEntrance.ts` |
| New | `frontend/src/public/components/CopyAffordance.tsx` + `.module.scss` |
| New | `frontend/src/public/pages/category/components/PreferredPartnersBanner.tsx` + `.module.scss` |
| Edit | `frontend/src/public/pages/category/index.tsx` — drop CategorySponsorBanner + SupplierTable mounts/imports; mount PreferredPartnersBanner on BOTH parent and sub branches |
| Delete | `CategorySponsorBanner.tsx` + `.module.scss` |
| Delete | `SupplierTable.tsx` + `.module.scss` |

## Commit plan

2 atomic commits on `updates`:

1. **`feat(api): roll up preferred suppliers from children on parent-cat`**
   — backend change + test. Sets up the data the banner needs.
2. **`feat(banner): preferred partners IC-chip banner replaces v12 +
   SupplierTable`** — full frontend swap. Old components deleted. Spec
   doc + CLAUDE.md update bundled in.

`./deploy.sh --frontend` enough — no DB migration in this round.

## Acceptance criteria

- `/category/ldo-regulators` (sub-cat) renders the new banner above the
  parts area; ★ Preferred Partner badges from the old SupplierTable are
  gone; chips show name + logo (or lettermark fallback) + phone link +
  email link + website hostname link with copy ✓ on phone/email.
- `/category/power-management-ics-pmics` (parent-cat) renders the new
  banner with suppliers rolled up from children (verify ≥1 chip when
  any child has a featured supplier).
- Click chip → 1500ms gold-flash energize + via glow.
- Hover (desktop) → gold flashlight tracks cursor.
- Click 📋 on phone/email → clipboard write + ✓ toast 1500ms.
- Mobile (≤1080px) → chips stack vertically; bus hidden; lamp display:none.
- Reduced-motion → entrance + lamp disabled; static visible.
- `npx tsc --noEmit` clean; `npx eslint src/` clean; `pytest tests/` no
  new failures.
- Zero new DB migrations; commit history shows no schema changes.
