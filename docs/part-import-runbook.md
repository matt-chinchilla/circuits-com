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

## Nightly auto-import (hands-off catalog growth)

Each distributor row in the admin console has a **Nightly auto-import** switch
(Suppliers → open a supplier). With it on, the `feed-import` service imports
new parts for that supplier every night at **06:00 UTC** (~1–2 AM ET, after the
distributor's daily quota resets and well clear of the working day).

The switch only turns on for a supplier that could actually run — one a feed
provider covers *and* that has an API key saved (Settings → distributor feed
keys, or the host `.env`). If the key is later removed or the supplier's
website edited, the switch stays where you left it and the job simply skips
that supplier for the night, saying so in its log.

Nothing else is needed. To see what a night did: **Dashboard → Recent
Activity**, where each run appears as `Inventory import — N created · …`.

### The two levers

| Setting | Default | What it does |
| --- | --- | --- |
| `FEED_IMPORT_HOUR_UTC` | `6` | The hour (UTC) the run starts |
| `FEED_IMPORT_CALL_BUDGET` | `850` | API calls the whole night may spend, split evenly across the enabled suppliers |

Both live in `/opt/circuits-com/.env` on the server; changing one needs
`docker compose ... up -d --force-recreate feed-import` (a plain `restart` does
not re-read `.env`).

### Digging deeper each run (the import cursor)

Every import — the nightly job and the **Import new parts** button alike —
remembers how far into each category's search results it has already read, per
distributor. The first run of a category reads the first page, the next run
reads the page after it, and so on. That is what makes repeated clicks keep
finding new parts instead of re-reading the same first page and reporting
`0 created`.

A category that answers with fewer parts than were asked for is treated as
**exhausted** — the distributor has nothing more under that keyword — and it is
skipped from then on, so the budget flows to categories that still have depth.
The run's first console line says how many are left: *"growing catalog · budget
850 calls · 42 categories to sweep"*.

When every category is exhausted the depth is **cleared automatically** and the
next run starts again from the top, saying so in the console (*"catalog fully
swept — restarting from the top"*). That is deliberate: a second pass
re-verifies stock and prices and picks up whatever the distributor has listed
since. Nothing to schedule and no lever to pull.

Depth is stored per supplier in `supplier_feeds.import_cursor`. To force one
distributor to start over from the first page (engineering, on the server):

```bash
docker compose exec -T db psql -U circuits -d circuits \
    -c "UPDATE supplier_feeds SET import_cursor = NULL WHERE supplier_id = '<uuid>';"
```

Safe at any time — the imports are idempotent, so a re-read refreshes what is
already there rather than duplicating it.

### Watch the daily quota

A free Mouser key allows **~1,000 calls/day**, and there are two spenders:

- one click of **Import new parts** in the admin console — up to **900** calls,
- the nightly run — up to **850** calls.

They can jointly exceed the daily allowance, and **nothing tracks the total**:
the two run in separate containers with no shared counter, and guessing at one
would be worse than not having it. So the honest failure is the wall itself —
the run stops with the distributor's own "quota exceeded" message, visible in
the console for a click and in the activity feed for a night. A day of heavy
manual importing is a night the nightly run may not finish.

If that happens regularly, lower `FEED_IMPORT_CALL_BUDGET` (leaving more room
for clicks) or use a smaller `calls` on the manual import.

A quota wall stops the **whole night**, not just the supplier that hit it — the
quota belongs to the key, so every remaining supplier would only spend requests
to be refused identically.

### Running it by hand

```bash
docker compose run --rm feed-import python -m app.jobs.feed_import_daily --once
```

One pass now, then exit — same selection, same budget, same activity rows.

## After a big import: refresh the SEO manifest

New parts are new public pages, and the site is **prerendered**: every URL is
served as its own static HTML document, built from the committed snapshot at
`frontend/seo-manifest.json`. A part that is not in that snapshot still works,
but it serves the generic shell — no title, no canonical, no product markup —
which is the difference between a page search engines index and one they
ignore.

So after a batch of imports (a few nights of nightly runs, or a big manual
fill), regenerate and redeploy the frontend:

```bash
node frontend/scripts/gen-seo-manifest.mjs https://circuitcenter.ai/api
git add frontend/seo-manifest.json && git commit -m "chore(seo): refresh manifest"
git push && ./deploy.sh --frontend
```

(The argument is the API base — it must end in `/api`. Point it at the server
that actually holds the parts; the default is the local stack.)

Monthly is plenty while imports are steady; do it sooner after a large
one-off. Nothing breaks if it is skipped — the new pages simply do not carry
their own head tags until it runs.

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
