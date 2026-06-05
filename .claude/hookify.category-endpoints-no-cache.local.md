---
name: category-endpoints-no-cache
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: routes/categories\.py$
  - field: new_text
    operator: contains
    pattern: max-age
---

⚠️ **`max-age` in the category endpoints re-opens the sponsor-staleness bug.**

The category list + detail and `/{slug}/partners` endpoints must stay `Cache-Control: no-cache` (see `_CATEGORY_CACHE_CONTROL`). A positive `max-age` TTL lets a **stale Preferred-Partners banner survive an admin sponsor add/delete** — the bug the 2026-06-03 single-source fix (inc1) closed. The guard test `api/tests/test_cache_headers.py` will also fail.

Cheap revalidation is already handled by the **ETag/304** on `/partners` — keep `no-cache`, never `max-age`.
