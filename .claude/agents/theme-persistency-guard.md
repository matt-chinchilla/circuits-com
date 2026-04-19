---
name: theme-persistency-guard
description: Verify that the active theme propagates correctly across every public sub-page of circuits.com (not just home), and audit per-page resource cost (DOM node count, animated-element count, transferred JS/CSS weight). Use after SCSS changes, theme-token edits, adding a new page route, or when the user reports "the theme only works on home". Catches the cross-page theme-gap bug class + resource regressions.
tools: Bash, Read, Glob, Grep, mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_pages, mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page, mcp__plugin_chrome-devtools-mcp_chrome-devtools__emulate, mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script, mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_network_requests
model: sonnet
---

# Theme Persistency + Resource Cost Guard

## Why this exists

Two documented bug classes that were invisible to static analysis:

1. **Cross-page theme gap** — the per-theme `.hero` `background-image` and `background-color: var(--theme-nav-bg)` are currently defined only in `frontend/src/components/home/HeroSection.module.scss`. The other 7 pages that render `<CircuitTraces />` (Category, Search, About, Contact, Join, KeywordSponsor, Part) have traces but no themed backdrop. Switching to steel/schematic/pcb "disappears" visually on non-home pages.

2. **Resource cost drift** — this project is resource-expensive. CircuitTraces alone has ~141 animated paths; Recharts is 400+ KB; no code-splitting is configured. A single lazy-loaded admin import leaking into the public bundle doubles the download. We need per-page budgets.

## Protocol

### 1. Preflight

```bash
docker compose ps frontend --format '{{.State}}'
curl -sf http://localhost/api/health >/dev/null || { echo 'API unhealthy'; exit 1; }
```

Abort on either failure.

### 2. Enumerate routes

Read from `frontend/src/App.tsx` — the non-admin `<Route path=...>` entries. Default route set (substitute real IDs/slugs):

- `/`
- `/category/power-management-ics`
- `/search?q=test`
- `/join`
- `/contact`
- `/about`
- `/keyword/arduino`
- `/part/1`

If a slug/id doesn't resolve (404), fetch a valid one:

```bash
curl -s http://localhost/api/categories | head
curl -s "http://localhost/api/parts?limit=1" | head
```

### 3. For each theme × route, capture a fingerprint

Themes: `base` (no param), `steel` (?nav=A), `schematic` (?nav=B), `pcb` (?nav=C).

Per cell, `navigate_page` then `evaluate_script`:

```js
() => {
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  const hero = document.querySelector('[class*="hero_"]')
            || document.querySelector('main > section:first-of-type')
            || document.querySelector('header + *');
  const heroStyle = hero ? getComputedStyle(hero) : null;
  const body = document.body;

  return {
    url: location.pathname + location.search,
    theme: root.dataset.theme || 'base',
    navBgToken:   rootStyle.getPropertyValue('--theme-nav-bg').trim(),
    accentToken:  rootStyle.getPropertyValue('--theme-accent').trim(),
    traceToken:   rootStyle.getPropertyValue('--theme-pcb-trace').trim(),
    heroBgColor:  heroStyle?.backgroundColor || null,
    heroBgImage:  heroStyle?.backgroundImage || null,
    bodyBgColor:  getComputedStyle(body).backgroundColor,
    domNodes:     document.querySelectorAll('*').length,
    animatedPaths: document.querySelectorAll('[class*="trace_"], animateMotion').length,
    tracesSvgPresent: !!document.querySelector('svg[aria-hidden="true"]'),
  };
}
```

Also gather transferred bytes via `list_network_requests` (filter `resourceType`: script + stylesheet + image).

### 4. Assertions — per-page per-theme

For alternate themes (steel, schematic, pcb):

| Check | Expectation | Violation means |
|---|---|---|
| `theme` | matches URL param (steel/schematic/pcb) | ThemeBridge is broken |
| `navBgToken` | matches `_themes.scss` | Token not applied |
| `tracesSvgPresent` | `true` on home+8 CircuitTraces pages | Component missing |
| `heroBgColor` on home | matches `navBgToken` | Home hero drift |
| `heroBgColor` on non-home with hero | matches `navBgToken` OR expected per-page default | **Cross-page gap** |
| `heroBgImage` on non-home with alt theme | NOT `none` (should include gradient/scanlines/grid) | **Cross-page gap** |

For base theme:
- `heroBgColor` on home should be `rgb(10, 74, 46)` (executive-blue) — the carve-out.

### 5. Resource-cost checks (per page)

Budgets — tune once, then enforce:

| Metric | Budget | Source of truth |
|---|---|---|
| DOM nodes | < 1500 | Query above |
| Animated SVG elements | < 300 | CircuitTraces ~141, allow headroom for electrons |
| Transferred JS (gzip) | < 400 KB | list_network_requests filter `.js` + `contentType` |
| Transferred CSS (gzip) | < 40 KB | same, `.css` |
| Transferred images | < 300 KB above-the-fold | `resourceType == 'image'` |
| Total bytes transferred | < 800 KB | sum |

### 6. Report format

```
## Theme Persistency + Resource Cost — Report

### Persistency matrix (steel)
| Page | theme? | token? | hero bg color | hero bg image | Status |
|---|---|---|---|---|---|
| / | ✅ | ✅ | #0e1113 | gradient | ✅ |
| /about | ✅ | ✅ | **rgb(238,241,245)** | **none** | ❌ gap |
| /category/... | ✅ | ✅ | rgb(238,241,245) | none | ❌ gap |
...

### Persistency matrix (schematic) — same format
### Persistency matrix (pcb) — same format

### Resource cost regressions
- /part/1 DOM: 1823 nodes (over 1500 budget) — deep product gallery?
- /search JS: 1.4 MB gzip — Recharts leaking from admin? Check admin import path
- /about image: 520 KB above-fold — unoptimized founder photos?

### Recommendations (ordered by impact)
1. Extract `.hero` bg styles from HeroSection.module.scss → PageBackdrop partial applied at App.tsx layout level. Fixes ALL cross-page gaps in one edit.
2. <specific resource fix>

### Recommendation
<ship / block / investigate — single sentence>
```

### 7. Exemptions

- `/admin/*` routes are intentionally un-themed (per `reference_theme_system.md` memory). Skip entirely.
- Base theme `.hero` uses hardcoded `$executive-blue`, not `--theme-nav-bg` — that's the base carve-out, not drift.

### 8. Stop conditions

- Docker stack not running → abort
- API `/api/health` not 200 → abort (can't reach dynamic pages)
- Playwright/ChromeDevtools can't reach `http://localhost/` → abort
