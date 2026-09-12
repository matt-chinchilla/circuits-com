# Design viewer — verified research packet (2026-09-12)

Five research agents ran one dimension each (storage, renderer, growth, KiCad plugin, landscape); each was then re-run by an adversarial verifier that re-retrieved every cited source and, where possible, ran a live test. 5 of 5 dimensions completed. Where a verifier refuted a claim, only the correction appears below (§7 lists them). Method: primary sources only — GitHub/GitLab REST APIs, npm registry, PyPI, AWS Price List API, vendor pricing pages, local clones, local Postgres measurements, and one live browser session against the deployed kicanvas.org. Every number carries a unit and a URL; retrieval date is 2026-09-12 unless stated. VERIFIED = the page/measurement was obtained; INFERRED = reasoning. Companion packet: `docs/design-briefs/bom-kicad-research-2026-08-19.md` (licensing, kicad-cli cost, tracespace/Gerber, 3D) — not re-verified here.

---

## 1. Decision summary

| Dimension | $0 choice now | Long-term choice | Migration seam | Confidence |
|---|---|---|---|---|
| Storage | Postgres `bytea`, gzipped **in the app** (browser `CompressionStream` preferred), `SET STORAGE EXTERNAL` | S3 Standard, same account/region, short-TTL presigned GET | One `storage_uri TEXT` (`pg://…` → `s3://…`) + `size_bytes`/`content_encoding`/`sha256`, behind one read + one write function | high |
| Renderer | KiCanvas vendored at `b031159eb74aaa7eef2b026fd85d35bc05ff2095` (2026-04-28), source tree not hosted bundle, 2 patches + 1 WebGL2 guard | Same pin; revisit only if upstream unfreezes or Huaqiu splits its CJK glyph table out | One adapter module wrapping `select()` / `zoom_to_selection()`; own s-expression reader owns BOM + stackup | high |
| BOM/stackup reader | Our own pure-TS s-expression parser (decided) — now a **requirement**, not a preference | Same | Reader is independent of KiCanvas; renderer swap costs nothing | high |
| Growth | Instrument outbound clicks per BOM line; SEO at the *generate-a-BOM* cluster | kicad.org external-tools listing; PCM plugin after first sponsor | `OutboundClick` already exists and is already surfaced per customer | medium |
| KiCad plugin | GO, but LATE and OUTSIDE PCM: a Python **Legacy BOM generator** that writes a CSV and opens `/bom` — never connects | PCM submission + `package@kicad.org` contract once a sponsor pays | Landing page `/bom` already exists; plugin never touches our API | medium |
| Positioning | See §6 — claim the **schematic-side BOM priced on our own catalog**, never the rendering, never the stackup | Same | — | high |

---

## 2. Storage

Prices retrieved 2026-09-12. AWS figures are SKU-level from the Price List API (authoritative; the HTML pricing tables are JS-rendered and return prose only).

| Option | Storage | Requests | Egress | Free allowance | Source |
|---|---|---|---|---|---|
| Postgres on existing gp3 | $0.08 /GB-month (extra volume) | — | — | 7.6 GB free on the 20 GB root | AWS Price List API, sku `JG3KUJMBRGHV3N8G`, effective 2026-09-01 |
| S3 Standard (us-east-1) | $0.023 /GB-mo first 50 TB; $0.022 next 450 TB; $0.021 over 500 TB | PUT/COPY/POST/LIST $0.005 /1,000 (`E9YHNFENF4XQBZR6`); GET + all other $0.004 /10,000 (`ZWQ6Q48CRJXX4FXE`); DELETE/CANCEL free | 100 GB/mo free across all AWS services, then **$0.090 /GB first 10 TB**, $0.085 next 40 TB, $0.070 next 100 TB, $0.050 above 150 TB (`HQEH3ZWJVT46JHRG`) | no minimum object size or duration on Standard; Legacy Free Tier includes "5 GB of Amazon S3 standard storage" for pre-2025-07-15 accounts, 12 months from signup | sku `WP9ANXZGBYYSGJEA`; https://aws.amazon.com/s3/pricing/ ; https://aws.amazon.com/ec2/pricing/on-demand/ ; https://aws.amazon.com/free/legacy/free-tier-faqs/ |
| Cloudflare R2 | $0.015 /GB-month | Class A $4.50/M, Class B $0.36/M | **Free at any volume** | 10 GB-month + 1M Class A + 10M Class B, forever | https://developers.cloudflare.com/r2/pricing/ |
| Backblaze B2 | $6.95 /TB/month ($0.00695/GB-mo) | Class A/B/C free; Class D $0.004/10,000, first 2,500/day free | free = 3× average monthly storage, then $0.01/GB | first 10 GB always free; no min file size or duration | https://www.backblaze.com/cloud-storage/pricing |
| Supabase | 1 GB free / then $25-mo Pro | — | 5 GB free egress | **free projects pause after 1 week idle** — disqualified | https://supabase.com/pricing |
| Wasabi | $7.99 /TB/month headline, no egress/API fees | — | — | paid subscription, minimums not stated on page — not a $0 candidate | https://wasabi.com/pricing |

**Measured, local, 2026-09-12** (project's own `postgres:16-alpine`, PostgreSQL 16.13, `default_toast_compression = pglz`, DB 887 MB): real `starfish.kicad_pcb`, 4,728,417 B → TOAST pglz 1,735,903 B (2.72×), TOAST lz4 1,833,409 B (2.58× — **worse**), gzip -6 1,088,533 B (4.34×). gzip/pglz = 1.59×. A 1,048,576-byte incompressible `bytea` stores at exactly 1,048,576 B with `pg_column_compression` NULL, and `pg_dump --data-only` emits 2,097,927 B = **2.000×**.

**Real KiCad file sizes** (18 files, KiCanvas `debug/examples`): schematics 7,313–216,507 B, gzip 4.55×–8.48×; boards 10,604–**4,728,434 B** (the largest), gzip 4.19×–4.87×; whole corpus 10,331,824 B raw. A 10 MB per-file cap is generous.

**Sizing (INFERRED arithmetic on the verified units):** 100 accounts × 10 designs ≈ 1 GB stored; 1,000 accounts ≈ 10 GB. S3 at 10 GB = $0.23/month. At ~1 MB per gzipped design the first dollar of S3 egress arrives past ~110,000 design-opens/month.

**Recommendation.** Postgres `bytea` today. Price decides nothing (every route is under $1/month here); operational surface decides everything: no new vendor, no new credential, no sixth local container, and the backup path already exists in the pre-reseed `pg_dump -Fc` (`deploy.sh` line 262). Compress in the application — never rely on TOAST — and do **not** set `default_toast_compression=lz4`. Two chores: (1) the new table joins `deploy.sh`'s reseed hand-carries (users, calendar×2, messages, `bom_shares`, `supplier_feeds`), and that list is **test-enforced** — `api/tests/test_leads_schema.py` holds a per-table registry with a `"dump_marker": "--table=bom_shares"` assertion, so an undeclared `designs` table turns the census red rather than silently losing data on `--reseed`; (2) an object store inverts the problem — `TRUNCATE CASCADE` cannot touch a bucket, so its objects orphan and need a sweep with no guard.

Long-term, S3, because the EC2 instance profile already exists (it reaches Cost Explorer), so access is a **policy edit with no secret** — avoiding the repo's documented four-time failure where a value in the host `.env` never reaches the app because the compose `environment:` block is an allowlist (`test_compose_env_passthrough.py`). Presigned GET under an instance profile is good for **~6 hours** ("IAM role credentials used by Amazon EC2 instances – Valid for the duration of the role credentials (typically 6 hours)", https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), with `s3:signatureAge` available to force it shorter. Keep `storage_uri` strictly server-side; expose an opaque design id plus a short-lived link. For local dev build a `file://` branch of the same two functions rather than a MinIO container.

---

## 3. Renderer

**Current state.** Upstream is frozen: tip `b031159eb74aaa7eef2b026fd85d35bc05ff2095`, 2026-04-28T17:37:55Z, one commit in the window since and zero after (GitHub API `/repos/theacodes/kicanvas/commits`). 1,131 stars, 107 forks, 53–57 open issues, `license.spdx_id = NOASSERTION`, **0 tags, 0 releases, no npm package** (`npm view kicanvas` → E404); PR #179 "make it npm installable" open since 2026-02-14. The original author's last commit was 2023-12-03; recent work is one outside contributor. Issue #197 (2026-08-21, "files wont load") still has 0 comments. Hosted bundle unchanged: 477,451 B raw, `last-modified: Tue, 28 Apr 2026 17:38:52 GMT`; **brotli q11 = 93,828 B vs gzip -9 112,178 B — a 16.4% saving, not "materially below"**.

**Live test result (verbatim, deployed build, headless Chrome 153, 2026-09-12).** The brief's GitLab URLs are structurally unreachable: `fetch()` from the page context returned *"CORS/ERROR: Failed to fetch"* for `gitlab.com/.../StickHub.kicad_pcb` (gitlab raw sends no `Access-Control-Allow-Origin`), while the byte-identical copies on `raw.githubusercontent.com` (KiCad/kicad-source-mirror) carry `access-control-allow-origin: *`. Via that mirror:

- **KiCad 10 board**, `StickHub.kicad_pcb`, `(version 20250907)`, 1,063,630 bytes → `"Parsing expression with 1063630 chars"`, **820 console messages, zero parse errors — every parser message a `[warn]`**. Example verbatim (msgid 816): `"No definition found for element filling,none in expression at,146.489117,108.260883,size,0.5,drill,0.3,layers,F.Cu,B.Cu,tenting,front,none,back,none,capping,none,covering,front,none,back,none,plugging,front,none,back,none,filling,none,net,35,uuid,aa8ca2a9-..."`.
- **KiCad 9 hierarchical schematic**, `complex_hierarchy.kicad_sch`, `(version 20250114)` → live model populated: `schematic.version = 20250114`, `symbols = 27`, `sheets = 2`; 8 warnings, all on the `(sheet …)` block. Verbatim (msgid 858): `"No definition found for element dnp,no in expression at,71.12,111.76,size,50.8,36.83,exclude_from_sim,no,in_bom,yes,on_board,yes,dnp,no,..."`.
- **Deep-link API exercised live**: `typeof viewer.select === 'function'` true; `find_symbol('P102')` returns the symbol; `viewer.select('P102')` sets `viewer.selected` with bbox `{x:36,y:62,w:15,h:9}`; `zoom_to_selection()` does not throw; `viewer.select('ZZ999')` on a nonexistent ref **does not throw — it leaves `selected = false`**.
- **Nothing rendered, and it is not KiCanvas's fault**: `getContext('webgl2')` and `getContext('webgl')` both returned `null`; msgid 823 `"[error] Uncaught (in promise)"` at `setup (kicanvas.js:1100:6444)`; canvases 0×0; `document.body.innerText` empty.
- Single-file link silently truncates hierarchy (`"file \"ampli_ht.kicad_sch\" is not existed, skip it."`); the directory form loads all four project files.
- Fonts confirmed live: a `<link>` parented to `document.body`, `crossOrigin "anonymous"`, href `https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@48,400,0,0&family=Nunito:wght@300;400;500;600;700&display=swap`, plus **4 third-party font requests including one to `fonts.gstatic.com`** (a second host).

**Risks, in order.**
1. **Licensing, now located precisely.** `src/kicad/text/newstroke-glyphs.ts` (174,335 B — the glyph table that draws *all* schematic and board text) carries the header *"This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License … version 2 … or (at your option) any later version."* while `LICENSE.md` describes the same dependency as *"Originally licensed under Creative Commons CC0 1.0, amended with an MIT-like license, and utilizes glyphs that are licensed under the SIL Open Font License Version 1.1."* The project contradicts itself; upstream KiCad's `newstroke` license could not be retrieved (four `raw.githubusercontent.com` paths → 404). **That specific contradiction is the lawyer question, before anything ships publicly.** `LICENSE.md` also carries a live distribution obligation: *"This notice must be included in any distributions of this project or derivative works."* — reproduce it verbatim (it discloses five works: Material Symbols, Nunito, Earcut, Newstroke, Bellota).
2. **WebGL2 with no fallback and no error UI** — a silent blank page for locked-down corporate browsers, VMs, GPU blocklists.
3. A KiCad-11 token landing in one of the **two** fatal parser paths (`parser.ts:123` `T.choice`, `parser.ts:357-361` `P.start`). Everything else is `log.warn` + `continue` — proven live.
4. Deep-link API is private and undocumented (roadmap lists it unchecked; PR #106 open 19 months) — but a frozen upstream cannot break it.

**Pin / patch / monitor.**
- **Pin** the source tree at `b031159e…`; record the SHA in `frontend/vendor/kicanvas/UPSTREAM`; vendor `LICENSE.md` verbatim. Frozen upstream makes this simultaneously newest and safest.
- **Patch 1** — delete the `document.body.appendChild(html\`<link … fonts.googleapis.com …>\`)` block in `src/kicanvas/elements/kicanvas-embed.ts` (it runs at module-evaluation time; it carries its own `TODO: Package these up as part of KiCanvas`). This removes the gstatic requests too.
- **Patch 2** — self-host the icon font. Source `MaterialSymbolsOutlined[FILL,GRAD,opsz,wght].woff2` = 3,980,092 B, Apache-2.0 (verified); codepoints file lists 4,284 icons; all 18 names KiCanvas uses are present with the expected codepoints (verified). `varLib.instancer` to wght=400/opsz=48/FILL=0/GRAD=0 then `pyftsubset --unicodes` with `--layout-features=''` → **2,480 B** (single-source measurement); keeping ligatures instead → 259,536 B. The 2.5 KB route drops the ligature table, so add an 18-entry name→codepoint map in `src/kc-ui/icon.ts` `render()`. Delete Nunito (an 8-deep fallback stack already exists; only 3 of the 5 requested weights are used). Watch `src/kc-ui/toggle-menu.ts:115` — its fallback string is `"question-mark"` (hyphen), not a valid ligature.
- **Patch 3 (newly required)** — probe `canvas.getContext('webgl2')` before mounting and render our own explanatory state; and detect `Sheetfile` references missing from a drag-and-drop set and tell the user which files are absent.
- **Do not** use KiCanvas's `Stackup`/`StackupLayer` classes as a cross-check for our stackup reader: the live KiCad 10 board threw warnings *from inside the stackup block* (`"No definition found for element tenting,front,yes,back,yes in expression stackup,layer,F.Si"`, plus covering/plugging/capping/filling). Write that reader against the file-format docs.
- **Monitor, $0**: a CI integrity check that hashes the vendored tree against a committed manifest and asserts our `.patch` files still `git apply --check` — no network, no rate limit. Plus a quarterly three-curl human check with today's expected answers: `pushed_at == 2026-04-28T17:37:55Z`, `tags == 0`, format-token issue search `== 0`; add `npm view @huaqiu/ecad-renderer` — the only thing that would reopen the decision is Huaqiu splitting out its CJK glyph table (today one entry point is ~985 KB gzip vs KiCanvas's 112 KB; 42,380,919 B unpacked).

**Consequence for the BOM (decisive).** KiCanvas discards `in_bom` and `dnp` — the two flags that decide whether a line belongs on a BOM and whether it is DNP. Its parsed model **cannot produce a correct BOM even in principle**. Our own reader is a requirement. It must also filter `#`-prefixed power/virtual symbols (the live schematic yielded `#PWR0110`, `#U0103-5` alongside `P102`/`D101`/`C104`). Exact tokens KiCanvas drops today: board — `tenting`, `covering`, `plugging`, `capping`, `filling`, `duplicate_pad_numbers_are_jumpers`; schematic sheets — `exclude_from_sim`, `in_bom`, `on_board`, `dnp`.

---

## 4. Growth

Paid ads and paid tools excluded. Hour estimates are INFERRED.

| # | Lever | Cost (h) | Time-to-signal | Evidence strength | What to build to capture it |
|---|---|---|---|---|---|
| L1 | Per-MPN / per-BOM-line outbound-click receipt | ~1 day (most already shipped) | immediate | **Strong** — `OutboundClick` grouped by `(part_id, supplier_id)` in `api/app/routes/flows.py`, indexed `(supplier_id, clicked_at)`, and `api/app/routes/account_dashboard.py` already serves each customer a zero-filled daily/monthly referral series | top-10 MPN breakdown + BOM-line attribution only |
| L2 | Make every priced BOM line emit an attributed click | ~6-12 | weeks | Strong by construction | the one feature that turns viewer traffic into sponsor-sellable evidence — cut the stackup panel before cutting this |
| L3 | PCM plugin (see §5) | ~12-20 | 2-6 weeks to merge for ordinary packages; **days to months for commercial** | Medium-strong channel, **weak attribution** — PCM publishes no counts (125 packages, 10 per-version keys, none a count) | GPL-compatible plugin that never connects; instrument the landing page |
| L4 | kicad.org/external-tools listing | 1-3 | unknown | Medium — only **5** tools listed site-wide (inventree-kicad, KiCad StepUp, KiCanvas, KiCost, Part-DB); two are the halves of this product; no published criteria, only a contact form | apply; expect a "is it open source?" question |
| L5 | SEO on the *generate-a-BOM* cluster | 8-16 | 2-4 months | Medium — autocomplete returns 10/10 completions for `kicad bom` and `interactive html bom`, and page one for the latter is 9/9 GitHub repos and 2020-era blog posts with **zero commercial service** | a genuinely useful page + the tool behind it |
| L6 | Embeddable viewer for hardware docs | 6-10 | months | **Weak, and now contested** — the whole KiCanvas embed ecosystem is 322 files / 18 repos (top non-original: 0 stars), and the head-on competitor already ships share links + embeds | by-product only |
| L7 | "Open in viewer" from GitHub URLs | 4-8 | months | Weak — table stakes; `ecadforge.app` and `kicanvas.org` both do it; mass-generating pages walks into the open prerender-scale problem (CLAUDE.md: "prod 132k+ parts needs a cap/tier rule") | support the URL grammar, skip the page generation |
| L8 | "online gerber viewer" / "pcb stackup calculator" | high | — | **Strong that these are lost** — 9/10 and 7/10 of page one are fabs/EDA vendors monetising the click (PCBWay's viewer CTA is literally "Get an instant PCB quote") | supporting copy only |
| L9 | forum.kicad.info launch post | 2-4 | days | Now quantified: of 30 topics on page one of `/c/external-plugins/16`, 28 created in 2026, views 52–7,194, **median 219** | one disclosed post |
| — | Reddit | — | — | **Unmeasured** — `about.json` blocked on 5/5 subreddits; no audience size, no rules obtained | model at zero |

**Scale reference (counted from release assets, not vendor claims):** InteractiveHtmlBom 4,564 stars / **338,133** cumulative release-asset downloads; kicad-jlcpcb-tools 2,064 stars / 75,065 (one PCM zip at 10,639); KiCost 626 stars / 3,214, PyPI **739/month** against `kiutils`'s 32,744 in the same window. Free KiCad tooling reaches six figures of installs; **BOM-costing specifically has failed to for a decade** — temper any forecast on that half.

**Do not use** SnapEDA's "Over 80% of engineers that download SnapEDA's design content purchase the product" (signalintegrityjournal.com, 2022-09-28) — vendor press copy, no methodology, four years old. Octopart's 20M-users figure comes from an unaccepted Wikipedia draft. The only number we can honestly sell is our own click receipt. **Cheapest missing fact in the whole packet: the production row count of `outbound_clicks`** — nobody has run it, and it decides whether the pitch clears the existing `MIN_CLICKS_TO_DRAW = 30` credibility floor.

---

## 5. KiCad plugin

**Go / no-go: GO — small, late, and outside the PCM first.**

**Shape.** A Python **Legacy BOM generator** script — not a `pcbnew.ActionPlugin`, not an IPC plugin.

- There is **no schematic plugin API** in KiCad 9 or 10. Proven at source level: on the `10.0` branch `api/proto/schematic/schematic_commands.proto` declares **zero messages** (GPL header + `package kiapi.schematic.types;` only). (Do *not* cite the "only implemented in the PCB editor" sentence — it is scoped on the page to KiCad 9.0.)
- SWIG is deprecated as of 9.0, targeted for removal in 11.0, and **was already deleted from nightlies**: *"Support for SWIG was removed last week, and users running nightlies will now see an alert that SWIG plugins are no longer compatible with KiCad."* (kicad.org devlist, 2026-03-29).
- The Legacy generator is **alive on the KiCad 11 development branch**: `eeschema/dialogs/dialog_bom.cpp` exists on master; `SCH_EDITOR_CONTROL::GenerateBOMLegacy` is defined at `sch_editor_control.cpp:3489` and wired at `:4013`; `sch_actions.cpp` still declares "Generate Legacy Bill of Materials…". Its last commit is 2026-06-15 housekeeping.
- KiCad 11 master *stages* the types (`SchematicField`, `SchematicSymbolInstance` with `user_fields` and `custom_properties` — so MPN will eventually be reachable) but ships **no command returning placed symbols** (only `GetSchematicHierarchy` → sheets, `GetSchematicNetlist` → nets). An IPC BOM plugin is not buildable today, even against master.

**Constraints.**
- Input is `%I`, the **intermediate netlist XML** — the whole design, including an absolute filesystem path in `<design><source>` (the docs' own sample is `F:\kicad_aux\netlist_test\netlist_test.sch`), every reference designator, hierarchy and connectivity. **Never POST raw `%I`.** Tokens: `%I` `%O` `%B` `%P`.
- A generator **cannot self-register**: *"Additional generator scripts are installed with KiCad but are not populated in the generator script list by default"* — the user clicks the + button. (One open lead could refute this: a `generateBOMExternal` action exists in both 10.0 and master `sch_actions.cpp` with no handler found; the GitLab blob-search API is 401 unauthenticated. Chase it before building.)
- XSLT is dead: *"XSLT is not recommended for new netlist or BOM exporters… Beginning with KiCad 7, xsltproc is no longer installed with KiCad."* Python it is.
- Branding surface: a header comment containing the string `@package` becomes the generator's description in the dialog, and KiCad auto-fills the command line and guesses the output extension from the header's example command line.
- Windows: the dialog hides the console by default and redirects output; generator GUI needs "Show console window" ticked.
- PCM gate names our category verbatim: *"Packages that link to or provide commercial services, including but not limited to PCB fabrication, component lookup and order management, must first contact the KiCad team at package@kicad.org"*, plus *"We need to have a simple contract on file"*. Code packages must be **GPL-compatible**, not merely open source. The FAQ closes the public-API loophole (*"In general, we will only deal with the service provider"*) but keeps one carve-out: *"As long as your plugin doesn't connect to the commercial service provider, we do not need a contract."*
- PCM latency: median 4.0 h over 40 recent merged MRs, **mean 83.9 h, max 1,711.5 h (71 days) — MR !581, Sierra's commercial quote/order plugin.** Plan days-to-months for anything commercial.

**Build it as option B:** parse `%I` locally, write `%O.csv` beside the project, open `https://circuitcenter.ai/bom?from=kicad`, reuse `parseBom.ts` unchanged — zero endpoints, zero storage, zero t3.small load, zero data egress, and by the FAQ's own carve-out no contract. **Do not** encode the BOM in a URL fragment: the correct citation is RFC 9110 §7.1 (*"The target URI excludes the reference's fragment component"*), and §17.11 adds that fragments are visible to browser extensions and are inherited across redirects — disqualifying for design data.

**Build-order position: after the viewer.** Its landing page must already be good; it is a channel with no measured demand. Sequence: viewer + reader → measure `/bom` usage → a weekend on the generator + GitHub repo → PCM and `package@kicad.org` only once a sponsor pays. Maintenance ≈ 6 h/year (text-in/text-out against a format stable since 2010) versus 40+ for an ActionPlugin facing the 10→11 rewrite (`kicad-python` is pre-1.0, 13 releases since 2024-04, currently 0.8.0).

---

## 6. Landscape

| Product | KiCad in? | Schematic? | Component prices? | Free / login | Conflict | Reach |
|---|---|---|---|---|---|---|
| **Altium 365 Viewer** | yes ("KiCad (in Beta)" on the product page) | yes | **yes — "BOM (with pricing information from Octopart)"** | free; 48 h share links on altium.com, **unlimited when embedded on your own pages** | Altium owns Octopart and sells Altium Designer | altium.com Tranco 12,647 |
| **pcbviewer.app / MakerSuite 3D** (one product, not two) | yes, + Gerber/Eagle/Altium/EasyEDA, 3D, share links, embeds | parses `.kicad_sch` | yes — LCSC/JLCPCB, DigiKey, Mouser; but **BOM is "extracted from your PCB file"**, capturing only reference, value, footprint — no MPN | free, no signup; ads + Ko-fi | one person, ad-funded | **no Tranco rank**; 267 sitemap URLs, 59 EN blog posts, lastmod 2026-08-28 |
| **ecadforge.app** | yes, GitHub/GitLab URLs, "no upload" | yes | **no** — BOM *viewer* only | free, no account | none stated | 14 sitemap URLs, unranked |
| **PCBJam** | KiCad compiled to WASM — an **editor** | yes | roadmap: "online stock / pricing info" | free tier + **$10/month Pro** | GPL-3.0 KiCad-derived | presented **"PCBJam: KiCad on the Web" at KiCon Europe 2026, 2026-09-07/09** |
| **BOMexplorer** | KiCad/Altium/**CSV** intake — no `.kicad_sch` | no | yes — OEMSecrets, DigiKey, Mouser, Nexar, FindChips | free tier + $10/mo Pro, "Get Early Access" | resells Nexar (Altium) data | pre-GA |
| **Fabs** (JLCPCB, NextPCB/HQDFM, PCBWay, EasyEDA, GerbLook, Aisler, OSH Park) | several accept `.kicad_pcb` | rarely | **no — they price the BOARD** (or their own assembly library) | free, mostly no login | wants the order | jlcpcb 29,897 · pcbway 50,645 · easyeda 48,350 · nextpcb 425,477 |
| **Huaqiu ecad-viewer** | yes, hosted at eda.cn | yes | unknown | free | Chinese-language funnel | 91 stars; eda.cn Tranco ~4.1M |
| **KiCanvas** | yes | yes | no | free | none | 1,131 stars, frozen; kicanvas.org unranked |
| Upstream KiCad / GitHub / GitLab | — | — | — | — | — | KiCad has **zero web/WASM repos** in its GitLab org; GitHub renders **no** EDA format; GitLab issue #390053 is labelled `backlog::to-be-closed` |

**Positioning sentence (ship this one):**

> **Open your KiCad project in the browser and get every line of the BOM priced across our whole distributor catalog — read straight out of your schematic, with no CSV export, no account, and nobody trying to win your board order.**

**The two features that make it true:**

1. **The BOM is parsed from the `.kicad_sch` files by our own s-expression reader** — design intent, before layout exists. Altium 365 and pcbviewer.app both derive theirs from the board side (pcbviewer.app's own page: it captures reference designator, value and footprint only — no MPN, no manufacturer); BOMexplorer requires a CSV; every fab tool requires a placement file. This is usable at a stage where no competitor's viewer has anything to say. KiCanvas cannot substitute — it discards `in_bom` and `dnp` (measured live).
2. **Prices come from our own multi-distributor catalog and the existing matcher (+20% sponsor band).** Every competitor that shows prices resells someone else's data (Altium→Octopart, BOMexplorer→Nexar) or is quoting to win the board/assembly. Comparison *is* the product, not a lead-gen surface.

**Claim only the BOM.** Rendering is commoditised (four free KiCad viewers plus a fresh crop of GitHub entrants pushed inside 30 days; nine free Gerber viewers whose search results are owned by fabs' content marketing — NextPCB's own "Top Free Online KiCad Viewers", updated June 2026, is the page to outrank). The stackup panel is **not** unoccupied (§7.9). Twelve-month commoditisation risk comes from PCBJam (now community-platformed, with pricing on its roadmap) and from Altium's free unlimited embeddable viewer — not from KiCad, GitHub or GitLab.

---

## 7. What the verifiers refuted

1. **"The prior brief notes KiCad demo boards reaching 85 MB."** Fabricated attribution — `grep` over the 310-line brief finds "85" only in "PR #185" and "1,145,092 B". Largest real KiCad file measured: **4,728,434 B**. A 10 MB per-file cap is generous. Source: local grep + `stat` over `/tmp/kicanvas/debug/examples/*`.
2. **"Presigned URLs under an instance profile force TTLs of minutes."** AWS documents ~**6 hours**, and an `s3:signatureAge` bucket condition to force shorter. https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
3. **"AWS egress tiers could not be retrieved."** They can, via `AWSDataTransfer` queried globally (not region-scoped): **$0.090/GB first 10 TB**, $0.085 next 40 TB, $0.070 next 100 TB, $0.050 above 150 TB (sku `HQEH3ZWJVT46JHRG`). At this volume the applicable rate is the *top* of the range.
4. **"TOAST lz4 marginally beats pglz (2.44× vs 2.42×)."** Reversed on real data: `starfish.kicad_pcb` pglz 2.72× vs lz4 **2.58×**. lz4 buys speed, not space, and costs ~5.6% here.
5. **"gzip 4.06× on KiCad-shaped text."** Synthetic artifact. Real files: boards 4.19×–4.87×, schematics 4.55×–8.48×. Plan ~5×.
6. **"Brotli lands materially below gzip."** Measured: **93,828 B brotli q11 vs 112,178 B gzip -9** on the 477,451 B bundle = 16.4%.
7. **"KiCanvas's Stackup model is a second implementation to validate our reader against."** The live KiCad 10 board warned from inside the stackup block (`tenting`, `covering`, `plugging`, `capping`, `filling` all unrecognised). Validating against it bakes in its blind spots.
8. **"The GPL/MIT provenance question is unresolvable."** It is now located: `src/kicad/text/newstroke-glyphs.ts` (174,335 B) carries a GPL-2.0-or-later header while `LICENSE.md` calls the same dependency CC0-amended-MIT-like. The project contradicts itself; upstream KiCad's newstroke license returned 404 on four paths.
9. **"Nobody surfaces a PCB stackup panel; unoccupied territory."** PCBWay's Electronic Design Viewer both ingests KiCad (`.pro, .sch, .kicad_pcb, .lib`, <50 MB) **and** offers a "Layerstack Data View". https://www.pcbway.com/tool/ElectronicDesignViewer
10. **"Three competitors: ecadforge, pcbviewer.app, MakerSuite 3D."** Two — `pcbviewer.app`'s `<title>` **is** "MakerSuite 3D". Its blog count is 59 EN posts (not ~40) and its sitemap 267 URLs.
11. **"Altium 365 Viewer is free with no registration, 48-hour links."** No-registration is not stated on either cited page (INFERRED only), and the 48-hour cap *"applies only when using Altium 365 Viewer hosted on the Altium website… There is no time limitation when embedding Altium 365 Viewer on your own web pages."*
12. **"'kicad bom pricing' returns 0/5 on-topic autocomplete completions."** It returns `kicad bom price` and `kicad bom cost` first — **2/5**. The query is thin, not dead.
13. **"8 commercial fab plugins in PCM; zero component-lookup packages."** **11–15** vendor/service packages (PCBGOGO-JP, a second Aivon, NextPCB-JP were missed), and `com.github.Steffen-W.impartGUI` names Octopart and Snapeda — a component-lookup plugin *is* in the official repo. Only the vendors themselves are absent.
14. **"PCM requires 'a valid open-source license'."** Incomplete: *"Packages containing code (Python plugins) must be licensed under an open-source license compatible with the GNU GPL."* And the public-API loophole is closed: *"In general, we will only deal with the service provider."*
15. **"PCM merge latency: median 4.0 h, mean 28.6 h, max 362.6 h."** Median holds; mean **83.9 h**, max **1,711.5 h** — MR !581, a commercial order/quote plugin. The researcher's window excluded it.
16. **"Deleting the fonts.googleapis.com link closes the font exposure."** The patch is right, but there is a second host — live `performance.getEntriesByType('resource')` shows a request to `fonts.gstatic.com`. Any CSP rule or verification test written from the original finding checks the wrong half.
17. **"IPC is PCB-only in KiCad 9 and 10"** (presented as a quote). The page scopes it to KiCad 9.0 only. Cite the empty `10.0` `schematic_commands.proto` instead.
18. **"The URL fragment never reaches the server (RFC 3986 §3.5)."** Wrong citation: RFC 9110 §7.1. §17.11 adds that fragments are visible to browser extensions and inherited across redirects.
19. **"Instrumenting the sponsor pitch is 4-8 h of new work."** Most already shipped: `api/app/routes/account_dashboard.py` serves each customer a scoped, zero-filled referral-click series, documented in-code as *"a count of people we sent — never a dollar figure"*. The gap is per-MPN + BOM-line attribution.
20. **"KiCad 10.0.0 (2026-03-20) is the current release; no visible web initiative."** KiCad is on **10.0.6, tagged 2026-08-28**, and the project platformed "PCBJam: KiCad on the Web" on its own KiCon Europe 2026 schedule (2026-09-07/09). The *code* claim survives (no web/WASM repos); the inference was stale.
21. Minor: Fabrication Toolkit is at **5.3.0** (not 4.5.0); `kicad-python` has **15** PyPI releases (13 since 2024-04), not 12; `deploy_reseed()` starts at line **193**; pcbviewer.app supplier string counts were not reproducible (69/58/56 vs 38/36/31 — cite none); the plugin `kicad_version` histogram sums to 86 of 91 (5 declare none); KiCanvas's highest-starred non-original repo is **0** stars.

---

## 8. Still unverified

- **Whether Altium 365's Octopart price column actually populates for a KiCad-sourced BOM.** Highest-value unknown in the packet. KiCad symbols carry no MPN by KLC rule, and Altium labels KiCad "Beta" — if the column is sparse, the positioning can widen. Test: upload a real `.kicad_pro`/`.kicad_sch` and look at the BOM tab.
- **Whether PCBWay's "Layerstack Data View" populates from a `.kicad_pcb` stackup block** or only from Altium/ODB++/IPC-2581. ~20 minutes to settle; decides whether the stackup panel is a differentiator at all.
- **Production row count of `outbound_clicks`** — never measured. Decides whether the sponsor pitch clears the 30-click floor.
- **Visual rendering fidelity** of KiCad 9/10 files. Parsing is proven; the test browser had no WebGL2 at all, so not one pixel was seen. Whether the dropped `tenting`/`covering`/`plugging`/`capping`/`filling` tokens cause visibly wrong mask or via artwork is open and needs a GPU-capable browser.
- **Whether the two font patches build and run.** The 2,480 B subset was measured but never rendered; the icon codepoint map was never written.
- **Which Newstroke license characterisation is authoritative** (GPL-2.0-or-later header vs `LICENSE.md`'s CC0/MIT-like). Upstream KiCad's license file returned 404 on four candidate paths.
- **The `generateBOMExternal` action** — present in both KiCad 10.0 and master `sch_actions.cpp`, no handler found; unauthenticated GitLab blob search returns 401. It is the one thing that could refute "a generator cannot self-register", which the whole distribution argument rests on.
- **Whether option B (write a file, open a URL, never connect) clears the PCM Commercial Services clause.** The clause's first sentence ("Packages that link to or provide commercial services") and the FAQ carve-out are in genuine tension; only `package@kicad.org` resolves it.
- **Whether the Legacy BOM generator survives to KiCad 11 *release*.** Present on master today — far stronger than "no deprecation notice found", but not a guarantee.
- **PCM install/download counts** — confirmed absent from repository metadata; whether the KiCad team holds them privately is unknown. Star counts are a proxy of unknown fidelity.
- **Reddit audience size and subreddit rules** — blocked on 5/5 attempts by both researcher and verifier. Model at zero.
- **Any true traffic figure for any competitor.** Tranco is a domain-popularity proxy and attributes whole domains (altium.com's 12,647 is Altium the company).
- **Whether pcbviewer.app's supplier price fetch returns live results**, and whether Huaqiu ecad-viewer's BOM carries prices or its 2D half runs without the kicad-cli sidecar (open since 2026-08-19).
- **Cloudflare R2's checkout**: whether a payment method is mandatory for $0 usage. Both agents read the same two non-committal sentences.
- **Whether this AWS account's 12-month Legacy Free Tier window is open.** Account creation date never queried; immaterial at $0.01–$0.58/month.
- **`bytea` bloat/VACUUM behaviour** under a real delete-and-resave workload, and peak RSS/CPU of gzipping in the FastAPI process on a box with ~70 MB free — both unmeasured, and both become moot if compression happens in the browser via `CompressionStream`.
- **What was actually said in the PCBJam KiCon talk.** No recording or slides found; if pricing integration was announced, the threat window is shorter than assumed.
- **Everything in §§2–5 of the 2026-08-19 packet** (licensing, kicad-cli cost on the box, tracespace/Gerber, 3D) — read, cited as prior work, not re-verified today.
