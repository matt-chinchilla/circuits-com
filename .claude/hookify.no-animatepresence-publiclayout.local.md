---
name: no-animatepresence-publiclayout
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: PublicLayout\.tsx$
  - field: new_text
    operator: contains
    pattern: AnimatePresence
---

⚠️ **Don't reintroduce `AnimatePresence` around the `<Outlet/>` in PublicLayout.**

Framer Motion v12 + `Suspense` + lazy routes leaves the **second-nav entering `motion.div` stuck at the previous page's exit-state** (blank / frozen pages). It was removed deliberately (2026-04-26). Each page owns its entrance; route changes are hard cuts. See the comment in `PublicLayout.tsx` and the gotcha in `CLAUDE.md`.
