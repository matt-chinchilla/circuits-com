# Web, cloud and hobby EDA formats: dossier for the /viewer

Scope: EasyEDA Standard and Pro (every generation), the LCSC/JLCPCB ecosystem, Flux.ai, Upverter, gEDA/Lepton (plus pcb-rnd and sch-rnd), Horizon EDA, LibrePCB, Fritzing, DipTrace, Proteus, NI Multisim/Ultiboard, QucsStudio (now uSimmics), Qucs-S. Also covered because they fall in the same hobby space: Sprint-Layout, tscircuit Circuit JSON, and a note on T/DISA 4001.
Researched 2026-09-24. Most facts were checked against primary sources: the KiCad source tree through the GitLab API, KiCad dev-docs, vendor docs, parser repositories with their licence and last-push dates, and the npm registry. Every line-count and tag claim below was measured, not assumed.

---

## 0. What this means for the viewer

Our renderer (KiCanvas) and our reader both expect KiCad 6+ S-expression files. The cheapest way to support any new format is to convert it to `.kicad_sch`/`.kicad_pcb` text inside the browser. KiCanvas, the BOM, the stackup and 3D tabs then work with no changes, and the design files still never leave the browser. KiCad's own importers are GPL-3.0-or-later, the same licence as our programme, so porting one to TypeScript is legally clean. Each port is a 1.5k–10k-line C++ job.

Formats that already have a KiCad importer:

| Format | KiCad import | KiCad version | Evidence |
|---|---|---|---|
| EasyEDA Std `.json`/`.zip` (sch + pcb + libs) | yes | **8.0** (commit 21ee65aa, 2023-09-07; release notes) | `pcbnew/pcb_io/easyeda`, `eeschema/sch_io/easyeda`; kicad.org/blog/2024/02/Version-8.0.0-Released |
| EasyEDA Pro v2 `.epro`/`.zip`, `.elibz`, `.esym`, `.efoo` | yes | **8.0** | same commit; dev-docs import-formats/easyeda |
| EasyEDA Pro v3 `.epro2`/`.zip`, `.elibz2` | yes | **master only** (commit 3f8d1e5e, 2026-07-18). Not in 10.0.6 (`common/io/easyedapro` there has no v3 parser), so expected in KiCad 11 | GitLab tree/commits |
| EasyEDA Pro `.eprj`/`.eprj2` (SQLite), `.eprj3` (folder) | **no** | — | `IsV3Archive` accepts only `.epro2`/`.zip` containing `project2.json` + `.epru` |
| gEDA/Lepton `.sch`/`.sym` and gEDA PCB `.pcb` | yes | **10.0** (commit e12751da, 2026-02-11; in the 10.0.0 tag, 2026-03-19). 9.0 read `.fp` footprints only | kicad.org/blog/2026/02/Three-New-Importers…; dev-docs import-formats/geda |
| DipTrace binary `.dch` + `.dip` | yes | **master only** (commit e38afe94, 2026-05-31), expected in KiCad 11 | `pcbnew/pcb_io/diptrace`, `eeschema/sch_io/diptrace` (includes Kaitai `.ksy` specs) |
| Sprint-Layout `.lay6`/`.lay` (+ `.lmk` libs) | yes | **master only** (commit e4c1fc82, 2026-03-20) | `pcbnew/pcb_io/sprint_layout` (includes `.ksy`) |
| DipTrace ASCII `.asc`, LibrePCB, Horizon, Fritzing, Proteus, Multisim/Ultiboard, Qucs, Flux `.flx`, Upverter | **no** | — | master `pcb_io/` = allegro altium autotrax cadstar diptrace eagle easyeda easyedapro fabmaster geda ipc2581 kicad_* odbpp pads pcad sprint_layout; `sch_io/` = altium cadstar database diptrace eagle easyeda easyedapro geda http_lib kicad_* ltspice orcad pads pcad |

The KiCad master tree also has new importers for `autotrax`, `orcad` (sch) and `pcad` (sch) that are not in 10.0.x. They belong to other slices; this is passed along for them.

**Suggested order for this slice, by value per effort:**

1. **EasyEDA Std + Pro v2 + Pro v3.** EasyEDA claims 6.58M users (easyeda.com). The formats are text/JSON, the vendor publishes specs (Pro v3 has an MIT-licensed "format skill" repo), KiCad's GPL importers exist to port, and the parts carry `Manufacturer Part` and LCSC `Supplier Part`, so the BOM can be priced.
2. **DipTrace ASCII `.asc`.** A plain parenthesized text export that carries `(Manufacturer …)` and `(Value …)`. It is a small, self-contained parser, whereas the binary `.dip`/`.dch` path needs the 10k-line KiCad master port.
3. **LibrePCB `.lppz` and Horizon.** Both open GPL formats, with MPNs as a first-class field and self-contained projects.
4. **gEDA/Lepton.** Port from KiCad 10, but symbols live outside the file, so we would ship the builtin fallback set.
5. **Fritzing.** Very popular (4.8k stars), but core part graphics are not in the `.fzz`, and bundling the CC-BY-SA 3.0 parts library is a licensing question.
6. **Proteus, Multisim/Ultiboard.** Proprietary binaries with young community parsers. Ask users for Gerber/ODB++ instead, which those tools export.
7. **Flux, QucsStudio/uSimmics, Qucs-S, Upverter.** No path, or low value: native files are undocumented or simulation-only. Ask for exports (Flux gives a BOM CSV with MPNs, Gerber and IPC-2581C).

---

## 1. EasyEDA Standard (a.k.a. JLCEDA/LCEDA Standard)

- **Extensions / container:** `.json` (one document) or `.zip` (project download: several JSON docs; a PCB must be zipped with its schematic). Source: dev-docs.kicad.org/en/import-formats/easyeda; prodocs.easyeda.com/en/faq/import-export.
- **Detect:** JSON object whose `head.docType` (int or numeric string) is 1 = schematic sheet, 2 = symbol, 3 = PCB, 4 = footprint, 5 = schematic list (`schematics[]`), 14 = PCB module. `shape` is an array of `~`-delimited strings (`LIB~…`, `W~…`, `N~…`, `TRACK~…`). Multi-line shapes are joined with `#@$`/`@$`, and pin sub-parts with `^^`. KiCad `FindBoardInStream` checks exactly this.
- **Contains:** schematic sheets with symbol geometry **embedded** in `LIB` compounds (self-contained). PCB with footprints, tracks, copper areas and `dataStr.layers` + `DRCRULE`. Libraries. No stackup beyond the layer list.
- **Parts:** the `LIB` params and `head.c_para` carry `Manufacturer Part`, `Manufacturer`, `Supplier Part` (LCSC C-number), `Supplier`, `BOM_*` variants and `LCSC Part Name`. KiCad's schematic importer whitelists exactly these as fields (`sch_easyeda_parser.cpp` `c_attributesWhitelist`). **Good BOM value**: parts placed from the LCSC/JLC library carry a real MPN plus a C-number.
- **Spec:** vendor docs at docs.easyeda.com/en/DocumentFormat/0-EasyEDA-File-Format-Index (docs © EasyEDA, no explicit licence). KiCad dev-docs has a detailed reverse description (shape layouts, units: sch = value×10 mil, pcb = 10-mil units).
- **Parsers:**
  - KiCad `eeschema/sch_io/easyeda` + `pcbnew/pcb_io/easyeda` + `common/io/easyeda`. C++, GPL-3.0-or-later, ~3.25k lines (measured: 1642 sch, 1188 pcb, 423 common). Active (last commit 2026-09-12).
  - tscircuit/easyedats. TypeScript parser, serializer and SVG renderer for Std sch + pcb, including docType 5. **No LICENSE file** (GitHub `license: null`), last push 2026-08-04. Unusable until licensed; ask tscircuit (their other repos are MIT).
  - wokwi/easyeda2kicad (npm `easyeda2kicad` 1.9.5). TypeScript, MIT (one Apache-2.0 file), **unmaintained** (README says so), last publish 2021-11-28. PCB → `.kicad_pcb`. The output version is probably older than our reader's floor (20211014); needs a check.
  - tscircuit/easyeda-converter (npm `easyeda` 0.0.360, MIT, published 2026-09-17). Footprint JSON → Circuit JSON only, not whole designs.
  - RigoLigoRLC/LC2KiCad. C++, LGPL-3.0, 146★, last push 2024-02-07. EasyEDA docs → KiCad 5. WASM-able, but the KiCad 5 output is too old.
  - pcb-rnd `io_easyeda` (C, GPL-2+, "works" for std board + footprint) and sch-rnd (netlist import of EasyEDA std multi-page schematics). repo.hu/projects/pcb-rnd/user/09_appendix/formats.html; packages.debian.org/sid/sch-rnd.
  - Component-level only (these fetch one LCSC part, not a design): uPesy/easyeda2kicad.py (Python, **AGPL-3.0**, 1.67k★), TousstNicolas/JLC2KiCad_lib (MIT), EasyKiconverter/EasyKiConverter (C++, GPL-3.0).
- **KiCad import:** 8.0+, sch + pcb + libs, read-only. Limitations per dev-docs: rounded rectangles lose radius, ellipses become circles, dimensions become grouped lines, 3D paths hard-coded to `${KIPRJMOD}/EASYEDA_MODELS/`, and no project-level import for Std.
- **Browser path:** port KiCad's GPL importer to TS, emitting KiCad S-expr text, then KiCanvas and the reader as today. The BOM can also be read **directly** from the JSON with no conversion: walk `LIB` params for designator, value, `Manufacturer Part` and `Supplier Part`. That is a small first step that prices a BOM before the drawings render.
- **Licensing:** KiCad port = GPL-3.0-or-later, compatible. AGPL easyeda2kicad.py: GPLv3 §13 allows combining, but the AGPL part keeps its network-source obligation; avoid it (it is component-level anyway). The easyeda.com component API that easyeda2kicad calls is an undocumented vendor endpoint; do not depend on it from the browser (ToS and CORS).
- **Effort:** **M**. A BOM-only reader is S (a few hundred lines of TS). Full sch + pcb render via a port of ~3.3k lines of C++ is M.

## 2. EasyEDA Pro v2 (`.epro`, 2.x; also JLCEDA Pro)

- **Extensions:** `.epro` (renamed ZIP project), `.zip`, `.elibz` (library ZIP), `.esym`, `.efoo` (single symbol/footprint). Inside the ZIP: `project.json` (manifest: schematics, boards, pcbs, devices, symbols, footprints), `*.esch`, `*.epcb`, `*.esym`, `*.efoo`, `*.ecop` (poured copper), `*.eblob` (images); `device.json`/`symbol.json`/`footprint.json` in `.elibz`. Source: dev-docs import-formats/easyeda.
- **Detect:** ZIP (`PK\x03\x04`) with a root `project.json` (KiCad `CanReadBoard` checks the `.epro`/`.zip` extension, then `project.json`). Inner docs are JSON Lines: each line is a JSON **array** whose first element is a type string. In `.efoo`, a blank line separates footprint data from PCB data.
- **Contains:** full schematic (multi-sheet), PCB with poured copper, embedded device/symbol/footprint copies, 3D model references (`3D Model`, `3D Model Transform`).
- **Parts:** `project.json` `devices[*].attributes` holds `Symbol`, `Footprint`, `3D Model` plus custom attributes. KiCad's Pro importer whitelists `Value, Datasheet, Manufacturer Part, Manufacturer, BOM_Manufacturer Part, BOM_Manufacturer, Supplier Part, Supplier, BOM_Supplier Part, BOM_Supplier, LCSC Part Name` (`easyedapro_import_utils.cpp`). **Good BOM value.**
- **Spec:** vendor V2.2 spec ZIP (lceda-pro-file-format-v2.2_2022.12.15.zip, "not the latest… contains most of the format details") at prodocs.easyeda.com/en/format/index.
- **Parsers:** KiCad `common/io/easyedapro` + `sch_io/easyedapro` + `pcb_io/easyedapro` (C++, GPL-3.0-or-later, ~4.7k lines measured: 299 + 973 + 1454 + 1943). pcb-rnd `io_easyeda` reads the "EasyEDA pro board". No JS parser found.
- **KiCad import:** 8.0+. Offers a project chooser when an archive holds several boards. Limitations: `.ecop` pours disabled by default, some rotations limited to 90°, per-unit symbol attributes only for unit 1, standalone `.esym` import partially disabled.
- **Browser path:** unzip with fflate (already in our stack), port the KiCad parser to TS, emit S-expr. BOM-only reading of `project.json` + component attributes is small.
- **Licensing:** clean (GPL port; vendor-published spec).
- **Effort:** **M–L** (JSON-lines geometry types are numerous; ~4.7k C++ lines).

## 3. EasyEDA Pro v3 (`.epro2`, `.elibz2`)

- **Container:** ZIP with `project2.json` + one or more `.epru` log documents. Libraries: `.elibz2` ZIP with `symbol2.json`/`footprint2.json`/`device2.json` + `.elibu`. Source: KiCad `common/io/easyedapro/easyedapro_v3_parser.cpp` (`IsV3Archive`, `IsV3Library`).
- **Detect:** extension `.epro2`/`.zip`, and the ZIP holds `project2.json` **and** at least one `*.epru`. Each `.epru` line has the form `{outer-json}||{inner-json}|`, and a `{"type":"DOCHEAD"}` line starts each document (`docType` ∈ PROJECT_CONFIG, BOARD, SCH, SCH_PAGE, PCB, PANEL, SYMBOL, FOOTPRINT, DEVICE, BLOB). Records carry `id`, `ticket`, `type`. The file is an append-only change log, deduplicated by id. The vendor spec says v3 "uses the concept of logs for incremental storage… key-value style". Source: prodocs.easyeda.com/en/format/index.
- **Parts:** DEVICE docs hold attributes (same whitelist). V3 renamed some pin attributes (`Pin Name`/`Pin Number` vs `NAME`/`NUMBER`). **Good BOM value.**
- **Spec:** vendor V3 spec (lceda-pro-file-format-v3_2025.10.21.{zip,md,pdf}), plus github.com/easyeda/easyeda-pro-file-format (no licence file) and **github.com/easyeda/easyeda-pro-format-skill (MIT, official, pushed 2026-09-22)**.
- **Parsers:** KiCad master only: `easyedapro_v3_parser.cpp` 729 lines + `sch_easyedapro_v3_parser.cpp` 1904 + `pcb_io_easyedapro_v3_parser.cpp` 1702 (C++, GPL-3.0-or-later). Nothing else found.
- **KiCad import:** master (future 11.0). **Not in 10.0.6.** Users on current KiCad cannot import v3 today, which is a gap we could fill first.
- **Browser path:** same as v2. Because the `.epru` log has to be replayed (latest record per id wins), port KiCad's `ParseEpruStream` logic exactly.
- **Effort:** **M–L**. Shares its geometry mapping with v2, so doing v2 and v3 together is cheaper.

## 4. EasyEDA Pro offline projects: `.eprj` / `.eprj2` (SQLite) and `.eprj3` (folder)

- `.eprj`/`.eprj2`: "stores an entire project inside a single SQLite database file" (github.com/easyeda/easyeda-pro-eprj3-format README). Detect by the `SQLite format 3\0` header. The FAQ says epro (online) and eprj (offline) "cannot be converted to each other in one mode". No KiCad import; a KiCad forum thread shows users hitting this (forum.kicad.info/t/…/55725).
- `.eprj3` (new, 2026): a folder with `<name>.eprj3` (index), `sch/<schematic>/<sheet>.esch2`, `.ecfg` (rules), `.evar` (variants), `pcb/<pcb>.epcb2`, `panel/<panel>.epan2`. The records are the same `{…}||{…}|`-style JSON records with `type` = DOCHEAD, META, COMPONENT, ATTR, WIRE, NETLABEL, PORT, TEXT, OBJ. Devices, symbols and footprints are stored as files inside the project. Nothing reads it except EasyEDA.
- **Browser path:** `.eprj3` arrives as a dropped folder or a zip, and is the same record grammar as v3, so it should reuse the v3 port. `.eprj` SQLite would need sql.js (SQLite→WASM, MIT) plus an undocumented schema, so **defer it and ask users to export `.epro`/`.epro2`**.
- **Effort:** `.eprj3` **S–M** on top of v3; `.eprj` **L** (unknown schema).

## 5. LCSC / JLCPCB ecosystem

- **EasyEDA is the JLC/LCSC house tool.** The Pro exporter writes `.epro`/`.zip`, Altium Designer, and **T/DISA 4001** (a Chinese EDA exchange standard; container not verified in this pass. Flag it for a follow-up). EasyEDA also exports PCB Gerber and ODB++ (prodocs pcb/export-pcb-information). Its desktop "Format Converter" imports Altium/Allegro-OrCAD/PADS/KiCad/EAGLE/EasyEDA and exports only `.zip`/`.epro` (prodocs import-export/easyeda-pro-format-converter).
- **JLCPCB assembly BOM**: CSV/XLS/XLSX with `Comment`, `Designator`, `Footprint`, and in practice an `LCSC Part #` column holding the C-number (jlcpcb.com/help/article/bill-of-materials-for-pcb-assembly; community convention quoted by diptrace.com/forum t=13779). **CPL** (pick-and-place) is `Designator, Mid X, Mid Y, Layer, Rotation`. Our BOM tool already ingests CSV/XLSX. **Recommendation:** add `LCSC Part #`, `LCSC`, `JLCPCB Part #` and `Supplier Part` to `headerAliases` as a *supplier SKU* column (not an MPN), and read an `LCSC` field from KiCad symbols. Bouni/kicad-jlcpcb-tools (MIT, 2.08k★) stamps that field on KiCad designs.
- **OSHWLab** (oshwlab.com) is JLC's public project hub and a source of real EasyEDA sample projects (check each project's licence).
- **Demand:** easyeda.com claims "trusted by 6.58 million engineers… 52 million projects"; kicad-jlcpcb-tools 2.08k★; easyeda2kicad.py 1.67k★.

## 6. Flux.ai (cloud, browser)

- **Native:** `.flx` "Flux Project Format… complete project backup" (docs.flux.ai/reference/data-portability). No public spec. Container not verified. Quilter (a competitor, 2026-06-24) found "no publicly documented importer" for it.
- **Exports:** Gerber RS-274X + NC drill (zip), **BOM zip of CSVs including MPN + manufacturer**, pick-and-place CSV, JEP30 PartModel XML, EDIF schematic netlist, IPC-D-356, IPC-2581C (plan-dependent), STEP (bare board), STL, COLLADA `.dae` (docs.flux.ai/faq/faq-s-about-the-pcb-editor; quilter.ai/blog/migrate-from-flux-ai-pcb-export).
- **Browser path:** no native path. Tell Flux users to drop the **BOM CSV** (the BOM tool prices it today) plus Gerber/IPC-2581 once the manufacturing-format slice lands.
- **Effort:** native **XL/unknown**; the export path costs nothing extra.

## 7. Upverter (Altium-owned, browser)

- Acquired by Altium in August 2017 (Wikipedia citing blog.upverter.com). **upverter.com returned HTTP 502 on 2026-09-24** (checked with curl and Firecrawl); treat it as effectively dead. The historical "OpenJSON" format had converters (upverter schematic-file-converter forks such as machinaut/schematic-file-converter, no licence, 2011; JarrettR/PCBupvE, MIT, 2019).
- **Recommendation:** no support. There is little demand and no live source of files.

## 8. gEDA / Lepton EDA schematic (`.sch`, `.sym`)

- **Container:** line-oriented ASCII. The first line is `v YYYYMMDD N` (e.g. `v 20130925 2`). KiCad's detector checks the `.sch` extension plus this header, because `.sch` collides with KiCad-legacy (`EESchema Schematic File Version`), Eagle XML, Qucs (`<Qucs Schematic …>`) and others.
- **Objects:** `C x y sel angle mirror basename.sym` (component), `N` net, `U` bus, `P` pin, `T` text/attribute, `{ }` attribute block, `[ ]` embedded symbol, `G` picture (optionally base64-embedded).
- **Parts:** attributes are free-form `name=value`. Standard ones are `refdes, value, device, footprint, source (hierarchy), net, slot, numslots, slotdef, description`. **No standard MPN attribute**, so projects that use `mfr`/`mpn`-style attributes do so by local convention. BOM value is **low to medium**.
- **Critical gotcha:** symbols are normally **not in the file**. `C` lines reference `.sym` basenames that are resolved from library paths and `gafrc`. KiCad resolves in this order: embedded `[ ]` → a **builtin symbol set compiled into the importer** (passives, semis, op-amps, 7400 logic, power) → system dirs → `gafrc`/`gschemrc` → a generated rectangular fallback with the correct pin count (dev-docs import-formats/geda). A browser drop must include the project's `.sym` files. Otherwise we fall back to the same strategy.
- **Spec:** community wiki (geda-project.org/wiki file_format_spec; archived at repo.hu). The KiCad dev-docs page gives a full reference.
- **Parsers:** KiCad `eeschema/sch_io/geda/sch_io_geda.cpp` (4,880 lines, GPL-3.0-or-later; embeds gEDA/Lepton symbol text under GPL-2.0-or-later, compatible). Lepton itself (GPL-2.0, last release 1.9.18 on 2022-05-29, repo still pushed 2026-09). sch-rnd imports "geda schematics (v2)". Parse::GEDA::Gschem (Perl).
- **KiCad import:** **10.0**. Single-page per file (hierarchy via `source=`). Complex `slotdef` remaps may be imperfect.
- **Browser path:** port to TS, emit `.kicad_sch`. Include the builtin symbol table (GPL-2+ text, compatible).
- **Effort:** **M–L** (4.9k lines, plus symbol resolution UX).

## 9. gEDA PCB `.pcb` / `.fp`, and pcb-rnd `.lht`

- **gEDA PCB:** ASCII. `# release: pcb 2014…` comment, `FileVersion[…]`, `PCB["name" w h]`, then `Grid`, `Via[]`, `Element[] ( Pin/Pad )`, `Layer(n "name") ( Line/Arc/Polygon )`, `NetList() ( Net() ( Connect("R1-1") ) )`. `[ ]` = new units, `( )` = old. KiCad detects it by a `PCB[` or `PCB(` line. Through-hole vias only, no stackup. **Parts:** `Element` has description, refdes and value only, so **no MPN**.
- **pcb-rnd** (GPL-2+) native "lihata" `.lht`, root `ha:pcb-rnd-board-vN` (pcb-rnd doc/developer/lihata_format). pcb-rnd is itself a big format hub: it reads Altium PcbDoc ASCII (WIP), autotrax, dsn, eagle xml + binary, **EasyEDA std/pro**, hyperlynx, kicad s-expr ≤5, PADS ASCII and gEDA; it writes Gerber, Excellon, IPC-D-356, STL, SVG, etc. (repo.hu/projects/pcb-rnd/user/09_appendix/formats.html).
- **Parsers:** KiCad `pcbnew/pcb_io/geda/pcb_io_geda.cpp` (2,066 lines; a board loader since **10.0**, footprints since before 7). pcb-rnd `io_pcb`.
- **Browser path:** port the KiCad loader. `.lht` has no KiCad importer. A lihata parser is small, but demand is tiny.
- **Effort:** `.pcb` **M**; `.lht` **M** (low priority).

## 10. Horizon EDA (JSON)

- **Container:** a project directory. `<name>.hprj` (JSON, `"type": "project"`), `blocks.json` (block list naming the top block and schematic JSON files), `board.json`, `planes.json`, `pictures/`, and **`pool/`, a project pool into which every used part, package, padstack and symbol is copied** ("since version 2.0… gets copied into the project pool", docs.horizon-eda.org/en/latest/project-pool.html). Everything is plain JSON (src/project/project.cpp). Detect: `.hprj` JSON with `"type":"project"`. Pool items have `"type":"part"`, `"package"`, and so on.
- **Parts:** `Part` JSON has `MPN`, `manufacturer` (each a `[inherit?, value]` pair), `value`, `datasheet`, and `orderable_MPNs` (src/pool/part.cpp). Horizon also has DigiKey API integration (docs digikey-api). **Excellent BOM value.**
- **Exports** (src/export_*): Gerber, **ODB++** (`export_odb`), STEP, PDF, BOM, PnP, 3D image. The Python module exports the same.
- **Parsers:** Horizon itself (C++17/gtkmm, GPL-3.0, 1.32k★, v2.7.2 on 2025-12-05, pushed 2026-09-23). No third-party parser found. **No KiCad importer.**
- **Browser path:** a dedicated TS converter from Horizon JSON (block/schematic/board + pool geometry) to KiCad S-expr. The format is clean JSON with UUID references, but it is a different data model (padstacks, units/entities/gates). For a quick win, read the BOM straight from block + pool parts.
- **Licensing:** code GPL-3.0; horizon-pool is **CC-BY-SA 4.0 with a waiver for designs using it** (horizon-pool LICENSE.md). We need not bundle it, because projects carry their own pool.
- **Effort:** BOM-only **S**; full render **L**.

## 11. LibrePCB (S-expression)

- **Container:** a project directory with `.librepcb-project` (holds the file-format version), `<NAME>.lpp` (an empty marker; MIME magic `LIBREPCB-PROJECT`), `project/metadata.lp`, `project/settings.lp`, `circuit/circuit.lp` (netlist), `circuit/erc.lp`, `schematics/schematics.lp` + `schematics/<n>/schematic.lp`, `boards/boards.lp` + `boards/<n>/board.lp`, and `library/` holding **all library elements used** ("100% self-contained"). `.lppz` = the zipped project (MIME sub-class of zip); `*.lp` element files start with `(librepcb` (share/mime/packages/org.librepcb.LibrePCB.xml; dev/doxygen/pages/project.md; librepcb.org/features/file-format).
- **Versioning:** the format is frozen per major version (v1.x reads v1.0 files). Current releases are 2.0.0 (2026-01-28), 2.1.0 (2026-05-19) and 2.1.1 (2026-06-12), so we must handle the v1 and v2 grammars (the repo has `fileformatmigrationv1.cpp`).
- **Parts:** since 1.0, per-component **assembly data** with manufacturer + MPN per assembly variant, alternatives (second source), DNM, and BOM output jobs (librepcb.org/docs/user-manual/project-editor/assembly-data). **Excellent BOM value.**
- **Parsers:** LibrePCB (C++/Qt, GPL-3.0, 3.0k★, pushed 2026-09-24). No third-party parser. LibrePCB imports Eagle and KiCad (1.2.0 added KiCad import), but **KiCad does not import LibrePCB**. The `librepcb-cli` can export schematics PDF, BOM, board BOM, fabrication data, PnP and netlist.
- **Browser path:** the S-expression grammar is close to KiCad's, so our tokenizer is reusable. Map to KiCad S-expr, or read the BOM directly from `circuit.lp` + `library/dev/*/device.lp`/`cmp` + assembly data.
- **Effort:** BOM **S–M**; full render **L**.

## 12. Fritzing (`.fzz` / `.fz` / `.fzpz` / `.fzp`)

- **Container:** `.fzz` = renamed ZIP containing a `.fz` sketch (XML, root `<module fritzingVersion="…">` with `<boards>`, `<programs>`, `<views>`, `<instances>`). It may also contain custom part `.fzp` + `.svg` files and `.ino` code. `.fzpz` = zipped part; `.fzp` = part metadata XML (github.com/fritzing/fritzing-app/wiki/2.2-Sketch-file-format, …/2.1-part-file-format).
- **Critical gotcha:** instances reference **core parts** by `moduleIdRef` (e.g. `ResistorModuleID`) and a path into the Fritzing install. Core part definitions and SVGs are **not** in the `.fzz`, so rendering needs the fritzing-parts library. There are three views (breadboard/schematic/pcb), each drawn from part SVGs.
- **Parts:** `.fzp` `<property>`s include family/type/value. The parts library has `mn` (manufacturer) and `mpn` properties plus `part number`, often empty. The repo's own checker back-fills `mpn` from `part number` (fritzing-parts scripts/checks/fzp_checkers.py; core/calliope-mini-3_2.fzp shows empty `mn`/`mpn`). BOM value is **low to medium** (mostly generic breadboard parts).
- **Exports:** Extended Gerber RS-274X + Excellon ("File › Export › for Production"; jlcpcb.com/help/article/how-to-generate-gerber-and-drill-files-in-fritzing), plus etching SVG/PDF, netlists and a BOM.
- **Parsers:** Fritzing app (C++/Qt, source **GPL-3.0**; docs and part designs **CC-BY-SA 3.0**; 4.8k★, pushed 2026-08-12). No KiCad importer. No JS parser found.
- **Licensing risk:** medium. CC-BY-SA **3.0** is not declared one-way compatible with GPLv3 (only BY-SA 4.0 is), so do **not** compile core part SVGs into the JS bundle. Serve them as separately licensed data assets with attribution, or render only the pcb view from embedded or custom parts.
- **Browser path:** unzip, parse the `.fz` XML, and render the pcb/schematic views with a **dedicated SVG renderer** (Fritzing views are SVG compositions, a poor fit for KiCanvas). The BOM from instance titles and properties is easy.
- **Effort:** BOM **S**; schematic/pcb render with a parts asset pack **L**.

## 13. DipTrace binary (`.dch` schematic, `.dip` PCB; libs `.eli` components, `.lib` patterns)

- **Detect:** `.dip` starts with `0x07 "DTBOARD"` or legacy `0x0B "DTBOARDx.yy"`. `.dch` starts with `0x07 "DTSCH…"` or `0x0B "DTSCH…"` (KiCad `pcb_io_diptrace.cpp`, `sch_io_diptrace.cpp`).
- **Contains:** full schematic and board. The component record has `part_name`, **`part_number`**, and user "additional fields" as (name, value) pairs, "e.g. Part Number (Digi-Key)". KiCad maps these to symbol fields (`diptrace_sch_parser.cpp` ~L760–L864, L3178). **Good BOM value.**
- **Spec:** none from the vendor (a DipTrace staff post in 2018 promised library docs only; diptrace.com/forum t=12195). KiCad reverse-engineered it and ships **Kaitai Struct specs** `diptrace_pcb.ksy` (2,313 lines) and `diptrace_sch.ksy` (6,220 lines). Their own header says the object region is decoded by a content-derived "field-walk" that Kaitai cannot express, so a Kaitai-generated JS parser covers only the deterministic header sections.
- **Parsers:** KiCad master `diptrace_sch_parser.cpp` 4,236 + `diptrace_pcb_parser.cpp` 6,216 lines (GPL-3.0-or-later, added 2026-05-31, active).
- **KiCad import:** master only, expected in KiCad 11.
- **Browser path:** port ~10.5k lines, or wait for KiCad 11 and offer "convert in KiCad". It is better to start with the ASCII export (§14).
- **Licensing:** proprietary format. We would use KiCad's published GPL reverse-engineering rather than reverse-engineer it ourselves (interoperability RE is generally protected, but get legal review before we RE anything ourselves).
- **Effort:** **L–XL**.

## 14. DipTrace ASCII (`.asc`)

- **Container:** text, parenthesized, starting `(Source "DipTrace-PCB")` or `(Source "DipTrace-Schematic")`, then `(Units "mm")`, `(Scale …)`, … Components carry `(Value "17-215UYC/S530-A3/TR8")`, `(PartName …)`, **`(Manufacturer "Everlight")`**, `(Datasheet "…")` (sample files in github.com/danielb987/JavaDiptraceAsciiLib src/examples, MIT). Produced by File › Export › DipTrace ASCII in every DipTrace editor.
- **Collision:** `.asc` is also LTspice (`Version 4` first line) and PADS ASCII (`!PADS-…`). Detect by the first S-expression `(Source "DipTrace-`.
- **Parsers:** danielb987/JavaDiptraceAsciiLib (Java, MIT, 2019), snhobbs/DiptraceSchematicApi (Python, BSD-2, 2017). There is no vendor spec; the format is readable by inspection. KiCad does **not** read the ASCII form.
- **Browser path:** write a small tokenizer (the S-expression-like syntax is close to our existing one), read the BOM straight away, then map geometry to KiCad S-expr.
- **Effort:** BOM **S**; render **M**.

## 15. Proteus (Labcenter) `.pdsprj`

- **Container:** ZIP (deflate). The schematic-only sample has 6 members: `ROOT.DSN` (schematic, magic `ISIS SCHEMATIC FILE\x1A`), `ROOT.CDB` (component index: refdes/value/package/pin map), `PROJECT.XML` (`RELEASE`/`FILEVER`), `GRAPHS.DAT`, `SCRIPTS/PWRRAILS.DAT`, `SCRIPTS/PROPILOT.XML` (github.com/RACErace/pdsprj-auto, "Proteus 9 .pdsprj 解析参考.md"). A project with PCB layout adds a layout member whose name was not verified. Legacy Proteus ≤7 used separate `.DSN` (ISIS) and `.LYT` (ARES) files (electronics.stackexchange.com/q/136161).
- **Parts:** component records carry a properties text block like `{PRIMITIVE=ANALOG}{PACKAGE=RES40}`. MPN/stock-code properties exist only if the user added them. BOM value is **low to medium, unverified**.
- **Exports:** Gerber X2 (primary), RS-274X/Excellon, ODB++ (secondary), IPC-D-356, STEP AP203/AP214, IGES, IDF, STL (labcenter.com/pcboutput).
- **Parsers:** RACErace/pdsprj-auto (Python stdlib, MIT, **created 2026-09-22, 1★**, schematic only). No KiCad import.
- **Recommendation:** no native support now. Ask for Gerber X2/ODB++ plus a BOM CSV. Revisit if the community parser matures.
- **Effort:** **XL** (proprietary binary, layout undocumented).

## 16. NI Multisim / Ultiboard (Circuit Design Suite)

- **Files:** Multisim `.ms10`…`.ms19` and Ultiboard `.ewprj` are **compressed XML**: a magic header, then a u64 total length, then sections of `(u32 decompressed, u32 compressed, PKWare DCL Implode block)`, chunked at 900,000 bytes. Part DBs `.prj`/`.usr` are **MS Access Jet 3/4** (github.com/cinderblock/electronics-workbench-decoder README).
- **Parsers:** **cinderblock/electronics-workbench-decoder** (npm `electronics-workbench-decoder` 0.2.0, **ISC**, JavaScript, 2026-05-29, 6★) decodes and encodes these, reading the MDBs via `mdb-reader`. It is JS-native, so browser-feasible. LHX369963/ms14_decoder (Python, no licence, 2026-09-08) builds a structured netlist and BOM JSON on top of it.
- **Parts:** DB rows have component names such as `BD9763FVM`. Per-instance MPN in `.ms14` was not verified. BOM value is **low to medium**. Multisim is mainly a simulation/education tool.
- **Exports** (Ultiboard): Gerber 274X/274D, DXF, 3D DXF/IGES, IPC-D-356A, NC drill, SVG, BOM/centroid text (knowledge.ni.com kA03q000000YG0FCAW). No ODB++ listed.
- **Status:** **Multisim Live (browser) reaches EOL 2026-09-15**. Desktop NI Circuit Design Suite continues (support.digilent.com Multisim-Live-EOL-Letter). No KiCad import.
- **Browser path:** decompress with electronics-workbench-decoder, then map the XML to a netlist and BOM. Schematic/board rendering needs a dedicated renderer.
- **Effort:** netlist/BOM **M**; render **XL**.

## 17. QucsStudio, now "uSimmics"

- Renamed: "The latest version with the new name: uSimmics-5.9.zip". Windows-only freeware (runs under Wine). "QucsStudio-3.3.3-light… for converting (= open and save) old schematic files", which implies the old and new schematic formats differ (qucsstudio.de/download). Its PCB layout is aimed at EM-simulation layouts, with Gerber export. Closed source; format undocumented.
- **Recommendation:** out of scope (RF/simulation, no MPNs, no parser). **Effort: XL/unknown.**

## 18. Qucs-S / Qucs (`.sch`)

- Text, first line `<Qucs Schematic 25.2.0>` followed by `<Properties>` … `<Components>` … `<Wires>` blocks (ra3xdh/qucs_s examples). Projects are `*_prj` directories. A simulation schematic with **no PCB and no MPNs**. Qucs-S is GPL-2.0, 1.38k★, 26.1.1 released 2026-04-26.
- **Recommendation:** detect it (to give a friendly "simulation schematic, not supported" message on the `.sch` collision) and do not render it. **Effort:** detection S; render M with no BOM value.

## 19. Sprint-Layout (Abacom) `.lay6` / `.lay` (+ `.lmk` macro libs)

- **Detect:** 4 bytes: version (≤6), `0x33 0xAA 0xFF` (KiCad `pcb_io_sprint_layout.cpp`). Binary, one or more boards per file. KiCad offers a board chooser.
- **Parsers:** KiCad master `sprint_layout_parser.cpp` (2,035 lines) + `sprint_layout.ksy`/`sprint_layout_lmk.ksy` (GPL-3.0-or-later, 2026-03-20). No MPNs.
- **Effort:** **M** (board only). Popular with EU hobbyists; low priority.

## 20. tscircuit Circuit JSON (possible intermediate)

- `circuit-json` (npm 0.0.503, ISC) is tscircuit's intermediate JSON (schematic, pcb, BOM, simulation). MIT React viewers exist: `tscircuit/pcb-viewer`, `schematic-viewer`, `3d-viewer`, plus converters such as `easyeda` (EasyEDA footprints → Circuit JSON), `kicad-to-circuit-json` (MIT) and `circuit-json-to-kicad` (licence NOASSERTION). All were pushed in 2026-09.
- **Relevance:** Circuit JSON is an alternative renderer target to KiCad S-expr, for formats whose data model is far from KiCad (Fritzing, Horizon). It would add a second renderer beside KiCanvas, which the CanvasController seam allows. Weigh that against the one-renderer simplicity we have today.

---

## Licensing summary for a GPL-3.0-or-later browser bundle

- **Clean:** porting KiCad importers (GPL-3.0-or-later; the gEDA symbol text inside is GPL-2.0-or-later, compatible); tracespace/gerber (MIT, another slice); easyeda (MIT); wokwi easyeda2kicad (MIT + Apache-2.0 file, which is GPLv3-compatible); electronics-workbench-decoder (ISC); LibrePCB/Horizon/Fritzing *code* (GPL-3.0, if ported); easyeda-pro-format-skill spec (MIT).
- **Needs care:** easyeda2kicad.py (AGPL-3.0, network clause); Fritzing core parts (CC-BY-SA 3.0, keep them out of the compiled bundle); Horizon pool (CC-BY-SA 4.0 + design waiver); **unlicensed** repos (tscircuit/easyedats, easyeda-pro-file-format, eprj3-format, ms14_decoder), which may be read as references but not copied.
- **Proprietary formats** (DipTrace, Proteus, Multisim, Sprint, EasyEDA `.eprj` SQLite): use existing third-party open parsers. If we ever reverse-engineer one ourselves, get legal review of the EULA against the EU Software Directive Art. 6 and DMCA §1201(f) interoperability exceptions.

## Gaps and follow-ups (not verified in this pass)

T/DISA 4001 container; Flux `.flx` container; the Proteus layout member name; the KiCad board version emitted by wokwi/easyeda2kicad; DesignSpark PCB, ExpressPCB, Target 3001!, TinyCAD `.dsn` XML (the `.dsn` collision with OrCAD/Specctra; sch-rnd imports TinyCAD; TinyCAD's GitHub repo has no licence file), and CircuitMaker (Altium community), none of which were researched here.
