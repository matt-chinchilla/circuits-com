---
name: banner-out-of-publiclayout
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: PublicLayout\.tsx$
  - field: new_text
    operator: contains
    pattern: CategoryPartnersBanner
---

⚠️ **The Preferred Partners banner is being added to PublicLayout — this re-breaks the layout order.**

`CategoryPartnersBanner` must live INSIDE `pages/category/index.tsx`, at the top of `.contentWide`, **below** the breadcrumb + sticky sub-nav. Mounting it in `PublicLayout` (a sibling of the `<Outlet/>`) renders it **above** the per-page nav — the exact regression fixed on 2026-06-04 (commit `f253070`).

If the goal is "persist across subcategory navs without remounting": that's already solved by the session memo in `@shared/services/partnersMemo.ts` — the banner renders synchronously from cache, no pop-in. Keep the banner in CategoryPage; do **not** move it into the layout.
