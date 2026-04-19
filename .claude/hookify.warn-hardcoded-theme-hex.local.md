---
name: warn-hardcoded-theme-hex
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: frontend/src/.+\.scss$
  - field: file_path
    operator: not_contains
    pattern: _themes.scss
  - field: file_path
    operator: not_contains
    pattern: _variables.scss
  - field: new_text
    operator: regex_match
    pattern: (?i)#(0a4a2e|44bd13|dabe41|3a8a1a|141a1e|063a23|c49b5d|e8be2d|7dec45|5ad129|d8b074)\b
---

⚠️ **Hardcoded theme hex detected in component SCSS**

You've added (or edited near) a color value that matches one of the theme tokens defined in `frontend/src/styles/_themes.scss`. Hardcoding these bypasses the theme system and is how the **About page's `.hero` ended up painting `#0a4a2e`** (executive-blue) regardless of active theme — caught during 2026-04-19 theme-persistency-guard dry-run.

**Preferred alternatives:**

| Hardcoded | Use instead |
|---|---|
| `#44bd13` | `var(--theme-accent)` (per-theme brand green) |
| `#0a4a2e` | `$executive-blue` (explicit base-only) OR `var(--theme-nav-bg)` |
| `#dabe41`, `#7dec45`, `#c49b5d` | `var(--theme-pcb-trace)` |
| `#0e1113`, `#141a1e`, `#063a23` | `var(--theme-nav-bg)` |

**Legitimate exceptions:**
- You ARE editing `_themes.scss` (source of truth) — exempted by path.
- You ARE defining a new SCSS variable in `_variables.scss` — exempted by path.
- The hex represents a per-component constant (error red, star yellow) that has nothing to do with theme switching — proceed but document.

If this is drift, swap the hex for the appropriate `var(--theme-*)` or `$variable`. Check the table above.
