# CSB v13 — Fixed-Banner Port (Claude Design v9 handoff)

**Date:** 2026-06-01
**Status:** Approved — proceeding to explore + architect
**Branch:** `updates`
**Supersedes:** v12 (`docs/superpowers/specs/2026-06-01-csb-v12-pcb-grammar-port.md`)

## One-paragraph summary

Replace the v12 wide-PCB CategorySponsorBanner (4 DIP chips on horizontal SMT
strips, ~1130 LOC) with the v9 handoff's "fixed-banner" port: a restrained
2-column board — left identity block, right 4-IC-chip rail (Company / Contact /
Phone / Email) — with cursor flashlight, copper-bus + vias, click-to-energize,
copy-to-clipboard on phone/email, and an inline "Contact rep" form morph that
posts to a new API endpoint and persists to `Message`. Backend gains 9
nullable Sponsor rep-contact columns and a new `POST /api/sponsor-rep-request`
route. The category API's `sponsor: SponsorResponse | null` field is replaced
by `top_sponsors: SponsorResponse[]` (length 1 today) so a future multi-sponsor
follow-up is a `.map()` swap.

## Why

- v12 ("PCB grammar") drifted into busy SMT-component territory; the user
  asked for "a return to form" — closer to Concept A from the original handoff
  series, which the v9 fixed-banner rebuild is.
- The v9 handoff README's `fixed-banner.css` lead-comment explicitly frames
  this as the cleanup pass: "Concept A's balance + a RESTRAINED 'alive IC/PCB'
  layer · the noisy micro-component strips are gone · copper is hidden and only
  revealed inside the cursor flashlight."
- The CSB needs to carry real per-sponsor rep contact data ("the partners'
  field set — COMPANY · CONTACT · PHONE · EMAIL"); today's Sponsor model only
  has company-name + image_url + category_id + tier + status. Without rep
  fields, the new design renders blank.
- The user has flagged a follow-up unification of the sub-category SponsorBlock
  with the category banner (separate Claude Design round). The list shape
  (`top_sponsors[]`) prepares the API for that consolidation without forcing
  it now.

## Source-of-truth files (in handoff)

- `design-handoff-v9/circuits-com-design-system/project/category-sponsor/fixed-banner.html`
- `design-handoff-v9/circuits-com-design-system/project/category-sponsor/fixed-banner.css`
- `design-handoff-v9/circuits-com-design-system/project/category-sponsor/CategorySponsorBanner.jsx`
- `design-handoff-v9/circuits-com-design-system/project/category-sponsor/csb-shared.jsx`
- `design-handoff-v9/circuits-com-design-system/project/category-sponsor/banner.css` (tokens block — `--gold`, `--board-*`, `--cream*`)

## Behavior (visual + interaction)

### Layout

- `.fb` root: `display: grid; grid-template-columns: minmax(252px, 320px) 1fr; border-radius: 14px; overflow: hidden;`
- Left **identity block** (`.fb-id`): kicker pill ("◆ Category Sponsor"), round
  lettermark pad (`.fb-pad`) with `.fb-mark` text or `.fb-logo <img>`, company
  name (`.fb-coname`), blurb (`.fb-cotag`), gold "Contact rep →" CTA (`.fb-cta`).
- Right **4-chip rail** (`.fb-rail`): four `.fb-chip` cards (Company, Contact,
  Phone, Email). Each chip has `::before` pin-1 dot top-left, `::after` short
  connector stub to the bus, `.fb-refdes` (U1..U4) top-right, `.fb-plabel`
  caps label, `.fb-val` value, optional `.fb-foot` (sub + `.fb-copy` chip).
- **Bus** (`.fb-bus`, abs-positioned across top of rail): 1.5px gradient
  `.fb-bus-line`, four `.fb-via` 9px gold-radial vias above each chip center.

### Always-on ornament

- `.fb-circuit` — lifted CircuitTraces SVG behind, masked-radial fade,
  opacity .42, copper-gold strokes.
- `.fb-rim` — gold gradient outline via `mask-composite: exclude` (gated
  `@supports`-style fallback to plain border).
- `.fb-fid` × 4 — 9px dashed-ring corner fiducials (tl/tr/bl/br).
- `.fb-des` — tiny mono "CS1 · CATEGORY-SPONSOR" bottom-right.

### Interactive layers

- **`useFlashlight(ref)`** — RAF-throttled `pointermove` → sets `--mx`/`--my`
  + `data-lit="true"` on `.fb`. Only attaches when
  `(hover: hover) and (pointer: fine)` AND `prefers-reduced-motion: no-preference`.
  Handles `transform: scale()` ancestor by dividing `clientX/Y` deltas by the
  live scale. The `.fb-lamp` is a 180px gold radial with `mix-blend-mode: screen`,
  z-index 7.
- **`useEntrance(ref, dep)`** — Web Animations API. Stagger on
  `[data-enter]` chips (460ms, 50+i*80ms delay,
  `cubic-bezier(.2,.8,.3,1)`). `fill: none` so chips are NEVER stranded
  invisible (CSS resting state is fully visible).
- **Click-to-energize** — chip gets `is-live` class for 1500ms (charge
  box-shadow keyframe + pad pulse + via glow). On click also sets a sibling
  `.fb-via.is-live` for 1500ms.
- **`CopyAffordance`** — phone + email chips host a small button:
  `navigator.clipboard.writeText` + transient ✓ for 1500ms.
- **`RepForm`** — "Contact rep →" CTA flips `view: 'info' → 'form'`. Right rail
  is replaced by `<RepForm rep={contact_name} onClose={...} />`. Form: name +
  email + optional note. `noValidate` + JS validation (email regex
  `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`). On submit POST →
  `POST /api/sponsor-rep-request` with `{ sponsor_id, name, email, note }` →
  on 200 render success card with `CS-XXXXXX` request id (response
  `{ request_id }`).

### Tier overrides (`data-tier`)

- `featured` (default) — gold (`--gold #e8c252`)
- `silver` — neutral cool grays
- `platinum` — whites / pale-blue grays
- `is-empty` (no sponsor) — desaturated gold + "open slot" placeholder copy

### Responsive

- `≤1080px`: collapse to 1-col (`.fb-id` border-bottom dashed instead of
  border-right), rail → 2-col grid, bus + chip stubs hidden.
- `≤560px`: rail → 1-col.

### Reduced motion

- Disable entrance animation, lamp, electron motion. Chips stay fully visible
  (CSS resting state).

## Backend

### Migration

- Alembic version `0XX_add_sponsor_rep_fields.py`. All 9 cols nullable:
  - `contact_name: String(80)`
  - `role: String(80)`
  - `phone: String(40)`
  - `hours: String(60)`
  - `email: String(120)`
  - `division: String(80)`
  - `partno: String(60)`
  - `lettermark: String(8)`
  - `blurb: String(160)`

### Schemas

- `SponsorCreate`/`SponsorUpdate`/`SponsorResponse` extended with the 9 fields,
  all `Optional[str] = None`.
- `MessageKind` enum gains `'sponsor_rep_request'`.

### Routes

- `routes/categories.py`:
  - `CategoryDetailResponse.sponsor: SponsorResponse | None` →
    `CategoryDetailResponse.top_sponsors: list[SponsorResponse]` (length-1 today).
  - `category_service.get_category_detail(...)` returns a list (mirror of
    existing single-sponsor selection logic: newest non-Expired sponsor for
    this category).
- `routes/sponsor_rep_requests.py` (new):
  - `POST /api/sponsor-rep-request`
  - Body: `SponsorRepRequest { sponsor_id: UUID; name: str; email: EmailStr; note: str | None }`
  - Persists `Message` row with `kind='sponsor_rep_request'`,
    `subject=f"Callback request for {sponsor.company_name}"`, body = the form
    payload.
  - Schedules `email.send_sponsor_rep_notification(sponsor, message)` via
    `BackgroundTasks` (mirrors `send_keyword_request_notification`).
  - Returns `{ request_id: f"CS-{message.id:06X}" }` (uppercased hex of the
    Message PK, 6 chars, deterministic).

### Email composer

- `email.send_sponsor_rep_notification(sponsor, message)` —
  subject `[Sponsor Rep Request] {company_name}`, body: rep name,
  rep contact, requester name + email + note + request id.
  Recipients = `NOTIFY_RECIPIENTS` (existing).

### Tests (TDD gate — must fail before implementation)

- `api/tests/test_sponsor_rep_request.py`:
  - `POST /api/sponsor-rep-request` happy path returns 200 + `request_id`
    matching `/^CS-[0-9A-F]{6}$/`.
  - Persists a `Message` row with `kind='sponsor_rep_request'`.
  - Unknown `sponsor_id` → 404.
  - Invalid email → 422 (Pydantic `EmailStr`).
  - Schedules email via `BackgroundTasks` (assert via `app.dependency_overrides`
    or a spy).
- `api/tests/test_sponsor_rep_fields_metadata.py`:
  - `Sponsor.__table__.c.contact_name.type.length >= 80`, etc.
  - (SQLite ignores `String(N)` length; metadata assertion is dialect-agnostic.)
- `api/tests/test_category_top_sponsors_field.py`:
  - `GET /api/categories/{slug}` returns `top_sponsors` as a list (≥0 long).
  - Singular `sponsor` field is absent (or returns `top_sponsors[0]` for back-compat — TBD in architect step).

## Frontend

### Component composition

- `CategorySponsorBanner.tsx` (replaces v12 in place)
  - Reads `top_sponsors: SponsorResponse[]` from the parent category response.
  - Renders nothing when array empty (or `.fb.is-empty` placeholder — gate
    decided in architect step).
  - Renders `top_sponsors[0]` today (the `.map()` is a one-line swap later).
- `useFlashlight(ref)` — extracted to `frontend/src/public/hooks/useFlashlight.ts`.
- `useEntrance(ref, dep)` — extracted to `frontend/src/public/hooks/useEntrance.ts`.
- `CopyAffordance.tsx` — `frontend/src/public/components/CopyAffordance.tsx`.
- `RepForm.tsx` — `frontend/src/public/components/sponsor/RepForm.tsx`.

### Type changes

- `Sponsor` TS interface gains the 9 optional rep fields.
- `CategoryDetailResponse` swap `sponsor` → `top_sponsors: Sponsor[]`.
- `categoryStore` / `api.ts` updates to consume the new shape.

### SCSS

- `CategorySponsorBanner.module.scss` replaced — port of `fixed-banner.css`
  plus the 4 tokens (`--gold`, `--gold-bright`, `--gold-deep`, `--board-1/2/3`,
  `--cream`, `--cream-mut`) from `banner.css :root` into the component's local
  scope (defined on `.fb`, not at `:root`, to stay scoped — global theme
  tokens not affected).

### Admin

- `frontend/src/admin/pages/sponsors/form/index.tsx` — add 9 fields under a new
  collapsible **"Rep contact (category banner)"** section. Empty by default.
- Admin tests not required (no test suite there), but ESLint + tsc must pass.

### Seed

- `api/app/db/seed.py` — populate rep fields on the 2 seeded sponsors so the
  prod-default render isn't blank.

## Out of scope (explicit)

- **Subcategory `SponsorBlock` unification** with the category banner. User
  will request a fresh Claude Design round that merges this v13 with the
  sub-block's current PCB-flashlight pattern. Don't preempt.
- **`/category/ldo-regulators` direct-URL vs `?activeSub=ldo-regulators`
  chip-click divergence.** Known UX inconsistency, user is aware, untouched.
- **Multi-sponsor list rendering.** API shape ready; UI not built. When the
  list ships it's `top_sponsors.map(s => <CategorySponsorBanner sponsor={s} />)`
  plus a layout call (stack vs grid) decided by the next handoff.
- **Mobile pointer/touch interaction polish.** Lamp hidden, click-to-energize
  via tap. No long-press / double-tap behaviors.
- **Updating the design's `<DarkChrome>` / shared `BoardArt`** — those preview
  helpers stay in the handoff; production only ports what the fixed-banner uses.

## Decisions deferred to architect step

1. **Empty state visual** — render `.fb.is-empty` placeholder (always shows
   the banner shell with "Open Sponsorship" copy), or render `null` when
   `top_sponsors` empty so the surface collapses?
2. **CopyAffordance scope** — `@public/components/` today, or
   `@shared/components/` (it's the kind of utility admin may want too).
3. **`top_sponsors` vs `sponsor` field shape** — strict swap (breaking),
   or keep `sponsor` populated with `top_sponsors[0]` for one release as a
   back-compat shim (existing client consumers).
4. **Hook reuse** — does `useFlashlight` end up identical to the one already
   live in `SponsorBlock`? If yes, hoist once. If shape differs (e.g.
   per-element transforms), keep both, document divergence.

## Commit plan

3 commits on `updates`, each atomic:

1. **`feat(sponsor): add rep-contact fields to Sponsor model + API`** —
   migration, model, schemas, category endpoint shape change, new
   `/api/sponsor-rep-request` endpoint, email composer, all tests passing
   incl. TDD gate.
2. **`feat(sponsor): port v9 fixed-banner design to CategorySponsorBanner`** —
   frontend banner rewrite, new hooks, CopyAffordance, RepForm, SCSS.
3. **`feat(admin,sponsor): expose rep-contact fields in admin form + seed`** —
   admin form section, seed data, TS type updates.

Merge `updates` → `master` via ff-only after explicit user ship signal.
`./deploy.sh --reseed` required (new migration + seed changes).

## Acceptance criteria

- `/category/power-management-ics-pmics` renders the v13 banner with TI sponsor
  populated from real DB rep fields (after seed).
- Click any chip → `.is-live` flash + via glow.
- Hover chip cluster → gold flashlight tracks cursor (desktop).
- Click "Copy" on phone/email → clipboard write + ✓ toast.
- Click "Contact rep →" → rail morphs into RepForm; submit creates a
  `Message` row + schedules email + renders `CS-XXXXXX` success card.
- Empty sponsor for a category → nothing renders (or empty-slot per architect
  decision).
- ≤1080px → 1-col + 2-col rail; ≤560px → 1-col rail; bus + stubs hidden ≤1080px.
- Reduced-motion → no entrance, no lamp, no electron motion. Static visible.
- `npx tsc --noEmit` clean; `npx eslint src/` clean; `pytest tests/ -v` passing.
- Admin `/admin/sponsors/:id/edit` shows 9 new rep fields in a collapsible
  section; saves round-trip through API.

---

## Resolved decisions (2026-06-01 architect synthesis)

The architect workflow (3 parallel approaches) reached consensus on most
points and converged on **Pragmatic** with 2 corrections every architect
flagged. Locked-in decisions:

1. **`request_id` format uses `message.seq` (Integer), NOT `message.id` (UUID).**
   The spec originally said `f'CS-{message.id:06X}'` — Python's `:06X` requires
   an integer and `message.id` is `String(36)` UUID. Correct format:
   `f'CS-{message.seq:06X}'`. `message.seq` is the existing Integer unique
   counter used for `MSG-####` designators across the admin UI.
2. **`Message.type` widened from `String(20)` to `String(30)` in migration 011.**
   `'sponsor_rep_request'` is 19 chars — fits with one char of slack. Widening
   is sub-second on a small table and prevents silent truncation of any
   future message kind.
3. **API field swap is a CLEAN BREAK — no shim, no dual field.**
   `CategoryDetailResponse.sponsor` becomes `top_sponsors: list[SponsorResponse]`.
   The only two consumer reads in `frontend/src/public/pages/category/index.tsx`
   (lines 341 + 390) are updated atomically in commit 2. SponsorBlock keeps its
   `sponsor: Sponsor | null` prop — bridged at the call site via
   `sponsor={category.top_sponsors[0] ?? null}`. Zero internal changes to
   SponsorBlock.
4. **Empty state = `return null` + TODO comment + `.fb.is-empty` tokens
   retained in SCSS.** No dedicated `CategorySponsorBannerEmpty` component —
   the investor hasn't designed the open-slot visual yet. One-attribute swap
   away when the design lands.
5. **`CopyAffordance` lives at `@public/components/CopyAffordance.tsx`** with a
   TODO comment for `@shared/` promotion when admin clipboard surfaces emerge.
   Admin has zero clipboard use cases today; preemptive `@shared/` placement
   violates the ≥2-consumer rule.
6. **`useFlashlight` extracted to `@public/hooks/useFlashlight.ts`** — strict
   superset of SponsorBlock's inline version (adds the `(hover: hover) and
   (pointer: fine)` gate). SponsorBlock NOT migrated this round (out of scope);
   TODO comment in SponsorBlock.tsx points to the future unification.
7. **`RepForm` is its own file** at `@public/components/sponsor/RepForm.tsx`
   with paired `.module.scss` — ~90 + 70 LOC, too much to inline.

## Execution order

Three sequential commits on `updates`. Each ends green (`tsc + eslint + pytest`).

### Commit 1 — backend
Order within:
1. Write 3 failing test files (`test_sponsor_rep_request.py`,
   `test_sponsor_rep_fields_metadata.py`, `test_category_top_sponsors_field.py`).
   Run `pytest tests/` — verify they fail for the right reason (ImportError on
   the new module, or schema field absence).
2. Alembic migration 011 (9 cols on `sponsors` + widen `messages.type`).
3. Model edits: `Sponsor` gains 9 cols, `Message.type` column type updated.
4. Schema edits: `SponsorResponse` + `AdminSponsorResponse/Create/Update` gain
   9 Optional fields; `CategoryDetailResponse.sponsor` →
   `top_sponsors: list[SponsorResponse]`.
5. `category_service.get_category_by_slug` returns `top_sponsors` key as a
   list; sponsor_data dict reads the 9 new fields from the Sponsor row.
6. `routes/categories.py` — kwarg rename.
7. `routes/admin_sponsors.py` — `_serialize()` forwards new fields.
8. `routes/sponsors.py` — keyword endpoint forwards new fields (likely null).
9. New `routes/sponsor_rep_requests.py` — POST endpoint.
10. New `email.send_sponsor_rep_notification(sponsor, message)` composer.
11. `main.py` — include the new router.
12. Run `pytest tests/` — all green. Run `ruff format && ruff check`. Commit.

### Commit 2 — frontend banner
Order within:
1. Update `types/sponsor.ts` (8 new optional fields; `contact_name` exists).
2. Update `types/category.ts` (`sponsor` → `top_sponsors`).
3. Update `services/api.ts` (add `submitSponsorRepRequest`).
4. Create `hooks/useFlashlight.ts` + `hooks/useEntrance.ts`.
5. Create `components/CopyAffordance.tsx`.
6. Create `components/sponsor/RepForm.tsx` + paired `.module.scss`.
7. Replace `pages/category/components/CategorySponsorBanner.tsx` contents
   (port of v9 fixed-banner.html + CategorySponsorBanner.jsx Concept A).
8. Replace `pages/category/components/CategorySponsorBanner.module.scss`
   (port of fixed-banner.css).
9. Update `pages/category/index.tsx` — both call sites (prop swap + bridge).
10. `npx tsc --noEmit` clean. `npx eslint src/` clean. Commit.

### Commit 3 — admin + seed + types
Order within:
1. Update `admin/types/admin.ts` — `AdminSponsor` gains 9 optional fields.
2. Update `admin/pages/sponsors/form/index.tsx` — collapsible "Rep contact
   (category banner)" section with 9 inputs, FormState extended, buildSponsor
   forwards rep fields.
3. Update `api/app/db/seed.py` — extend `get_or_create_sponsor` signature,
   populate Kennedy Electronics sponsor with realistic rep fields.
4. `pytest tests/` green. `tsc + eslint` clean. Commit.

### Post-commits
- Visual verification: chrome-devtools-mcp at `/category/power-management-ics-pmics`
  at 1280×800, 932×430, 430×932. Capture screenshots for diff against `fixed-banner.html`.
- CLAUDE.md gets a one-paragraph CSB v13 entry (Gotchas + Patterns).
- Memory persist: project memory updated with v13 ship date + key decisions.
- `master` merge + deploy ONLY on explicit user ship signal.
  `./deploy.sh --reseed` required (migration + seed change).
