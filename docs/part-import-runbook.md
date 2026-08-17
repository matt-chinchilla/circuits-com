# Part Import Runbook — filling the catalog from distributor APIs

Audience: Circuit Center staff. No coding required — two commands, run from
the project folder on the server (or locally in the dev stack).

## One-time setup: get an API key

1. Go to **mouser.com/api-search** and request a *Search API* key (free).
2. The key arrives by email. Treat it like a password: never paste it into a
   file, a chat, or a commit — it is only ever typed into the command below.

## Populate every empty category (the big one)

```bash
docker compose exec -e MOUSER_API_KEY=PASTE_KEY_HERE api \
    python -m app.jobs.import_parts --fill-all-empty --per-category 25
```

What it does: walks every subcategory that has **zero parts** and imports up
to 25 real parts into each — descriptions, product images, datasheets, live
stock, lead times, and full price-break ladders, all attributed to a "Mouser
Electronics" supplier row. One category failing is reported and skipped; the
run continues.

Expectations: ~115 empty subcategories × 1 API call each ≈ **5 minutes**
(the tool self-throttles under Mouser's 30-calls/minute limit). Free keys
allow ~1,000 calls/day, so this uses ~12% of a day's quota.

## Backfill photos for parts we already had

```bash
docker compose exec -e MOUSER_API_KEY=PASTE_KEY_HERE api \
    python -m app.jobs.import_parts --backfill-images --limit 500
```

Looks up each part still missing a photo by its manufacturer part number and
fills in the image (and datasheet link when we lack one). One part = one API
call, so `--limit 500` ≈ half a day's free quota; run it on consecutive days
until `filled` + `missed` reach zero remaining.

## Top up a single category

```bash
docker compose exec -e MOUSER_API_KEY=PASTE_KEY_HERE api \
    python -m app.jobs.import_parts --fill-category capacitors \
    --query "ceramic capacitor" --count 50
```

`--fill-category` takes the **subcategory slug** (the last part of the site
URL, e.g. `/category/passive-components/capacitors` → `capacitors`).
`--query` overrides the search keyword when the category name is too generic.

## Re-running is always safe

Every command is idempotent: parts are keyed by manufacturer part number,
listings by (part, distributor). Re-running refreshes stock/prices in place —
it never duplicates rows, and it never overwrites a photo or datasheet that
is already set.

## Adding categories

- **One-off**: use the admin console (Categories → New) — it appears on the
  site immediately; then run `--fill-category <its-slug>` to stock it.
- **In bulk / permanently**: categories that must exist in every fresh
  environment belong in `api/app/db/seed.py` `CATEGORY_DATA` (ask
  engineering) — the 2026-08-16 Octopart-derived expansion lives there as
  the example to follow.

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `MOUSER_API_KEY is not set` | The `-e` flag was omitted or misspelled | Re-run with `-e MOUSER_API_KEY=...` exactly as above |
| `Mouser API error: ...TooManyRequests` | Daily quota exhausted | Wait for the quota reset (24 h) and re-run — it resumes where needed |
| A category row shows `"error": ...` | That one category failed | Re-run just it with `--fill-category <slug>`; the rest already landed |
| New parts show a package drawing, not a photo | Mouser had no image for that part | Expected — the page shows the representative render + disclaimer |
