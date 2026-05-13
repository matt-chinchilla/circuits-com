# Mobile Responsive Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Claude Design 2026-05-13 mobile-nav bundle: a hamburger drawer for the public Navbar (≤768px — standard mobile breakpoint, user-preferred over the design's 760) and an off-canvas sidebar drawer + reflowing topbar + content collapse for the admin console (≤1024 / ≤820 / ≤420px), with full theme + viewport verification.

**Architecture:** Two separate drawer implementations (not a shared component) — different anatomy, z-index ladder, scrim styling. Both share an identical state machine: `Esc`/scrim/route-change/link-click all close; body scroll lock with cleanup; `prefers-reduced-motion: reduce` respected. The public Navbar keeps its pinned-edge `position: absolute` pattern at mobile widths.

**Tech Stack:** React 19 + TypeScript + Vite + SCSS Modules + `lucide-react` (existing) + `react-router-dom` (existing `useLocation`).

**Branch:** `updates` (synced to master at `64e482c` + spec commit `d05be3b`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/shared/styles/_variables.scss` | Modify (+2 lines) | Append 2 new `$bp-admin-mobile: 820px` and `$bp-admin-compact: 420px` vars. Reuse existing `$bp-mobile: 768px` and `$bp-tablet: 1024px` for the website-hamburger and admin-first-collapse thresholds. |
| `frontend/src/public/components/layout/Navbar.tsx` | Modify | Add `menuOpen` state + 3 useEffects + burger button + drawer markup + scrim |
| `frontend/src/public/components/layout/Navbar.module.scss` | Modify | Align `.navLinks` hide to 760, add `.navBurger`, `.navBurgerLine`, `.navMobileScrim`, `.navMobileDrawer`, `.navMobileList`, `.navMobileLink`, `.navMobileArrow`, `.navMobileFoot` + `@media (max-width: 760px)` block + per-theme drawer styling |
| `frontend/src/admin/components/AdminLayout.tsx` | Modify | Add `menuOpen` state + 3 effects, import `Menu` from lucide, render `.topbarBurger`, `.sideClose`, `.sideScrim` |
| `frontend/src/admin/components/AdminLayout.module.scss` | Modify | Add `.topbarBurger`, `.sideClose`, `.sideScrim`, `.isOpen` modifier on `.side` + `@media` blocks at 1024 / 820 / 420 |
| Per-page admin SCSS (8 files) | Modify | Per-page content reflow rules — collapse grids, h-scroll tables/toolbars (see Task 7 for exact list) |

---

## Task 1: Add 2 mobile breakpoint variables

**Files:**
- Modify: `frontend/src/shared/styles/_variables.scss` (append to Breakpoints block)

- [ ] **Step 1: Read current `_variables.scss` to confirm the Breakpoints block location**

```bash
grep -n "Breakpoints" /home/matthew/circuits-com/frontend/src/shared/styles/_variables.scss
```
Expected: `// Breakpoints` near line 25, followed by `$bp-mobile: 768px;`, `$bp-tablet: 1024px;`, `$bp-desktop: 1199px;`.

- [ ] **Step 2: Append 2 new vars under the existing Breakpoints comment**

Insert immediately after the line `$bp-desktop: 1199px;`:

```scss
// Admin-specific mobile breakpoints (2026-05-13 Claude Design bundle).
// 820 is the admin sidebar->drawer flip; 420 is the admin further-
// compaction tier (KPI rows 1-col, demo-state text hides). The website
// hamburger threshold uses the existing $bp-mobile (768) and the admin
// first-collapse tier uses the existing $bp-tablet (1024) - no new vars
// needed for those.
$bp-admin-mobile:   820px;
$bp-admin-compact:  420px;
```

- [ ] **Step 3: Verify TypeScript still compiles (no .ts changes but SCSS edits trigger frontend-rebuild hook)**

Run: `cd /home/matthew/circuits-com/frontend && npx tsc --noEmit`
Expected: Exit 0, no errors.

- [ ] **Step 4: Verify the SCSS file parses (no syntax errors)**

Run: `cd /home/matthew/circuits-com/frontend && npx sass --quiet-deps src/shared/styles/_variables.scss /tmp/vars-check.css 2>&1 | head -5`
Expected: No error output. Then `rm /tmp/vars-check.css`.

- [ ] **Step 5: Commit**

```bash
cd /home/matthew/circuits-com && git add frontend/src/shared/styles/_variables.scss && git commit -m "feat(scss): add 4 mobile breakpoint vars for 2026-05-13 design"
```

---

## Task 2: Public Navbar — SCSS scaffolding (drawer/scrim/burger classes, no behavior wiring yet)

**Files:**
- Modify: `frontend/src/public/components/layout/Navbar.module.scss` (append drawer classes + media block; existing `.navLinks` hide-rule at `$bp-mobile` aligns to our hamburger breakpoint, no change needed)

- [ ] **Step 1: Confirm existing `.navLinks` hide-rule uses `$bp-mobile` (768) — no edit needed**

```bash
grep -n "navLinks" /home/matthew/circuits-com/frontend/src/public/components/layout/Navbar.module.scss | head -5
```
Expected: `.navLinks` block contains `@include responsive($bp-mobile) { display: none }` — this is our hamburger trigger threshold, so nav-links hide and burger appears at the same 768px breakpoint (no dead zone).

- [ ] **Step 2: Append burger button classes at the end of the file**

Add after the last existing rule (after the `:global([data-theme="steel"]) .loginBtn:hover` block):

```scss
// ─── Mobile drawer trigger (hamburger) ────────────────────────────────────
// Hidden by default (desktop layout shows inline nav links); flips to
// inline-flex inside the @media (max-width: $bp-mobile) block.

.navBurger {
  display: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 5px;
  cursor: pointer;
  flex-direction: column;
  gap: 5px;
  transition: background-color $transition-fast, border-color $transition-fast;

  &:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.32);
  }

  &:focus-visible {
    outline: 2px solid var(--theme-accent);
    outline-offset: 2px;
  }
}

.navBurgerLine {
  display: block;
  width: 18px;
  height: 2px;
  background: var(--theme-nav-text, #fff);
  border-radius: 1px;
  transition: transform 220ms ease, opacity 180ms ease;
}

// Burger morphs to X when the drawer is open.
.navBurger.isOpen .navBurgerLine:nth-child(1) {
  transform: translateY(7px) rotate(45deg);
}
.navBurger.isOpen .navBurgerLine:nth-child(2) {
  opacity: 0;
}
.navBurger.isOpen .navBurgerLine:nth-child(3) {
  transform: translateY(-7px) rotate(-45deg);
}

// Reduced-motion users get instant morph (no twist animation).
@media (prefers-reduced-motion: reduce) {
  .navBurgerLine {
    transition: none;
  }
}
```

- [ ] **Step 3: Append scrim + drawer classes**

Add immediately after the burger CSS:

```scss
// ─── Mobile drawer scrim ──────────────────────────────────────────────────
// Fixed below the nav strip (so the strip stays clickable to dismiss).
// Click anywhere on the scrim to close the drawer.

.navMobileScrim {
  display: none;
  position: fixed;
  inset: $nav-height 0 0 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 90;
  opacity: 0;
  pointer-events: none;
  transition: opacity 220ms ease;
}

.navMobileScrim.isOpen {
  opacity: 1;
  pointer-events: auto;
}

@media (prefers-reduced-motion: reduce) {
  .navMobileScrim {
    transition: none;
  }
}

// ─── Mobile drawer ────────────────────────────────────────────────────────
// Drops from below the sticky strip. Full width, scrollable, themed.

.navMobileDrawer {
  display: none;
  position: fixed;
  top: $nav-height;
  left: 0;
  right: 0;
  max-height: calc(100vh - #{$nav-height});
  overflow-y: auto;
  z-index: 95;
  background: var(--theme-nav-bg);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  transform: translateY(-100%);
  opacity: 0;
  pointer-events: none;
  transition: transform 220ms ease, opacity 220ms ease;
}

.navMobileDrawer.isOpen {
  transform: translateY(0);
  opacity: 1;
  pointer-events: auto;
}

@media (prefers-reduced-motion: reduce) {
  .navMobileDrawer {
    transition: none;
  }
}

// Per-theme drawer surface treatments (inherit from .topStrip's textures
// where applicable, simplified for the drawer's larger surface).

:global([data-theme="steel"]) .navMobileDrawer {
  background-image: linear-gradient(180deg, rgba(255, 255, 255, 0.04) 0%, rgba(255, 255, 255, 0) 60%);
  background-color: var(--theme-nav-bg);
}

:global([data-theme="pcb"]) .navMobileDrawer {
  background-image:
    repeating-linear-gradient(0deg, transparent 0 23px, rgba(255, 255, 255, 0.025) 23px 24px),
    repeating-linear-gradient(90deg, transparent 0 23px, rgba(255, 255, 255, 0.025) 23px 24px);
  background-color: var(--theme-nav-bg);
}

.navMobileList {
  list-style: none;
  margin: 0;
  padding: 8px 0;
}

.navMobileLink {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 16px 24px;
  font-family: $font-body;
  font-weight: 500;
  font-size: 1rem;
  color: var(--theme-nav-text);
  text-decoration: none;
  cursor: pointer;
  transition: background-color $transition-fast, color $transition-fast;

  &:hover,
  &:active {
    background: rgba(255, 255, 255, 0.06);
    color: var(--theme-nav-text-hover);
  }

  &.active {
    background: rgba(255, 255, 255, 0.08);
    font-weight: 600;
    color: var(--theme-nav-text-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--theme-accent);
    outline-offset: -2px;
  }
}

:global([data-theme="pcb"]) .navMobileLink {
  font-family: $font-mono;
  font-size: 0.82rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.navMobileArrow {
  font-size: 1.4rem;
  line-height: 1;
  color: var(--theme-accent, rgba(255, 255, 255, 0.55));
  font-weight: 400;
}

.navMobileFoot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 16px 24px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.navMobileFootBrand {
  font-family: $font-body;
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--theme-nav-text);
}

.navMobileFootRev {
  font-family: $font-mono;
  font-size: 0.7rem;
  letter-spacing: 0.14em;
  color: var(--theme-accent, rgba(255, 255, 255, 0.55));
}
```

- [ ] **Step 4: Append the activation @media block**

Add at the very end of the file:

```scss
// ─── Mobile activation (<=768px) ──────────────────────────────────────────
// Burger + scrim + drawer become visible. Brand shrinks. Nav-right offset
// pulls in 12px so brand + login + burger fit on a 320px-wide viewport.

@media (max-width: $bp-mobile) {
  .topStrip {
    min-height: 48px;
  }

  .brand {
    left: 16px;
    font-size: 0.95rem;
  }

  // Hide the PCB / REV-A suffix on mobile (per design — too much chrome).
  :global([data-theme="pcb"]) .brandSuffix {
    display: none;
  }

  .navRight {
    right: 16px;
    gap: 8px;
  }

  .loginBtn {
    padding: 6px 14px;
    font-size: 0.7rem;
  }

  :global([data-theme="pcb"]) .loginBtn {
    padding: 6px 12px;
    font-size: 0.65rem;
  }

  .navBurger {
    display: inline-flex;
  }

  .navMobileScrim {
    display: block;
  }

  .navMobileDrawer {
    display: block;
  }
}
```

- [ ] **Step 5: Verify SCSS compiles cleanly**

Run: `cd /home/matthew/circuits-com/frontend && npx sass --quiet-deps src/public/components/layout/Navbar.module.scss /tmp/nav-check.css 2>&1 | head -5`
Expected: No error output. Then `rm /tmp/nav-check.css`.

- [ ] **Step 6: Commit (scaffolding only — TSX wiring follows in Task 3)**

```bash
cd /home/matthew/circuits-com && git add frontend/src/public/components/layout/Navbar.module.scss && git commit -m "feat(navbar): add SCSS scaffolding for mobile drawer"
```

---

## Task 3: Public Navbar — wire up state machine + drawer markup

**Files:**
- Modify: `frontend/src/public/components/layout/Navbar.tsx`

- [ ] **Step 1: Replace the entire file with the wired-up version**

Replace contents of `frontend/src/public/components/layout/Navbar.tsx`:

```tsx
import { useState, useEffect } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import SearchBar from "./SearchBar";
import styles from "./Navbar.module.scss";

const NAV_LINKS = [
  { to: "/", label: "Home" },
  { to: "/about", label: "About" },
  { to: "/join", label: "Join" },
  { to: "/contact", label: "Contact" },
];

const linkClassName = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.navLink} ${styles.active}` : styles.navLink;

const drawerLinkClassName = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.navMobileLink} ${styles.active}` : styles.navMobileLink;

export default function Navbar() {
  const location = useLocation();
  const isHome = location.pathname === "/";
  const [menuOpen, setMenuOpen] = useState(false);

  // Route change auto-closes the drawer.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Body scroll lock while drawer is open. Cleanup restores prev value.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  // Esc key closes drawer. Listener only attached while open.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const burgerClass = menuOpen
    ? `${styles.navBurger} ${styles.isOpen}`
    : styles.navBurger;
  const scrimClass = menuOpen
    ? `${styles.navMobileScrim} ${styles.isOpen}`
    : styles.navMobileScrim;
  const drawerClass = menuOpen
    ? `${styles.navMobileDrawer} ${styles.isOpen}`
    : styles.navMobileDrawer;

  return (
    <header className={styles.header}>
      <div className={styles.topStrip}>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandDot} aria-hidden="true" />
          <span className={styles.brandSquare} aria-hidden="true" />
          Circuits.com
          <span className={styles.brandSuffix} aria-hidden="true">
            / REV-A
          </span>
        </Link>
        {!isHome && (
          <div className={styles.navSearch}>
            <SearchBar variant="nav" />
          </div>
        )}
        <div className={styles.navRight}>
          <nav className={styles.navLinks} aria-label="Main navigation">
            {NAV_LINKS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={linkClassName}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <Link to="/admin/login" className={styles.loginBtn}>
            LOGIN
          </Link>
          <button
            type="button"
            className={burgerClass}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="nav-mobile-drawer"
          >
            <span className={styles.navBurgerLine} aria-hidden="true" />
            <span className={styles.navBurgerLine} aria-hidden="true" />
            <span className={styles.navBurgerLine} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        className={scrimClass}
        onClick={() => setMenuOpen(false)}
        aria-hidden="true"
      />
      <nav
        id="nav-mobile-drawer"
        className={drawerClass}
        aria-label="Mobile navigation"
        aria-hidden={!menuOpen}
      >
        <ul className={styles.navMobileList}>
          {NAV_LINKS.map(({ to, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === "/"}
                className={drawerLinkClassName}
                onClick={() => setMenuOpen(false)}
                tabIndex={menuOpen ? 0 : -1}
              >
                <span>{label}</span>
                <span className={styles.navMobileArrow} aria-hidden="true">
                  ›
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className={styles.navMobileFoot}>
          <span className={styles.navMobileFootBrand}>Circuits.com</span>
          <span className={styles.navMobileFootRev}>REV-A</span>
        </div>
      </nav>
    </header>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/matthew/circuits-com/frontend && npx tsc --noEmit`
Expected: Exit 0, no errors.

- [ ] **Step 3: Force-rebuild frontend (the auto-rebuild hook may have coalesced edits)**

```bash
cd /home/matthew/circuits-com && docker compose up -d --build frontend
```

Wait for "Container circuits-com-frontend-1  Started" output.

- [ ] **Step 4: Manual smoke-test at 375px in your browser**

Open `http://localhost/` in a private window, DevTools → Toggle device toolbar → iPhone SE (375×667). Verify:
- Hamburger button visible in nav strip (top-right)
- Tapping it opens drawer with Home/About/Join/Contact rows + Circuits.com / REV-A footer
- Tapping a drawer link navigates AND closes drawer
- Escape key closes drawer
- Tapping the scrim (dark area below drawer) closes drawer

- [ ] **Step 5: Commit**

```bash
cd /home/matthew/circuits-com && git add frontend/src/public/components/layout/Navbar.tsx && git commit -m "feat(navbar): wire up mobile drawer state machine"
```

---

## Task 4: Verify public Navbar drawer across viewports + themes

**Files:**
- None modified — verification only.

- [ ] **Step 1: Open localhost in chrome-devtools-mcp**

Use the `new_page` tool to open `http://localhost/?nav=A` (base theme).
Use `emulate` to set viewport to iPhone SE (375×667) with mobile user agent.

- [ ] **Step 2: Screenshot the drawer states across breakpoint matrix**

For each combination below, take screenshots via `take_screenshot`:
- 375×667 base (closed), 375×667 base (open via JS click on burger)
- 430×932 base (closed), 430×932 base (open)
- 768×800 base (boundary — drawer should still be visible at exactly 768)
- 769×800 base (boundary — drawer should already be HIDDEN, inline links return)

- [ ] **Step 3: Screenshot all 4 themes at 430×932**

Navigate to `/?nav=A`, `/?nav=B`, `/?nav=C`, `/` (base default), each at 430×932 with menuOpen=true (use `evaluate_script` to click the burger). Verify:
- Steel: drawer bg shows steel gradient overlay
- Schematic: green nav, pinstripe pattern
- PCB: silkscreen-grid background, JetBrains Mono uppercase link text
- Base: clean white-on-blue solid

- [ ] **Step 4: Test state machine behaviors**

At 375×667 on `/`:
- `evaluate_script` to verify `document.body.style.overflow === "hidden"` after burger click
- Press Escape → verify `document.body.style.overflow === ""` (or original)
- Click burger → drawer opens. Click a NavLink → drawer closes AND URL changes
- Switch to `/about` directly → verify drawer is closed on landing (route-change effect)

- [ ] **Step 5: Lighthouse accessibility audit at 430px on `/`**

Run `lighthouse_audit` with category `accessibility`, mode `navigation`. Verify score ≥ 95. If anything fails, capture the failure list and address in the verification fix step.

- [ ] **Step 6: Quick visual check at 375px on inner pages**

Navigate to `/about`, `/join`, `/contact`, `/privacy` at 375×667. Verify:
- Drawer opens correctly from each page
- No major layout overflow (horizontal scroll on body)
- Hero/band area still renders at top
- If something is obviously broken (overflow, text clipping), note it for Task 8 (mobile-fix pass)

---

## Task 5: Admin Layout — SCSS scaffolding (drawer/scrim/burger classes + 3 media blocks)

**Files:**
- Modify: `frontend/src/admin/components/AdminLayout.module.scss`

- [ ] **Step 1: Read the current AdminLayout.module.scss to confirm existing class structure**

```bash
grep -n -E "^\.(admin|side|topbar|content|main)\b" /home/matthew/circuits-com/frontend/src/admin/components/AdminLayout.module.scss | head -20
```

Expected: classes for `.admin` (grid), `.side` (aside), `.topbar`, `.main`, `.content`, etc.

- [ ] **Step 2: Append the topbar burger, side close, and scrim base classes**

Add at the END of the file (these are display-none by default; activated by media block in Step 4):

```scss
// ─── Mobile chrome (2026-05-13 design bundle) ─────────────────────────────
// Topbar hamburger (shown <=820px), side-close X (inside .side when open),
// and the dimming scrim that fades over the content while drawer is open.
// All three are display: none by default and activated inside the
// @media (max-width: $bp-admin-mobile) block below.

.topbarBurger {
  display: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: transparent;
  border: 1px solid var(--a-border);
  border-radius: 6px;
  color: var(--a-fg1);
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color $transition-fast, color $transition-fast, border-color $transition-fast;

  &:hover {
    background: var(--a-border-soft);
    color: var(--a-primary);
    border-color: var(--a-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--a-primary);
    outline-offset: 2px;
  }

  svg {
    width: 18px;
    height: 18px;
    stroke-width: 2;
  }
}

.sideClose {
  display: none;
  position: absolute;
  top: 14px;
  right: 12px;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  border: 1px solid var(--a-border);
  border-radius: 6px;
  color: var(--a-fg2);
  cursor: pointer;
  transition: background-color $transition-fast, color $transition-fast;

  &:hover {
    background: var(--a-border-soft);
    color: var(--a-fg1);
  }

  &:focus-visible {
    outline: 2px solid var(--a-primary);
    outline-offset: 2px;
  }

  svg {
    width: 16px;
    height: 16px;
    stroke-width: 2;
  }
}

.sideScrim {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(15, 20, 25, 0.5);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  z-index: 50;
  opacity: 0;
  pointer-events: none;
  transition: opacity 220ms ease;
}

.sideScrim.isOpen {
  opacity: 1;
  pointer-events: auto;
}

@media (prefers-reduced-motion: reduce) {
  .sideScrim {
    transition: none;
  }
}
```

- [ ] **Step 3: Append the tablet breakpoint (≤1024) block**

```scss
// ─── Admin tablet (<=1024px) ──────────────────────────────────────────────
// Topbar gap/padding tightens; multi-column dashboard/grids that should
// reflow first land in per-page SCSS (Task 7).

@media (max-width: $bp-tablet) {
  .topbar {
    gap: 10px;
    padding-inline: 16px;
  }

  .topbarMid {
    margin-left: 8px;
  }
}
```

- [ ] **Step 4: Append the admin mobile breakpoint (≤820) block — the BIG one**

```scss
// ─── Admin mobile (<=820px) ───────────────────────────────────────────────
// Sidebar flips to off-canvas. Topbar reflows. Content padding tightens.

@media (max-width: $bp-admin-mobile) {
  .admin {
    display: block; // was grid: 240px 1fr
  }

  .side {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 280px;
    max-width: 86vw;
    transform: translateX(-100%);
    transition: transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1);
    z-index: 60;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
    padding-top: 56px; // room for close X
  }

  .side.isOpen {
    transform: translateX(0);
  }

  @media (prefers-reduced-motion: reduce) {
    .side {
      transition: none;
    }
  }

  .sideClose {
    display: inline-flex;
  }

  .sideScrim {
    display: block;
  }

  // Topbar reflows. Wraps so search drops to its own row underneath.
  .topbar {
    flex-wrap: wrap;
    min-height: 64px;
    height: auto;
    padding: 10px 14px;
    gap: 8px;
  }

  .topbarBurger {
    display: inline-flex;
    order: 1;
  }

  .pageTitle {
    order: 2;
    flex: 1;
    font-size: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .topbarMid {
    order: 4;
    width: 100%;
    flex: 0 0 100%;
    margin-left: 0;
    margin-top: 4px;
  }

  .topbarRight {
    order: 3;
    flex-shrink: 0;
    gap: 8px;
  }

  // Demo Data: hide the label, keep the switch + ON/OFF state chip
  .demoLabel {
    display: none;
  }

  // "New Part" CTA: hide label text, keep the + icon only
  .btnNewpartLabel,
  .btn .btnLabel {
    display: none;
  }

  // Content padding shrinks
  .content {
    padding: 16px 14px 40px;
  }
}
```

- [ ] **Step 5: Append the admin compact breakpoint (≤420) block**

```scss
// ─── Admin compact (<=420px) ──────────────────────────────────────────────

@media (max-width: $bp-admin-compact) {
  .pageTitle {
    font-size: 15px;
  }

  // Hide ON/OFF text on the demo toggle to free up topbar real estate
  .demoState {
    display: none;
  }
}
```

- [ ] **Step 6: Verify SCSS compiles**

Run: `cd /home/matthew/circuits-com/frontend && npx sass --quiet-deps src/admin/components/AdminLayout.module.scss /tmp/admin-check.css 2>&1 | head -5`
Expected: No error output. Then `rm /tmp/admin-check.css`.

- [ ] **Step 7: Commit**

```bash
cd /home/matthew/circuits-com && git add frontend/src/admin/components/AdminLayout.module.scss && git commit -m "feat(admin): SCSS scaffolding for mobile sidebar drawer + reflow"
```

---

## Task 6: AdminLayout — wire up state machine + drawer markup

**Files:**
- Modify: `frontend/src/admin/components/AdminLayout.tsx`

- [ ] **Step 1: Add Menu icon to lucide import**

In `AdminLayout.tsx`, find the lucide-react import block (lines 3-18) and add `Menu` + `X` to the list:

```tsx
import {
  LayoutDashboard,
  Package,
  Building2,
  Layers,
  Star,
  BarChart3,
  Upload,
  Settings as SettingsIcon,
  ExternalLink,
  LogOut,
  Search,
  Bell,
  Plus,
  Mail,
  Menu,  // 2026-05-13 mobile drawer trigger
  X,     // 2026-05-13 sidebar close button
} from 'lucide-react';
```

- [ ] **Step 2: Add menuOpen state + 3 effects to the component**

Inside `AdminLayout` function body, AFTER the existing `prevUnread` ref declaration (around line 142) and BEFORE the existing `useEffect` for unread count refresh, insert:

```tsx
  const [menuOpen, setMenuOpen] = useState(false);

  // Mobile drawer auto-closes on route change.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Body scroll lock while mobile drawer is open. Restores prev on close/unmount.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  // Esc closes mobile drawer (listener only attached while open).
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
```

- [ ] **Step 3: Update the `<aside>` className to include `.isOpen` when drawer is open**

Find the `<aside className={styles.side}>` line and replace with:

```tsx
      <aside className={menuOpen ? `${styles.side} ${styles.isOpen}` : styles.side}>
```

- [ ] **Step 4: Add the close X button inside the `<aside>`**

Inside `<aside>`, immediately after the opening tag and BEFORE the existing `<Link to="/admin" className={styles.sideBrand}>`, insert:

```tsx
        <button
          type="button"
          className={styles.sideClose}
          onClick={() => setMenuOpen(false)}
          aria-label="Close menu"
        >
          <X size={16} strokeWidth={2} />
        </button>
```

- [ ] **Step 5: Add the topbar burger button**

Find the topbar `<h1 className={styles.pageTitle}>{title}</h1>` line. Replace with:

```tsx
          <button
            type="button"
            className={styles.topbarBurger}
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-controls="admin-sidebar"
          >
            <Menu size={18} strokeWidth={2} />
          </button>
          <h1 className={styles.pageTitle}>{title}</h1>
```

- [ ] **Step 6: Add the scrim div as a sibling of `<aside>`**

Immediately AFTER the closing `</aside>` tag and BEFORE the `<div className={styles.main}>`, insert:

```tsx
      <div
        className={menuOpen ? `${styles.sideScrim} ${styles.isOpen}` : styles.sideScrim}
        onClick={() => setMenuOpen(false)}
        aria-hidden="true"
      />
```

- [ ] **Step 7: Add `id="admin-sidebar"` to the `<aside>` for ARIA controls reference**

Update the `<aside>` opening tag:

```tsx
      <aside
        id="admin-sidebar"
        className={menuOpen ? `${styles.side} ${styles.isOpen}` : styles.side}
      >
```

- [ ] **Step 8: Verify TypeScript compiles**

Run: `cd /home/matthew/circuits-com/frontend && npx tsc --noEmit`
Expected: Exit 0, no errors.

- [ ] **Step 9: Force frontend rebuild**

```bash
cd /home/matthew/circuits-com && docker compose up -d --build frontend
```

- [ ] **Step 10: Manual smoke-test at 375px**

Open `http://localhost/admin/login` in browser at 375×667 viewport. Log in (matthew/admin). Verify:
- Sidebar is hidden; topbar shows hamburger left of "Dashboard" title
- Search trigger moved to its own row beneath the title
- "New Part" CTA shows only the `+` icon
- Tap hamburger → sidebar slides in from left + scrim+blur appears
- Tap scrim → sidebar slides out
- Tap close X → sidebar slides out
- Escape key closes
- Tap a sidebar NavLink → navigates AND closes

- [ ] **Step 11: Commit**

```bash
cd /home/matthew/circuits-com && git add frontend/src/admin/components/AdminLayout.tsx && git commit -m "feat(admin): wire up mobile drawer state machine + burger + close X + scrim"
```

---

## Task 7: Per-page admin content reflow

**Files:**
- Modify (all under `frontend/src/admin/pages/`):
  - `dashboard/DashboardPage.module.scss`
  - `suppliers/list/SuppliersListPage.module.scss`
  - `parts/list/PartsListPage.module.scss`
  - `parts/form/PartFormPage.module.scss`
  - `reports/ReportsPage.module.scss`
  - `messages/list/MessagesListPage.module.scss`
  - `settings/SettingsPage.module.scss`
  - `import/ImportPage.module.scss`

- [ ] **Step 1: Audit which classes need media rules**

Before editing each file, read it once to find:
- Grid-column rules (e.g., `grid-template-columns: repeat(2, 1fr)`) that should collapse
- `<table>` containers that should get `display: block; overflow-x: auto`
- Toolbars/chip-strips that should become horizontal-scroll

For each file, only add the @media block at the bottom if there are matching classes. If a file has no matching grids/tables, skip it.

- [ ] **Step 2: Dashboard — DashboardPage.module.scss**

If `.stats`, `.charts-grid`, `.ring-wrap`, or `.rep-kpi-row` / `.review-stats` exist, append:

```scss
// 2026-05-13 mobile reflow
@media (max-width: $bp-admin-mobile) {
  .stats { grid-template-columns: 1fr; }
  .ringWrap { display: flex; flex-direction: column; }
  .repKpiRow { grid-template-columns: repeat(2, 1fr); }
  .reviewStats { grid-template-columns: repeat(2, 1fr); }
  .chartsGrid { grid-template-columns: 1fr; }
}

@media (max-width: $bp-admin-compact) {
  .repKpiRow { grid-template-columns: 1fr; }
  .reviewStats { grid-template-columns: 1fr; }
}
```

(Adjust class names to match actual local class names — many use camelCase per CSS Module convention.)

- [ ] **Step 3: Suppliers list — SuppliersListPage.module.scss**

If `.supGrid` (or similar) exists, append:

```scss
@media (max-width: $bp-tablet) {
  .supGrid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: $bp-admin-mobile) {
  .supGrid { grid-template-columns: 1fr; }
}
```

If a `<table>` wrapper class exists (e.g., `.aTable`, `.tableWrap`), append:

```scss
@media (max-width: $bp-admin-mobile) {
  .aTable {
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .aTable thead,
  .aTable tbody {
    display: table;
    width: 100%;
    min-width: 640px;
  }
}
```

- [ ] **Step 4-9: Repeat the pattern for the remaining 6 pages**

For each page, identify the local class names for grids/tables/toolbars, then append the appropriate `@media (max-width: $bp-admin-mobile)` block per the design CSS reference. The exact class names depend on what's already in each file — if a class doesn't exist locally (i.e., it's inherited from a different scope), skip it.

Key targets:
- Parts list: `.aTable` h-scroll, `.aToolbar` h-scroll strip
- Parts form: `.formRow2`, `.checkboxGrid` → 1 col
- Reports: `.repKpiRow`, `.reviewStats` → 2 col @820, 1 col @420
- Messages list: `.msgToolbar` h-scroll, `.msgTable` h-scroll
- Settings: `.settingsSide` h-scroll
- Import: `.mapTable` h-scroll, `.checkboxGrid` → 1 col

- [ ] **Step 10: Verify each file compiles**

Run: `cd /home/matthew/circuits-com/frontend && for f in src/admin/pages/dashboard/DashboardPage.module.scss src/admin/pages/suppliers/list/SuppliersListPage.module.scss src/admin/pages/parts/list/PartsListPage.module.scss src/admin/pages/parts/form/PartFormPage.module.scss src/admin/pages/reports/ReportsPage.module.scss src/admin/pages/messages/list/MessagesListPage.module.scss src/admin/pages/settings/SettingsPage.module.scss src/admin/pages/import/ImportPage.module.scss; do echo "=== $f ===" ; npx sass --quiet-deps "$f" /tmp/check.css 2>&1 | head -3 ; rm -f /tmp/check.css ; done`
Expected: All quiet, no errors.

- [ ] **Step 11: TypeScript still compiles (sanity check)**

Run: `cd /home/matthew/circuits-com/frontend && npx tsc --noEmit`
Expected: Exit 0.

- [ ] **Step 12: Force rebuild**

```bash
cd /home/matthew/circuits-com && docker compose up -d --build frontend
```

- [ ] **Step 13: Commit**

```bash
cd /home/matthew/circuits-com && git add frontend/src/admin/pages/ && git commit -m "feat(admin): per-page mobile content reflow (grids, tables, toolbars)"
```

---

## Task 8: Visual verification via chrome-devtools-mcp + small mobile bug fixes

**Files:**
- Verification only. Any small fixes get amended into a fix-up commit at the end.

- [ ] **Step 1: Run the full verification matrix from the spec**

For each cell in the spec's verification matrix, use chrome-devtools-mcp to navigate + screenshot. Use a single page with `navigate_page` for the loop (per CLAUDE.md — `new_page` per cell accumulates tabs).

Public site cells: 5 pages × 2 mobile widths (375, 430) + 1 boundary width (760) = ~13 screenshots, plus the 4-theme matrix at 430 (20 more screenshots).

Admin cells: 6 pages × mobile widths (375, 430) + 820/1024 boundaries = ~16 screenshots.

- [ ] **Step 2: For each screenshot, check for:**
- Drawer renders correctly (closed by default, opens cleanly)
- No body horizontal scroll
- No text clipping or overflow
- No element overlap
- Themes render correctly (public site only)

- [ ] **Step 3: Document any small mobile bugs found in existing pages**

Per the scope decision ("Bundle + small fixes"), if I find small layout bugs in existing pages (not in the design bundle), fix them inline. Examples of "small":
- Padding adjustment (e.g., a card has too much padding at 375px)
- Word break or text-wrap: balance/pretty
- Adjusting `min-width: 0` on a flex child to allow ellipsis
- Fixing an obviously wrong `min-width` that causes horizontal scroll

Examples of NOT-small (defer to follow-up):
- Redesigning a multi-column layout
- Replacing inline labels with stacked layout
- Custom mobile-only components

- [ ] **Step 4: Lighthouse a11y at 430px on `/` and `/admin/login`**

Run `lighthouse_audit` with `category: ["accessibility"]`, `mode: "navigation"`. Verify score ≥ 95 for each.

- [ ] **Step 5: Commit any fixes**

```bash
cd /home/matthew/circuits-com && git add -A && git commit -m "fix(frontend): mobile bug fixes from verification pass"
```

(Skip this step if no fixes needed.)

---

## Task 9: Run /simplify (3 parallel agents) + /code-review

**Files:**
- Per agent feedback, fix-up commits applied inline.

- [ ] **Step 1: Capture the diff for agent context**

```bash
cd /home/matthew/circuits-com && git diff 64e482c..HEAD --stat
git diff 64e482c..HEAD > /tmp/mobile-nav-diff.txt
```

- [ ] **Step 2: Launch /simplify (3 agents in parallel)**

In a single message, dispatch 3 Agent calls in parallel:
- code-reuse review (look for new util duplications)
- code-quality review (hacky patterns, leaky abstractions, unnecessary state)
- efficiency review (hot-path bloat, hidden re-renders, scroll-lock leaks)

Plus `pr-review-toolkit:code-simplifier` agent for project-convention check.

- [ ] **Step 3: Launch /code-review:code-review agent**

Dispatch in parallel with the above. Focus on:
- Logic errors / null-handling
- Security (no XSS, no innerHTML, no untrusted redirects)
- Adherence to CLAUDE.md conventions

- [ ] **Step 4: Aggregate findings and fix valid ones**

For each finding from each agent:
- If valid → fix inline
- If false positive → note and skip
- If borderline → user-judgment call (default skip if unsure)

- [ ] **Step 5: Commit fixes**

```bash
cd /home/matthew/circuits-com && git add -A && git commit -m "polish(frontend): simplify + review feedback applied"
```

(Skip if no changes.)

---

## Task 10: Final immaculate validation via /superpowers:dispatching-parallel-agents

**Files:**
- Validation only. Bug fixes get amended via fix-up commits.

- [ ] **Step 1: Verify dispatch checklist**

Active validation agents (parallel dispatch):
- `visual-regression-guard` — diff against `tests/visual/baselines/`. Expected: drift on the navbar pixel rect (new element) but NOT on hero/body. Note new baselines as required.
- `theme-persistency-guard` — verify drawer renders correctly across every public route × all 4 themes. Catches per-page theme leakage.
- `frontend-perf-auditor` — Lighthouse + rAF frame sampling on mobile. Verify the 220ms drawer transition doesn't trigger LongAnimationFrame warnings.
- `chrome-devtools-mcp` a11y-debugging — accessibility tree audit (focus order, aria-attrs, contrast). Tap-target audit (≥44×44 — should pass since drawer links are 52px-min).
- `pr-review-toolkit:silent-failure-hunter` — re-verify no error suppression introduced in the 3× useEffect cleanups. Look specifically at `document.body.style.overflow = prev` — does it run on all unmount paths?
- `seo-auditor` — verify no SEO regression from new drawer markup. The drawer is full-DOM (not portal) so its `aria-hidden="false"` content could inflate page-text score if not careful. Expected: no impact.

- [ ] **Step 2: Dispatch all 6 agents in parallel**

In a SINGLE message with 6 Agent tool calls, dispatch the team. Pass each the diff at `/tmp/mobile-nav-diff.txt` plus the spec at `docs/superpowers/specs/2026-05-13-mobile-responsive-nav-design.md`.

- [ ] **Step 3: Aggregate verdicts**

For each agent, classify:
- GREEN: ship as-is
- YELLOW: known/expected (e.g., visual-regression-guard flagging new burger element)
- RED: bug to fix before merge

- [ ] **Step 4: Fix all RED findings**

Apply fixes, re-run the relevant agents to confirm fix landed.

- [ ] **Step 5: Commit fixes (if any)**

```bash
cd /home/matthew/circuits-com && git add -A && git commit -m "fix(frontend): final-validation findings addressed"
```

(Skip if no changes.)

---

## Task 11: Push to origin/updates + ASK before merging to master

**Files:**
- None — git only.

- [ ] **Step 1: Final pre-push checks**

```bash
cd /home/matthew/circuits-com && git status && git log --oneline 64e482c..HEAD && npx --prefix frontend tsc --noEmit
```

Expected: clean working tree, 3-7 new commits since `64e482c`, tsc exit 0.

- [ ] **Step 2: Push to origin/updates**

```bash
cd /home/matthew/circuits-com && git push origin updates
```

Expected: pushes the new commits without errors.

- [ ] **Step 3: STOP — ASK USER for merge approval**

Do NOT run `git checkout master && git merge updates`. Ask the user to confirm the implementation is ready before merging to master. The user has been explicit: "do not implement the changes into the github repo before I give the go-ahead".

If user approves the merge:

```bash
cd /home/matthew/circuits-com && git checkout master && git merge --ff-only updates && git push origin master
```

Followed by deploy:
```bash
./deploy.sh --frontend  # frontend-only deploy + nginx restart (avoid 502 gotcha)
```

If user requests changes, return to the relevant task and amend.

---

## Task 12: Update CLAUDE.md with mobile-drawer patterns (post-merge)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Invoke `claude-md-management:claude-md-improver` skill**

Have it audit CLAUDE.md and propose 1-2 additions for:
- Mobile-drawer state machine pattern (Esc + scroll-lock + route-close + scrim) as reusable for any new modal/drawer UI
- 4 new breakpoint vars + when to reach for each

- [ ] **Step 2: Apply approved edits via Edit tool**

- [ ] **Step 3: Commit on master (already merged)**

```bash
cd /home/matthew/circuits-com && git add CLAUDE.md && git commit -m "docs(claude-md): mobile-drawer pattern + 4 new breakpoint vars"
```

- [ ] **Step 4: Push**

```bash
cd /home/matthew/circuits-com && git push origin master
```

---

## Self-review checklist (run after writing this plan, before executing)

- [x] **Spec coverage:** Every scope item from the spec maps to a task. Verification matrix lands in Task 8.
- [x] **Placeholder scan:** No TBDs. Task 7 has a small fuzzy spot ("class names depend on what's already in each file — if a class doesn't exist locally, skip it") which is intentional and bounded by the explicit per-page targets immediately below.
- [x] **Type consistency:** Types referenced (`KeyboardEvent`, `ReactNode`) are React/DOM stdlib. No custom type signatures introduced.
- [x] **Commit boundaries:** 4 main commits (vars, navbar SCSS, navbar TSX, admin SCSS, admin TSX, per-page reflow) + 2-3 fixup commits during verification/review = ~7 total.
- [x] **Risks addressed:** Pinned-edge pattern preserved (Task 2 Step 4); chrome-devtools-mcp `navigate_page` pattern enforced (Task 8 Step 1); bundle hash drift expected (no test); body scroll lock cleanup verified (Task 10 Step 1).
