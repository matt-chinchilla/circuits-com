# CSB v15 — Preferred Partners (Final)

**Date:** 2026-06-02
**Status:** Approved — proceeding to implementation
**Branch:** `updates`
**Supersedes:** v14 (`215baaf` on master + updates)
**Handoff:** Claude Design `9r_j6EMPd9tCcmHpyADZRA` (design-handoff-v10/)
**Deploy hold:** Active — do NOT push to prod until user clears.

## One-paragraph summary

Replace the v14 horizontal-scroll chip rail with the v15 bicameral
layout: left identity block (count + CTA) + right vertical-stack
directory of 5-column rows (medallion · Company · Sales Contact · Phone
· Email). Frontend-only; no backend changes (existing
`Supplier.contact_name` is the rep name, no new fields needed). Dropdown
toggle dropped per user direction — always render all featured
suppliers expanded. The `Supplier.contact_title` field from the v15
chat is dropped per user direction; the rep cell renders
`contact_name` on a single line with no secondary title.

## Why

The v14 horizontal scroll worked for the 1-3 partner case but buries
the long tail. The v15 design treats the banner as a
**partner directory**: columns aligned across rows so a visitor can
scan all featured suppliers' contact info at once. Restoring the left
identity block reframes the banner from "look at this one sponsor"
(v14) to "here are *all* our preferred partners for this category"
(v15).

## Decisions

| Question | Answer | Reason |
|---|---|---|
| Empty rep title | Omit the title row entirely | User: "field is not necessary, omit it" |
| Default expand state | Always expanded (no toggle) | User: "Expanded (show all)" |
| Backend `contact_title` migration | Skipped | Implicit in the omit-title decision |
| PCB background | `<CircuitTraces variant="static" />` | User: "PCB background re-running like the main site". `static` keeps the gold trace lattice but skips electrons + draw-in (Tier-3 #6 perf invariant — `/category/*` must use `static` because BackdropLayer already mounts a `full` instance globally; `full` here doubles SMIL cost). |
| Flashlight (`useFlashlight` / `.fbLamp`) | REMOVED | User: "I do not think this needs the flashlight". `useFlashlight.ts` deleted. |

## Data

- **Source:** `category.suppliers` filtered to `is_featured === true`,
  sorted by `rank` asc. The parent-cat rollup added in v14 is
  PRESERVED — no backend changes.
- **Per-row fields** from existing `Supplier`:
  - `logo_url` → medallion (img with onError → lettermark fallback)
  - `name` → company name (col 2 primary line)
  - `rank` (from CategorySupplier, but currently flat on Supplier in
    the public API since the rollup denormalizes) → `#N` rank chip
    inline with company name
  - `website` → small site link UNDER company name in col 2 (e.g.
    "⊕ ti.com" via `displayHostname()`)
  - `contact_name` → rep name (col 3 single line; the title row is
    omitted)
  - `phone` → col 4 with `tel:` link + ⧉ copy pill
  - `email` → col 5 with `mailto:` link + ⧉ copy pill

## Layout

### Bicameral grid

```
.fb { display: grid; grid-template-columns: minmax(258px, 312px) 1fr; }
  .fbCircuit / .fbLamp / .fbRim / .fbFid×4 / .fbDes  (shared chrome, z-layers 0-6)
  .fbId          (left, 258-312px)
    .fbKicker   "◆ Preferred Partners"
    .fbIdCount  ".fbCountNum (huge) + .fbCountLabel ('Featured suppliers / in {Category}')"
    .fbIdTag    paragraph tagline
    .fbCta      "[Become a partner →]"
  .fbRail        (right, 1fr)
    .fbHead      column header silkscreen labels
    .fbStackScroll
      .fbStack
        .fbBusLine     (vertical copper bus, left gutter)
        .fbChip[]      (one per featured supplier)
```

### Per-row chip

5-column grid sharing `--cols` token with `.fbHead`:

```
--cols: 44px minmax(150px, 1.5fr) minmax(132px, 1.25fr)
        minmax(140px, 1.2fr) minmax(158px, 1.35fr);
```

| Col | Class | Content |
|---|---|---|
| 1 | `.fbLogoBlock` | 44×44 circular medallion · `<img>` w/ lettermark fallback |
| 2 | `.fbCol.fbColCompany` | `.fbConame` (name + `#N` rank chip) · `.fbSiteLink` (⊕ hostname) |
| 3 | `.fbCol.fbColRep` | `.fbRepName` (single line — no title) |
| 4 | `.fbCol.fbColPhone` | `.fbFoot` → `<a href="tel:..">` + `.copyChip` |
| 5 | `.fbCol.fbColEmail` | `.fbFoot` → `<a href="mailto:..">` + `.copyChip` |

Each chip also has `.fbVia` (centered on row, inside the bus gutter)
and `.fbRefdes` (U1/U2/... top-right).

### Responsive

- ≥1080px — full bicameral grid (`grid-template-columns: minmax(258px, 312px) 1fr`).
- ≤1080px — `grid-template-columns: 1fr`; `.fbId` border switches from
  right-dashed to bottom-dashed.
- ≤980px — `.fbHead` and `.fbBusLine` + `.fbVia` hidden; chips collapse
  to 2-col `44px 1fr` card-per-row with stacked cells.

## Interactivity

- **useEntrance** — WAAPI stagger on `[data-enter]` chips,
  `fill: 'none'` so chips don't strand invisible.
- **Click-to-energize** — chip onClick adds `.fbChipIsLive` to chip +
  `.fbViaIsLive` to its via for 1500ms. Chip `onKeyDown` Enter/Space
  GATED on `e.target === e.currentTarget` so the keypress doesn't cancel
  link/button activation when an inner `<a>` or copy `<button>` is focused.
- **CopyAffordance (compact)** — the existing `@public/components/CopyAffordance`
  with a new `compact` prop. Renders an inline ⧉/✓ round pill (no text
  label). Behavior unchanged: async `clipboard.writeText` + 1500ms ✓
  transient + cleanup on unmount.

## Removed

| Class / file | Reason |
|---|---|
| `.fbBus` (top horizontal) | Replaced by `.fbBusLine` (left vertical) |
| `.fbChip { flex-direction: column }` | Now grid columns |
| Horizontal scroll on `.fbRail` | Now vertical stack with `.fbStackScroll` |
| `.fbLamp` + `useFlashlight.ts` (file deleted) | User direction: no flashlight |
| Local `CopyChip` subcomponent | Replaced by `<CopyAffordance compact />` (reuse, not fork) |

## Added

| Class | Purpose |
|---|---|
| `.fbId` + nested (`.fbKicker`, `.fbIdCount`, `.fbCountNum`, `.fbCountLabel`, `.fbIdTag`, `.fbCta`) | Left identity block |
| `.fbHead` + `.fbHeadCell` | Column header silkscreen |
| `.fbStackScroll` + `.fbStack` | Vertical stack container with optional scroll cap |
| `.fbBusLine` | Vertical bus in left gutter of rail |
| `.fbCol`, `.fbColCompany`, `.fbColRep`, `.fbColPhone`, `.fbColEmail` | Per-row cells |
| `.fbConameTxt`, `.fbRank` | Inside `.fbConame` |
| `.fbSiteLink`, `.fbSubIcon` | Website hostname row under company |
| `.fbRepName` | Rep name (no `.fbRepTitle` per omit decision) |
| `.copyChip`, `.copyChipCopied` | Inline copy pill (replaces CopyAffordance in this banner) |

## File map

| Action | Path |
|---|---|
| Edit | `frontend/src/public/types/supplier.ts` — add `contact_name: string \| null` |
| Rewrite | `frontend/src/public/pages/category/components/PreferredPartnersBanner.tsx` |
| Rewrite | `frontend/src/public/pages/category/components/PreferredPartnersBanner.module.scss` |
| Edit | `frontend/src/public/components/CopyAffordance.tsx` — add `compact` prop |
| Edit | `frontend/src/public/components/CopyAffordance.module.scss` — add `.copyCompact` |
| Add | `api/app/routes/admin_category_suppliers.py` — POST `/unfeature` endpoint |
| Add | `api/tests/test_admin_category_suppliers.py` — 5 round-trip tests |
| Edit | `frontend/src/admin/services/adminApi.ts` — `unfeatureSupplierInCategory()` |
| Delete | `frontend/src/public/hooks/useFlashlight.ts` (orphan after lamp removed) |
| Keep | `frontend/src/public/hooks/useEntrance.ts` |
| Keep | `api/app/services/category_service.py` — parent-cat rollup (v14) |

## Open follow-ups (not blocking)

- **Admin UI for unfeature** — the backend endpoint + adminApi method exist
  and pass tests but no admin button calls `unfeatureSupplierInCategory()`
  yet. Today admins must hit the API directly or delete the supplier (which
  cascades the row away). A row-level "Unfeature" button on the supplier
  detail page is the smallest cohesive surface.
- **Promote helpers to `@shared/utils/`** — `prependScheme()` is inlined in
  the banner; same shape lives in `admin/pages/suppliers/form/index.tsx`
  (≥2-consumer rule already satisfied). `lettermark()` has 5 copies across
  the repo per the F-reuse review finding. Both belong in `@shared/utils/`.

## Acceptance criteria

- `/category/ldo-regulators` and `/category/power-management-ics-pmics`
  render the new bicameral banner with:
  - Identity block on the left showing the count + CTA.
  - Right rail with column header (`Company · Sales Contact · Phone ·
    Email`) and one row per featured supplier.
  - Vertical copper bus in left gutter of rail with one via per row.
- Rep cell shows `contact_name` on a single line (no title beneath).
- Phone + Email cells show `tel:` / `mailto:` links + a ⧉ copy pill
  that flips to ✓ for 1500ms on click.
- Click chip → 1500ms gold-flash energize + via glow.
- Hover (desktop) → gold flashlight tracks cursor.
- ≤980px → columns collapse to stacked card per supplier; bus hidden.
- **Round-trip test**: toggling `is_featured` on a CategorySupplier in
  admin → chip appears/disappears on the category page within a
  refresh (no cache invalidation strategy beyond existing
  StaleWhileRevalidate).
- `npx tsc --noEmit` clean; `npx eslint src/` clean.

## Commit plan

One atomic commit on `updates`:

**`feat(banner): v15 preferred-partners — bicameral grid + column directory`**

No deploy. Branches stay at `215baaf` until user clears the hold.

## Future work (out of scope)

- Add `Supplier.contact_title` if user later wants the title row.
- Re-enable dropdown toggle if banners get crowded (10+ partners).
- Promote `CopyAffordance` to `@shared/` once a second consumer exists.
