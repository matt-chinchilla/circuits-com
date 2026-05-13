# Mobile Responsive Navigation — Spec

**Date:** 2026-05-13
**Branch:** `updates`
**Source design bundle:** `/home/matthew/circuits-com/Circuits.com Design System.zip` →
`design_handoff_mobile_responsive/` (Claude Design, 2026-05-13, README + Navbar.jsx
+ admin app.jsx/ui.jsx/styles.css)
**Status:** Approved 2026-05-13 — ready for plan.

---

## Goal

Add mobile-responsive navigation chrome to both surfaces of Circuits.com so
phones and small tablets are usable end-to-end:

1. **Public site (≤768px)** — hamburger drawer in the 36px sticky `Navbar`.
   The four primary links (Home / About / Join / Contact) move into a
   slide-down full-width drawer; only the LOGIN button + burger remain in the
   strip. Brand mark shrinks; `/ REV-A` suffix hides.
2. **Admin console (≤1024 / ≤820 / ≤420)** — `<aside .side>` flips from a
   sticky 240px grid column to an off-canvas left-side drawer (`width: 280px;
   max-width: 86vw; translateX(-100%) → 0`). Topbar reflows: burger left, search
   moves to its own full-width row, demo-toggle label hides, "New Part" CTA
   becomes icon-only. Content grids collapse to single-column where appropriate;
   data tables get horizontal scroll; toolbars become horizontal-scroll strips.

## Architecture

- **Two separate drawer implementations**, not a shared `<MobileDrawer>`
  component. The website drawer (drops from top, fades scrim, 4 links + footer
  brand) and the admin drawer (slides from left, blurred scrim, full nav tree
  with close X) differ in anatomy, z-index ladder, and styling enough that
  sharing would be over-engineered for two callers.
- **Keep the pinned-edge `.topStrip` pattern.** CLAUDE.md flags `position:
  absolute` brand + nav-right as load-bearing for the Navbar; the design's
  `flex-wrap: wrap` only matters if elements can't fit at the smallest viewport.
  We can fit at 320px by shrinking brand `left: 16px` and adding the burger
  inside `.navRight` (already absolutely positioned `right: 20px → 16px`).
- **Drawer state machine identical on both surfaces:** `Esc` closes, `body.style
  .overflow = 'hidden'` while open (cleanup on unmount/close), route change
  closes, scrim click closes, drawer link click closes-then-navigates. Three
  `useEffect` hooks per component, keyed on `menuOpen` + the active path.
- **`prefers-reduced-motion` respect (a11y addition).** Wraps drawer/scrim
  transitions in `@media (prefers-reduced-motion: no-preference)` so the
  drawer appears/disappears instantly for motion-sensitive users.

## Tech Stack

React 19 + TypeScript + Vite + SCSS Modules + Framer Motion 12 +
`lucide-react` (add `Menu` icon to admin). No new dependencies.

---

## Scope

### In scope

| Surface | Change |
|---|---|
| `frontend/src/shared/styles/_variables.scss` | Append 2 new `$bp-admin-mobile: 820px` and `$bp-admin-compact: 420px` vars. Reuse existing `$bp-mobile: 768px` (website hamburger threshold — user explicitly preferred standard 768) and `$bp-tablet: 1024px` (admin first-collapse). |
| `frontend/src/public/components/layout/Navbar.tsx` | Add `menuOpen` state + 3 `useEffect`s + burger button + drawer markup + scrim div |
| `frontend/src/public/components/layout/Navbar.module.scss` | Add `.navBurger`, `.navMobileScrim`, `.navMobileDrawer`, `.navMobileList`, `.navMobileLink`, `.navMobileArrow`, `.navMobileFoot` + `@media (max-width: 768px)` (= `$bp-mobile`) block (per-theme drawer bg via `[data-theme]`) |
| `frontend/src/admin/components/AdminLayout.tsx` | Add `menuOpen` state + 3 effects, import `Menu` from lucide, render topbar burger (left of `.pageTitle`), side-close X (inside `<aside>`), scrim div |
| `frontend/src/admin/components/AdminLayout.module.scss` | Add `.topbarBurger`, `.sideClose`, `.sideScrim` + 3 media blocks (1024 / 820 / 420) — apply on `.admin`, `.side`, `.topbar`, `.topbarMid`, `.demoLabel`, `.demoState`, `.content`, etc. |
| Per-page admin SCSS (Dashboard, Suppliers list, Parts list, Reports, Messages, Settings, Import) | Add `@media` rules per design's content-collapse spec (grids → 1 col, tables → h-scroll wrapper, toolbars → h-scroll strips, kv-list → 1 col, ring stacks above legend, toast full-width-bottom) |
| Existing public pages | **Only** if I find obvious layout bugs during the verification screenshots (per "Bundle + small fixes" scope decision). No redesigns, no refactors. |

### Out of scope

- New design tokens (forbidden by README — every value already exists)
- Normalizing the 32 existing inconsistent media queries onto the official
  breakpoints. Tracked as separate follow-up.
- Mobile-card variant for `.a-table` (data tables retain density via h-scroll
  per design — explicit caveat in README)
- Reintroducing a charting library — `ReportsPage` keeps its native-SVG charts
- Phase 4 backend Message persistence (separate spec, separate cycle)
- Mobile redesign of `/category`, `/search`, `/part/:id`, `/keyword`,
  `/admin/login` — none of these are mentioned in the design bundle. Touched
  only if drawers break them during verification.

---

## Behavior Contract

### Drawer state machine

| Trigger | Action |
|---|---|
| Tap `.navBurger` / `.topbarBurger` | Toggle `menuOpen` |
| Tap close X inside admin drawer | Set `menuOpen = false` |
| Tap scrim | Set `menuOpen = false` |
| Press `Escape` (any active element) | Set `menuOpen = false` if open |
| Route change (`useLocation().pathname`) | Set `menuOpen = false` |
| Drawer link click (`onClick`) | Set `menuOpen = false`, then `<NavLink>` handles navigation in same tick |

### Body scroll lock (both surfaces)

```typescript
useEffect(() => {
  if (!menuOpen) return undefined;
  const prev = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  return () => { document.body.style.overflow = prev; };
}, [menuOpen]);
```

The cleanup runs on close AND on unmount, restoring whatever the previous
value was (usually empty string).

### Esc handler (both surfaces)

```typescript
useEffect(() => {
  if (!menuOpen) return undefined;
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [menuOpen]);
```

Listener only attached while drawer is open (no idle keydown handler).

### Route-change close (both surfaces)

```typescript
useEffect(() => { setMenuOpen(false); }, [location.pathname]);
```

Uses `useLocation()` from `react-router-dom`.

### Burger → X morph (website only — admin uses Lucide `Menu` icon, no morph)

```scss
.navBurger.isOpen {
  .navBurgerLine:nth-child(1) { transform: translateY(7px)  rotate(45deg); }
  .navBurgerLine:nth-child(2) { opacity: 0; }
  .navBurgerLine:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
}
.navBurgerLine { transition: transform 220ms ease, opacity 180ms ease; }
```

`prefers-reduced-motion: reduce` overrides to `transition: none`.

---

## Design tokens added

```scss
// frontend/src/shared/styles/_variables.scss — append under existing Breakpoints
$bp-admin-mobile:   820px; // admin sidebar→drawer, topbar reflow, table h-scroll
$bp-admin-compact:  420px; // admin further compaction (KPI 1-col, demo-state text hides)
```

Existing vars reused (no new alias needed):
- `$bp-mobile: 768px` — website hamburger threshold (design said 760; user
  preferred standard 768, so we use the existing var — no 8px dead zone since
  `.navLinks` already hides at this exact threshold).
- `$bp-tablet: 1024px` — admin first-collapse (stat panels, supplier grid 3→2).

No other tokens added. All colors, shadows, radii, font sizes, z-indices come
from existing `--theme-*` and `--a-*` CSS custom properties (see
`_themes.scss`, admin's `_variables.scss`).

### Z-index ladder (already established in design)

- Admin scrim: 50, admin drawer: 60, admin topbar: 10
- Website scrim: 90, website drawer: 95, website navbar: 100

### Mobile spacing (per design)

- Admin mobile content padding: `16px 14px 40px`
- Website drawer link min-height: 52px (tap target)
- Website drawer link padding: `16px 24px`
- Burger button: 36×36, 1px `rgba(255,255,255,.18)` border, 5px radius (website) / 6px radius (admin topbar burger)

### Per-theme drawer styling (website)

- base/steel: `var(--theme-nav-bg)` solid; Inter 500 1rem `var(--theme-nav-text)`
- pcb: silkscreen-grid background; JetBrains Mono 0.82rem uppercase letter-spacing 0.14em
- schematic: gradient overlay from existing token

Footer row in drawer: wordmark + copper-tinted "REV-A" tag.

---

## Verification matrix (TDD gate)

Implementation is incomplete until every cell below passes. Captured as the
"failing test set" before implementation begins — flips green per cell.

### Public site

| Page | 375px (iPhone SE) | 430px (iPhone 15 Pro Max) | 768px boundary | 4 themes at 430px |
|---|---|---|---|---|
| `/` | drawer opens/closes, hero adapts | drawer + hero | desktop ↔ mobile flip | base / steel / schematic / pcb |
| `/about` | drawer + page legible | drawer + page legible | drawer flip | all themes |
| `/join` | drawer + form fields usable | drawer + form | drawer flip | all themes |
| `/contact` | drawer + datasheet U1/U2 cards stack | drawer + cards | drawer flip | all themes |
| `/privacy` (= `/terms`) | drawer + TOC stacks under doc | drawer + TOC stack | drawer flip | all themes |

### Admin

| Page | 375px | 430px | 820px boundary | 1024px boundary |
|---|---|---|---|---|
| `/admin` (dashboard) | drawer + stats 1-col + ring stacked | drawer + stats 1-col | sidebar ↔ drawer flip | charts grid → 1 col |
| `/admin/suppliers` | drawer + table h-scrolls + filter chips h-scroll | same | drawer flip | sup-grid 3→2 cols |
| `/admin/parts` | drawer + table h-scrolls + a-toolbar h-scrolls | same | drawer flip | n/a |
| `/admin/parts/new` | drawer + form 1-col + checkbox-grid 1-col | same | drawer flip | n/a |
| `/admin/messages` | drawer + msg-toolbar chips h-scroll | same | drawer flip | n/a |
| `/admin/settings` | drawer + settings-side tabs h-scroll | same | drawer flip | n/a |

### Universal (across all pages)

- [ ] Esc key closes drawer (test from any focused element)
- [ ] Body scroll locked while drawer open (test `body.style.overflow === 'hidden'`)
- [ ] Body scroll restored on close (test cleanup runs)
- [ ] Scrim click closes drawer
- [ ] Route change auto-closes drawer (open drawer, click link, drawer closed at new route)
- [ ] Burger morphs to X on open (220ms transition observed in DevTools)
- [ ] `prefers-reduced-motion: reduce` disables drawer transitions (test via DevTools emulation)
- [ ] No body-scroll-leak: open drawer, close, scroll body, still works
- [ ] No keyboard trap inside drawer (Tab moves focus through drawer links + close X, Shift+Tab reverses)
- [ ] `aria-expanded` updates on burger; `aria-hidden` updates on drawer wrapper

### Performance + a11y gates

- [ ] Lighthouse a11y ≥ 95 at 430px on `/` and `/admin/login`
- [ ] No layout dead-zone at the 768→1024 range (`.navLinks` hides at 768, hamburger appears at 768 — same threshold ✓)
- [ ] No new long-animation-frame warnings in DevTools performance trace (mobile emulation, 4× CPU throttle) during drawer open/close
- [ ] All drawer tap targets ≥ 44×44 (52px-min per design — pass)
- [ ] `tsc --noEmit` clean
- [ ] `eslint src/` clean (zero new errors)

---

## Risk register

| Risk | Mitigation |
|---|---|
| Existing `.topStrip` `position: absolute` pinned pattern conflicts with design's `flex-wrap: wrap` mobile rule | Keep pinned pattern; verify visually at 320px that brand + login + burger all fit. Fall back to flex-wrap only if needed. |
| Body scroll lock leaks if useEffect cleanup doesn't fire (e.g., navigation interrupts during transition) | Cleanup runs on `menuOpen` change AND component unmount. Verified pattern (matches AdminLayout's `SignOutModal`). |
| chrome-devtools-mcp tab accumulation (CLAUDE.md gotcha) | Use single page + `navigate_page` cycle for the verification matrix, not `new_page` per cell. |
| Lucide `Menu` icon weight inconsistency with existing 18px Lucide icons in admin | Use same `size={18} strokeWidth={2}` props as existing icons in `AdminLayout.tsx` |
| Bundle hash drift after adding mobile CSS will produce different Vite hashes (`index-XXX.js`) | Expected per CLAUDE.md gotcha. Verify with `git diff` — pure-additive changes shouldn't break anything else. |
| Squash-merge phantom conflicts when later merging `updates → master` | Already mitigated by syncing `updates` to master at start of cycle. New work will FF cleanly. |
| Reintroducing dev-only fallback in prod (theme picker pattern) | All new code is unconditional — no `import.meta.env.DEV` gating needed for the drawer (it's always present, just hidden via media query above 760px) |

---

## Process

Per `dev-workflows:make-new` pipeline:

1. ✅ **Step 0:** Classify → `[web]`
2. ✅ **Step 1:** Brainstorm + design (this doc)
3. ⏭️ **Step 2:** Skip explore-codebase agents — file map already complete from manual inspection
4. ⏭️ **Step 3:** Skip parallel-architect agents — README is the architecture document; no meaningful trade-offs to A/B/C
5. ▶️ **Step 4:** Write plan via `superpowers:writing-plans` — `docs/superpowers/plans/2026-05-13-mobile-responsive-nav.md`
6. ✅ **Step 5:** Branch isolation — already on `updates` (synced to master)
7. ▶️ **Step 6:** Capture verification matrix above as the "failing test set" before implementation
8. ▶️ **Step 7:** Inline execution via `superpowers:executing-plans` (5-7 bite-sized tasks, single-session — small enough that subagent-driven adds overhead)
9. ▶️ **Step 8:** Frontend polish — chrome-devtools-mcp screenshot matrix at 375/430/760/820/1024 × all themes
10. ▶️ **Step 9:** `/simplify` — 3 parallel agents (code-reuse, quality, efficiency) + `pr-review-toolkit:code-simplifier`
11. ▶️ **Step 10:** Route gates — `web` route only; CLAUDE.md SCSS gotcha grep via the existing `scss-lint.sh` PostToolUse hook
12. ▶️ **Step 11:** `/verification-before-completion` — full verification matrix + tsc + eslint + lighthouse a11y
13. ▶️ **Step 12:** `/code-review:code-review` + parallel `pr-review-toolkit:silent-failure-hunter` + `pr-review-toolkit:type-design-analyzer`
14. ▶️ **Step 12.5:** `/superpowers:dispatching-parallel-agents` final immaculate validation — 6-agent team: visual-regression-guard, theme-persistency-guard, frontend-perf-auditor, chrome-devtools-mcp a11y, silent-failure-hunter (re-run), seo-auditor
15. ▶️ **Step 13:** Commit to `updates`, push to `origin/updates`. **STOP. Do NOT merge to master without user go-ahead.**
16. ▶️ **Step 14:** After user approves merge, update CLAUDE.md via `claude-md-management:claude-md-improver`

---

## File map (final)

```
frontend/src/
├── shared/styles/
│   └── _variables.scss                                  [+4 lines: 4 new $bp- vars]
├── public/components/layout/
│   ├── Navbar.tsx                                       [+menuOpen state, 3 effects, burger button, drawer markup, scrim]
│   └── Navbar.module.scss                               [+drawer classes, +@media (max-width: 760px) block]
└── admin/components/
    ├── AdminLayout.tsx                                  [+menuOpen state, 3 effects, Menu icon import, burger button, close X, scrim div]
    └── AdminLayout.module.scss                          [+.topbarBurger, +.sideClose, +.sideScrim, +3 @media blocks (1024/820/420)]
```

Per-page admin SCSS files touched as needed (final list determined during
implementation — depends on which page classes need media rules vs. inheriting
from AdminLayout):

```
frontend/src/admin/pages/
├── dashboard/DashboardPage.module.scss                  [.stats, .charts-grid, .ring-wrap → 1 col at ≤820, KPI rows at ≤420]
├── suppliers/list/SuppliersListPage.module.scss         [.sup-grid 3→2 at ≤1024, →1 at ≤820, table h-scroll]
├── parts/list/PartsListPage.module.scss                 [table h-scroll, .a-toolbar h-scroll strip]
├── parts/form/PartFormPage.module.scss                  [.form-row-2 → 1 col, .checkbox-grid → 1 col at ≤820]
├── reports/ReportsPage.module.scss                      [.rep-kpi-row, .review-stats → 2 col @≤820, → 1 col @≤420]
├── messages/list/MessagesListPage.module.scss           [.msg-toolbar chips h-scroll, .msg-table h-scroll]
├── settings/SettingsPage.module.scss                    [.settings-side tabs h-scroll]
└── import/ImportPage.module.scss                        [.map-table h-scroll, .checkbox-grid → 1 col]
```

---

## Acceptance criteria (binary, observable)

- Open `/` at 375px in any browser → see hamburger button in nav strip, no
  visible nav links inline
- Tap hamburger → drawer slides down with 4 links + LOGIN row + footer brand,
  scrim fades in below
- Tap scrim → drawer closes, scrim fades out
- Tap drawer link → drawer closes, page navigates
- Resize viewport to 800px → hamburger disappears, inline nav links return
- Open `/admin/suppliers` at 375px (after login) → sidebar hidden, hamburger in
  topbar, search row spans full width below title
- Tap hamburger → sidebar slides in from left with scrim+blur
- Open `/admin/parts/new` at 375px → form fields stack 1 column, no horizontal
  scroll on body
- Repeat all of the above in all 4 themes (public site only — admin is
  un-themed)
- Lighthouse mobile a11y ≥ 95 on `/` and `/admin/login`
