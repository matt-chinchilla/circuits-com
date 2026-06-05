---
name: no-slide-entrance-category
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: pages/category/index\.tsx$
  - field: new_text
    operator: regex_match
    pattern: opacity:\s*0,\s*[xy]:
---

⚠️ **Slide-in entrance animation on the category page — this is the per-nav "jitter" we removed.**

A translate-based entrance (`initial={{ opacity: 0, x: … }}` or `y: …`) replaying on every subcategory navigation reads as "items sliding into place for ~half a second" — removed 2026-06-04 (commit `831178a`) after the user reported it as jitter.

Keep entrance animation on this page to **opacity-only fades** (no `x`/`y` translate), or make navigation instant. The banner's row-stagger (`useEntrance`) was removed for the same reason — don't reintroduce it here either.
