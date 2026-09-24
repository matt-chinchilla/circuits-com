# Demand: which PCB tools people use, and which files they would drop on /viewer

Research date: 2026-09-24. Raw captures: `demand-src/` (search JSON, scraped pages, API dumps).
Method: Firecrawl search/scrape first; chrome-devtools for Indeed (then Cloudflare blocked it); free public APIs
(GitHub code search, Stack Exchange, Hacker News Algolia, Wikimedia pageviews, Homebrew, Flathub, Discourse) for hard counts.

## Bottom line

- **Professionals mostly use Altium, then Cadence (Allegro/OrCAD), then Siemens (Xpedition/PADS).** KiCad is fifth in the
  professional survey (about 16% use it weekly) and first everywhere else: open hardware, hobby, Q&A mindshare and installs.
- **Public design files are mostly KiCad**, and a large share of them are **legacy KiCad 4/5** files. /viewer refuses those
  today. By file count the legacy KiCad files outnumber EAGLE, Altium and EasyEDA files on GitHub.
- **EAGLE stopped working on 2026-06-07.** There is a large archive of EAGLE files (SparkFun, Adafruit and many
  open-hardware repos), and their owners can no longer open them in EAGLE itself. That is a demand spike right now.
- **Gerber + Excellon is the one format every tool can export.** Every competing web viewer accepts it, but it carries
  almost no BOM data.
- **EasyEDA is huge in absolute users** (4.48M users, and JLC reports 9.5M registered users), but the design files mostly
  stay in EasyEDA's cloud, so relatively few are public.
- The closest competitor is **Altium 365 Viewer**: free, in the browser, with a BOM priced through Octopart. It accepts
  Altium, EAGLE, KiCad (including legacy), CircuitStudio, Gerber and ODB++. PCBWay's viewer accepts the same core set.
  Together they show what the market expects a viewer to open.

## Ranked list: likely demand for Circuit Center's /viewer

Ranking weighs (a) how many visitors own such files, (b) whether they can already open them elsewhere (need), and
(c) whether the file gives the BOM / pricing hook the site monetises. Cost to build is covered by other slices.

| # | Format family | Why |
|---|---|---|
| 0 | KiCad 6–10 (`.kicad_pro/.kicad_sch/.kicad_pcb`) | Supported today. The largest public population (115k `.kicad_pro` project files on GitHub). |
| 1 | **Altium Designer** (`.PrjPcb/.SchDoc/.PcbDoc`, plus CircuitStudio/CircuitMaker) | #1 professional tool (about 50% weekly use, PCD&F 2026); 61k subscription seats and more than 100k users (FY23). Both competing viewers support it first. Best BOM data (parameters, MPNs). |
| 2 | **Gerber RS-274X / X2 + Excellon drill** (zip) | Every tool exports it; most fab uploaders take it. Low BOM value (X2/X3 attributes at most). |
| 3 | **Autodesk EAGLE / Fusion Electronics** (`.sch/.brd` XML) | End of life 2026-06-07 and licensing turned off. About 46k EAGLE boards on GitHub. Fusion still exports EAGLE-format files. |
| 4 | **KiCad 4/5 legacy** (`.pro/.sch/.lib`, `.kicad_pcb` v4/20171130) | 83k legacy `.sch` and 44k legacy `.pro` files on GitHub, all refused by /viewer today. Owners can re-save in free KiCad, so the need is lower than EAGLE's, but the volume is the largest. |
| 5 | **EasyEDA Std / Pro** (`.json`, `.epro`/`.eprj`) | 4.48M users (June 2024); JLC 9.5M. Hobby and Asia. Few public files; BOMs carry LCSC and MPN fields. |
| 6 | **Cadence OrCAD Capture** (`.dsn/.opj`) + **Allegro/OrCAD PCB** (`.brd`) | Allegro about 35% and OrCAD about 18% weekly use in the professional survey. Binary formats. AllSpice and Altium 365 both added OrCAD. |
| 7 | **IPC-2581** (`.xml`/`.cvg`) | One open, XML handoff that Altium, Cadence, Siemens and KiCad all export. It includes a BOM section. A single reader would cover professional boards. |
| 8 | **ODB++** (`.tgz` directory tree) | Accepted by Altium 365 Viewer and PCBWay; the dominant CAM handoff; includes component data. |
| 9 | **Siemens PADS** (`.asc` ASCII, `.pcb/.sch` binary) + **Xpedition** (DB, no single file) | Xpedition about 18% weekly use (professional); PADS common in SMBs. Xpedition has no droppable single file, so IPC-2581/ODB++ is the practical route. |
| 10 | Proteus (`.pdsprj`) | Education (India/UK/embedded courses): 48 SE questions since 2024; 19.3k Wikipedia views in 2025. |
| 11 | DipTrace (`.dip/.dch`) | A small professional/hobby niche with its own EEVblog board (149 topics). |
| 12 | Fritzing (`.fzz`) | Maker/education: 97.7k Flathub installs, but little BOM value (breadboard parts). |
| 13 | Flux (cloud; exports) | Startup AI mindshare (56 HN mentions since 2024), but the designs live in Flux's cloud. |
| 14 | LibrePCB (`.lpp`), Horizon EDA, gEDA/Lepton | Open-source niches (LibrePCB 110k Flathub installs). |
| 15 | Zuken CR-8000/CADSTAR, Pulsonix, DesignSpark PCB, Multisim/Ultiboard, Sprint-Layout, TARGET 3001! | Regional or niche. Serve them through IPC-2581/ODB++/Gerber rather than native readers. |
| — | BOM CSV/XLSX from any tool | Already accepted by /bom. Point Altium/OrCAD/PADS users there as the fallback until native readers exist. |

## Evidence (source, date, bias)

### 1. Professional segment: PCD&F / PCEA 2026 Salary Survey (summer 2026)
"About half of respondents use Altium Designer at least weekly … followed by Cadence Allegro at roughly 35%. Siemens
Xpedition and Cadence OrCAD each draw weekly use from about 18% of respondents, while roughly 16% use KiCad. Designers
also report … Siemens HyperLynx and Pads, Cadence Sigrity and several Zuken platforms."
https://www.pcdandf.com/pcdesign/index.php/editorial/menu-features/19472-pcb-designers-earn-more-do-more-the-2026-compensation-picture
Bias: self-selected, dedicated PCB designers (not general EEs). Nearly half work at companies with more than 1,000
employees, and about one third are in government, military or aerospace, which over-weights Cadence and Siemens. N is not
published.

### 2. Vendor numbers
- Altium FY2023 annual report: "More than 100,000 users employ Altium Designer"; subscription seats 61,159 (June 2023);
  Altium 365 had more than 36,700 monthly active users (Aug 2023); China revenue down 8% (US$19.5M).
  https://cdn.files.altium.com/sites/default/files/2023-09/2023%20Annual%20Report_0.pdf. Renesas bought Altium for about
  US$5.9B (2024): https://www.altium.com/company/newsroom/press-releases/renesas-acquire-pcb-design-software-leader-altium-make-electronics
  (vendor self-report).
- EasyEDA: "As of June 2024, EasyEDA has empowered 4.48 million users globally to complete over 23.62 million designs"
  https://oshwlab.com/activities/certificate (vendor claim; "users" means registrations).
- JLC Technology Group (owner of EasyEDA, JLCPCB and LCSC): "By the end of 2025, the platform had accumulated over 9.5
  million registered users … 180 countries"; more than 21M orders in 2025.
  https://jlcpcb.com/news/jlc-digital-manufacturing-announces-public-listing (IPO document; counts the whole manufacturing
  platform, not EDA alone).
- HQ/NextPCB (KiCad platinum sponsor): a "community of over 6 million Chinese engineers, many of whom are KiCad users";
  "rapid increase in [KiCad's] Chinese user base". https://www.nextpcb.com/blog/kicon-asia-2025-summary (sponsor, not
  neutral).
- KiCad publishes **no download or user counts** (searched; none found). Activity instead: 7,609 commits and 2,105 merge
  requests in 2025. https://www.kicad.org/blog/2026/03/Version-10.0.0-Released/ . KiCad 10 adds an **Altium project
  importer** (Seth Hillbrand, KiCon Asia 2025 slides:
  https://www.nextpcb.com/uploads/attach/blog/1.%20Seth%20Hillbrand%20-%20KiCad%20Project%20Status.pdf), which shows the
  KiCad project itself sees Altium as the main source of migrating users.

### 3. EAGLE end of life
Autodesk: "June 7th, 2026: EAGLE entitlement will no longer be available nor supported … The licensing for EAGLE will no
longer be active." EAGLE files remain "fully compatible with Autodesk Fusion electronics".
https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Autodesk-EAGLE-Announcement-Next-steps-and-FAQ.html
Fusion can still export to the EAGLE 9.x format:
https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-open-Fusion-PCB-project-in-EAGLE.html
Migration threads: https://forum.kicad.info/t/autodesk-will-no-longer-sell-nor-support-eagle-in-2026/44354 ,
https://community.sparkfun.com/t/autodesk-eagle-is-end-of-life/45787
Read: as of today (about 3.5 months after end of life), anyone holding `.brd/.sch` files who does not pay for Fusion has no
Autodesk way to view them. That is a need a free browser viewer can meet.

### 4. What files exist publicly: GitHub code-search census (2026-09-24, measured)
Legacy code search. Counts are GitHub's estimates. Only text files under 384 KB are indexed, and **binary files are mostly
not indexed**, so Altium `.PcbDoc/.SchDoc`, OrCAD `.dsn`, Allegro `.brd`, Proteus and ODB++ are undercounted and the
project-file proxies are the better signal. The count is biased to open source (KiCad-heavy). Files: `demand-src/gh-ext*.txt`.

| Query | Count | Reads as |
|---|---|---|
| `extension:kicad_pro` | 115,200 | KiCad 6+ projects |
| `extension:kicad_sch` | 161,024 | KiCad 6+ sheets |
| `extension:kicad_pcb` | 89,088 | all KiCad ≥4 boards |
| `…kicad_pcb "(version 4)"` / `"20171130"` | 11,232 / 18,112 | **KiCad 4 / KiCad 5 boards (refused today)** |
| `…kicad_pcb "20211014"/"20221018"/"20240108"/"20241229"` | 8,192 / 11,520 / 23,552 / 12,384 | KiCad 6 / 7 / 8 / 9 boards |
| `…kicad_sch "20211123"/"20230121"/"20231120"/"20250114"` | 21,056 / 34,432 / 38,272 / 51,072 | KiCad 6 / 7 / 8 / 9 sheets |
| `extension:sch "EESchema Schematic File"` | 83,328 | **KiCad ≤5 sheets (refused today)** |
| `extension:pro pcbnew` | 43,968 | KiCad ≤5 projects |
| `extension:brd "eagle.dtd"` | 45,952 | EAGLE boards |
| `extension:sch "eagle.dtd"` | 24,640 | EAGLE schematics |
| `extension:lbr` | 43,968 | EAGLE libraries (mostly) |
| `extension:PrjPcb` | 16,640 | Altium projects |
| `extension:SchDoc` / `PcbDoc` | 1,148 / 732 | Altium (binary; undercounted) |
| `extension:json "editorVersion" "docType"` | 13,696 | EasyEDA Std sources (proxy, noisy) |
| `extension:epro` | 292 | EasyEDA Pro |
| `extension:opj` / `dsn` | 2,512 / 10,096 | OrCAD projects / `.dsn` (the `.dsn` count also includes Specctra autorouter files) |
| `extension:dip` | 1,008 | DipTrace |
| `extension:pdsprj` | 220 | Proteus (binary) |
| `extension:fz "fritzing"` | 514 | Fritzing (the zipped `.fzz` is not indexed) |
| `extension:xml "IPC-2581"` | 390 | IPC-2581 |
| `extension:gbr` | 318,464 | Gerber layers |
| `…gbr "TF.GenerationSoftware"` | 241,664 | Gerber X2 layers |
| …of which `,KiCad` / `,Altium` / `,Autodesk` | 216,064 / 10,768 / 820 | 89% of public X2 Gerbers come from KiCad |
| `extension:gtl` / `gbl` / `drl` / `xln` | 31,744 / 31,040 / 94,720 / 3,028 | Protel-style Gerbers / drill |
| `extension:csv "Designator" "Quantity"` | 20,803 | exported BOM CSVs |

GitHub repository topics (`demand-src/gh-topics.txt`): kicad 4,615 · pcb-design 1,993 · eagle 558 + eagle-cad 271 ·
altium 413 + altium-designer 446 · easyeda 329 · gerber 168 · orcad 40 · librepcb 36 · diptrace 25 · pads 19 ·
cadence-allegro 2.

### 5. Mindshare and installs (free APIs, measured 2026-09-24)
- Stack Exchange electronics, questions **created since 2024-01-01** by tag: altium 211 · kicad 112 · proteus 48 ·
  eagle 12 · orcad 11 · easyeda 6 · allegro 5 · diptrace 0 (all-time: altium 1,724, eagle 987, kicad 639, proteus 479,
  orcad 204). The site skews professional and Q&A, and Altium's steeper learning curve generates questions.
- EEVblog forum EDA boards (all-time topics/posts): Altium 1,939/15,090 · KiCad 685/7,942 · EAGLE 381/4,287 ·
  DipTrace 149/1,243. https://www.eevblog.com/forum/ . KiCad has its own forum, which drains the EEVblog count: 18,119
  users, 982 active in the last 30 days, 321,706 posts (https://forum.kicad.info/about.json).
- Hacker News stories and comments since 2024-01-01: kicad 963 · altium 272 · flux.ai 56 · easyeda 45 · librepcb 27 ·
  orcad 24 · horizon eda 19 (startup/software-engineer skew).
  HN "Who is hiring" (33 threads, 16,425 postings): Altium 8 · KiCad 4 · the rest about 0. Too small to rank on.
- Wikipedia (en) pageviews, calendar 2025: KiCad 53,959 · Gerber format 36,513 · EAGLE 24,130 · EasyEDA 19,399 ·
  Proteus 19,349 · Altium Designer 18,374 · OrCAD 16,114 · Fritzing 13,869 · ODB++ 10,797 · DipTrace 5,625 ·
  Excellon 459. (Curiosity and education skew.)
- Homebrew cask installs, last 365 days (macOS only): kicad 13,252 · autodesk-fusion 4,020 (mostly mechanical CAD) ·
  librepcb 640 · easyeda 238 · eagle 227. https://formulae.brew.sh/api/analytics/cask-install/365d.json
- Flathub total installs (Linux only): KiCad 318,002 (7,900 last month) · LibrePCB 109,996 · Fritzing 97,731 ·
  Horizon EDA 11,946 · EasyEDA Pro 9,421.
- US jobs: Indeed showed "2,000 Altium jobs in United States" before Cloudflare blocked further queries (one data point).
  LinkedIn's public counts are **unusable**: every quoted tool name returned 8,000–11,000 results, including "EasyEDA",
  so the search is fuzzy.

### 6. What comparable tools accept (the market's revealed choice)
- **Altium 365 Viewer** (free, in the browser, BOM priced through Octopart; the most direct competitor): Altium
  `.SchDoc/.Sch/.PcbDoc/.Pcb`; EAGLE `.sch/.brd` (6.4+ XML only); KiCad `.pro/.sch/.kicad_pcb/.lib` (legacy plus board);
  CircuitStudio; Gerber X2/RS-274X + NC drill; ODB++. Zip/Rar/7z up to 200 MB. "You can even vote for which design
  format you would like to see supported next."
  https://www.altium.com/documentation/altium-365/viewers/standalone-viewer
- **PCBWay Online Electronics Design Viewer**: "SchDoc/PcbDoc/SCH/BRD/Gerber/ODB++/Package (ZIP, 7z, RAR)" and KiCad
  `.pro/.sch/.kicad_pcb/.lib`. https://www.pcbway.com/tool/ElectronicDesignViewer
- **OSH Park**: drag-and-drop KiCad `.kicad_pcb`, EAGLE `.brd`, or zipped Gerbers. https://oshpark.com/ ,
  https://docs.oshpark.com/design-tools/kicad/
- **AllSpice** (hardware git/design review, professional/startup): Altium (`.schdoc/.pcbdoc/.prjpcb/.schlib/.pcblib`),
  OrCAD `.dsn/.opj`, Cadence System Capture `.sdax/.cpm`, Allegro `.brd`, KiCad, Xpedition `icdb.dat`/`.prj`.
  https://learn.allspice.io/docs/what-file-formats-do-you-support
- Altium 365 added OrCAD multi-CAD support:
  https://resources.altium.com/p/orcad-design-collaboration-in-altium-365

## By segment

| Segment | Tools actually used | What they would drop |
|---|---|---|
| Enterprise / defence / automotive | Cadence Allegro + OrCAD, Siemens Xpedition, Altium Enterprise, Zuken | Rarely native files (IP/NDA); ODB++ / IPC-2581 / Gerber; BOM CSV. The "never leaves your browser" promise is the unlock. |
| Mid-size professional / consultancies | Altium dominant, OrCAD, PADS, some KiCad | Altium zip, OrCAD `.dsn`, Gerber; BOM CSV. |
| Startups | Altium (funded) or KiCad (lean); Flux emerging | KiCad and Altium; Gerbers for quotes. |
| Hobby / maker / open hardware | KiCad (dominant), EasyEDA (JLC loop), legacy EAGLE, Fritzing | KiCad (including legacy 5), EAGLE archives, EasyEDA exports, Gerber zips. |
| Education | Multisim/Ultiboard (N. America labs), Proteus (India/UK/embedded courses), Altium student licences, KiCad, Fusion edu, Fritzing/Tinkercad | Proteus, KiCad, Altium; low purchasing intent. |
| China / Asia | EasyEDA (嘉立创EDA), pirated Altium, rapidly growing KiCad (HQ distribution) | EasyEDA Pro, Altium, KiCad. |

## Not found / could not be measured
- AspenCore/Embedded.com Embedded Markets Study 2023: no PCB/ECAD tool question (scraped; no hits).
  https://www.embedded.com/wp-content/uploads/2023/05/Embedded-Market-Study-For-Webinar-Recording-April-2023.pdf
- No Hackaday/Hackster tool poll with published percentages was found. Reddit API subscriber counts were blocked.
- Paid market reports (Research Nester, SNS Insider and similar) are paywalled and methodologically opaque; ignored.
- KiCad has no public download or user numbers.

## Recommendation that follows from the data
Measure real demand on circuitcenter.ai itself. When /viewer refuses a drop, record only the file **extension and detected
signature** (for example `pcbdoc/OLE`, `brd/eagle-xml`, `sch/eeschema-legacy`, `zip/gerber`). Never record content or names,
so the "your design files never leave your browser" wording stays true. Two weeks of that counter will outrank every proxy above.
