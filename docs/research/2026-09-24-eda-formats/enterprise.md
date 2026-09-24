# Enterprise EDA formats: dossier for the Circuit Center Design Viewer

Slice: Cadence OrCAD Capture / OrCAD X / Allegro, Siemens PADS / Xpedition / PADS Professional, Zuken CR-5000 / CR-8000 / CADSTAR, Pulsonix, and the neutral exports these tools write (EDIF, Allegro extracta/Fabmaster, IPC-2581, ODB++, Specctra DSN, GenCAD, IDF, Allegro/Telesis netlists).
Researched 2026-09-24. Sources were read directly: the KiCad source tree through the GitLab API and raw files, parser repositories through the GitHub API, and vendor pages through Firecrawl. Raw captures are in `./fc/`.

## 0. Headline findings

1. **KiCad now reads most of this slice natively.** Every KiCad importer is GPL-3.0-or-later, the same licence as our bundle, so porting its logic to TypeScript raises no licence problem.
   - **KiCad 10.0** (tagged 2026-03-19) added three importers:
     - the Cadence **Allegro binary `.brd`** importer (board only, Allegro v16–v23)
     - **PADS ASCII `.asc`** (PCB and schematic)
     - gEDA
     Source: https://www.kicad.org/blog/2026/02/Three-New-Importers-in-KiCad-10-Allegro-PADS-and-gEDA/ and https://www.kicad.org/blog/2026/03/Version-10.0.0-Released/
   - **KiCad master (the unreleased "10.99" nightly, expected to ship as KiCad 11)** adds:
     - **OrCAD Capture `.DSN`/`.OLB`**, including CIS variants. The importer landed 2026-07-21 in commit 50791979 and the CIS decoding 2026-09-07 in a0f263d4.
     - **PADS binary `.pcb`**. The parser code is already in 10.0 but is registered as a plugin only in master.
     - **PADS Logic binary `.sch`** (2026-08-23).
2. **KiCad has read CADSTAR archives (`.csa`/`.cpa`) and Allegro Fabmaster/extracta ASCII since 6.0.** It has read CADSTAR parts libraries (`.lib`) since 8.0.
3. **KiCad does not import ODB++ or IPC-2581.** It only exports them: IPC-2581 since 8.0, ODB++ since 9.0. `CanReadBoard()` returns false for both (`pcbnew/pcb_io/odbpp/pcb_io_odbpp.h:141`, `pcbnew/pcb_io/ipc2581/pcb_io_ipc2581.h:118`).
4. **Nobody imports Xpedition, CR-5000/CR-8000 or Pulsonix natively, and no open parser exists for them.** The only practical route is to ask users for a neutral export: ODB++, IPC-2581, EDIF, PADS ASCII, or Specctra DSN.
5. **For pricing a BOM, the three strongest neutral formats all carry the manufacturer part number (MPN) in a named field:**
   - **IPC-2581** has a `Bom` section and an `Avl` section with `AvlMpn` + `AvlVendor`.
   - **ODB++** has `steps/<step>/boms/<bom>/bom` with CPN / MPN / VND fields.
   - **Allegro-family data** carries MPNs in the `PART_NUMBER` package property: Fabmaster `COMPPARTNUMBER`, Telesis `PACKAGEPROP PART_NUMBER`, Specctra `(PN …)`.

   Native schematics (OrCAD, PADS, CADSTAR) carry MPNs only when the designer or the CIS database filled in part properties.
6. **Several of these formats are S-expression-shaped** (EDIF, Specctra DSN, CADSTAR archives, and the OrCAD `.opj` "(ExpressProject" header). Our existing KiCad `sexpr.ts` tokenizer is a direct head start for them.
7. **KiCad writes its binary-format knowledge as Kaitai Struct `.ksy` files** (`pads_binary.ksy` 6,304 lines, `pads_sch_binary.ksy` 1,662 lines, `orcad_dsn.ksy` 2,360 lines, `microsoft_cfb.ksy`). Kaitai compiles `.ksy` to JavaScript; the compiler is GPL-3.0 and the JS runtime is Apache-2.0. `pads_sch_binary.ksy` declares `license: GPL-3.0-or-later` in its own `meta`. This is the cheapest route to structural parsers for the binary formats. The KiCad builder logic still has to be ported on top.

## 1. Extension-collision map (for the intake detector)

| Ext | Candidates (and how to tell) |
|---|---|
| `.brd` | **Allegro binary**: bytes 2–3 = `13 00`/`14 00`/`15 00`/`16 00` (v16/v17/v18/rev19), or `all` at 0xF8. A board saved by Allegro Free Physical Viewer has `vie` at 0xF8 (OpenBoardView `BRDAllegroFile.h`). **Eagle ≥6**: XML with an `<eagle` root. Eagle <6 binary (other slice). **Test_Link/boardview `.brd`**: plain text (OpenBoardView). |
| `.dsn` | **OrCAD Capture design**: CFB/OLE2 magic `D0 CF 11 E0 A1 B1 1A E1`, plus a root `Library` stream and a `Views` or `Schematics` storage (KiCad `sch_io_orcad.cpp:403`). **Specctra DSN**: text starting `(pcb`. **CADVANCE `.dsn`** (listed by Altair PollEx). |
| `.pcb` | **PADS Layout binary**: `00 FF`, then a u16 version 0x2017–0x2027. **Xpedition** `.pcb` (binary, undocumented). **CADSTAR** native. **Pulsonix** native. **Zuken CR-5000 BD**. gEDA (`PCB[` text). P-CAD. Protel. |
| `.sch` | **PADS Logic binary**: `00 FE`, then u16 version 0x000C/0x000D. **Pulsonix**. Eagle. gEDA. KiCad legacy (`EESchema Schematic File`). |
| `.asc` / `.txt` | **PADS ASCII**: first line contains `!PADS-` (layout) or `*PADS-LOGIC` / `*PADS-POWERLOGIC` (logic); libraries start `*PADS-LIBRARY-…`. **Fabmaster/extracta** `.txt`/`.fab`: `!`-delimited rows beginning `A!`/`J!`/`S!` with column names such as `REFDES`, `SYMNAME` (KiCad `pcb_io_fabmaster.cpp:46`). OpenBoardView ASC boardview. |
| `.lib` | **CADSTAR parts library** (`# FORMAT n`, `.PartName` headers; KiCad `cadstar_parts_lib_grammar.h`). KiCad legacy symbol library. SPICE/Liberty. |
| `.csa` / `.cpa` | **CADSTAR archive**: text starting `(CADSTARSCM` / `(CADSTARPCB` (KiCad `pcb_io_cadstar_archive.cpp:149`, `cadstar_sch_archive_parser.cpp:39`). *Unverified: Cadence Design Entry HDL may also use `.csa` for ASCII schematic pages; this needs a sample.* |
| `.xml` / `.cvg` | **IPC-2581**: root `<IPC-2581 revision="B|C">` (namespace `http://webstds.ipc.org/2581`). **OrCAD Capture XML** export (schema `capDB/dsn.xsd`, per the OpenOrCadParser README). |
| `.tgz` / `.zip` / `.tar` | **ODB++**: a directory tree with mandatory `matrix/matrix`, `misc/info`, `steps/<s>/stephdr`; layer `features` files may be Unix-`compress`ed as `features.Z`. |
| `.edf` / `.edn` / `.edif` | **EDIF 2 0 0**: text `(edif <name> (edifVersion 2 0 0)`. |

## 2. Format-by-format

### 2.1 Cadence OrCAD Capture: `.dsn` / `.dbk` / `.olb` / `.obk` / `.opj`

- **Container.** `.dsn`/`.olb` are OLE2 Compound File Binary (CFB) documents. `.dbk`/`.obk` are backups with identical content (OpenOrCadParser README).
- **Streams.** The root `Library` stream begins with the NUL-terminated intro string `OrCAD Windows Design` or `OrCAD Windows Library`, then u16 major and u16 minor version. The versions seen in the wild are 1.1 (Capture 7), 2.0/2.1 (Capture 9–10.5) and 3.2/3.3 (Capture 16–17.4+). Source: KiCad `eeschema/sch_io/orcad/ORCAD_V2_FORMAT.md`.
- **Project file.** `.opj` is an ASCII project index beginning `(ExpressProject`. A GitHub code search finds 2,496 `.opj` files containing it. It holds file paths only, not design data.
- **Contents.** Schematic pages, hierarchy, a library cache with symbols, and part instances with user properties. The **CIS** storage adds variants and database property groups (KiCad `orcad_cis.cpp`, `applyCisVariant`).
- **BOM value.** Medium to high. CIS-managed designs usually carry MPN, manufacturer and part-number properties; plain Capture designs often have only value and PCB footprint.
- **Parsers.**
  - **KiCad `SCH_IO_ORCAD`** (GPL-3.0-or-later, master only). It was measured over 856 designs (188 legacy, 668 modern); see `ORCAD_V2_FORMAT.md`. The CFB reader it uses is Microsoft's compoundfilereader.
  - **Werni2A/OpenOrCadParser** (MIT, C++20, ★69, last push 2024-07-21, README "Current State — June 2024"). It uses Microsoft `compoundfilereader`.
  - fjullien/rnif2ki converts OrCAD netlists only (GPL-2.0, last push 2019).
- **KiCad import.** Master only (not in 10.0.6), schematic plus `.olb` libraries. It checks the CFB header and then the `Library` + `Views`/`Schematics` streams. Recent open issues (#25466, #25467, #25502, #25557) show it is still maturing.
- **Browser path.** Read the container with a JS CFB reader: the `cfb` package (Apache-2.0) from the same SheetJS family we already vendor. Then either compile `orcad_dsn.ksy` with Kaitai, or hand-port KiCad's stream decoders, and emit `.kicad_sch` text for KiCanvas and our reader.
  - A BOM-only reader (walk the part instances and properties, apply the CIS variant) is a much smaller first step.
- **Fallback exports a user can make.** EDIF 2 0 0 (File › Export › EDIF), Capture XML, and the Allegro netlist (`pst*.dat`).

### 2.2 Cadence Allegro PCB / OrCAD PCB Designer / OrCAD X / Allegro X: `.brd` (plus `.dra` `.psm` `.pad` `.ssm` `.fsm` `.osm` `.bsm` `.mdd` `.mcm` `.sip`)

- **Container.** A proprietary binary database with a header of about 4 KB. The first 4 bytes are a magic number that encodes the version. There are 22 linked lists before v18 and 28 from v18. A string table starts at 0x1200, followed by object blocks tagged by type. `m_FileRole` is 0x01 for `.brd` and 0x02 for `.dra`. Source: KiCad `pcbnew/pcb_io/allegro/FORMAT.md` (948 lines, "reverse-engineered … not an official specification").
- **Versions.** OrCAD X and Allegro X 23.1 save the same `.brd` family and can "Downrev" to 17.4 (https://www.ema-eda.com/how-to-page/how-to-downrev-a-pcb-file-with-orcad-and-allegro/).
- **Contents.** Board, stackup/layers, padstacks, footprints, nets, copper, constraints. **No schematic.**
- **BOM value.** Medium. Refdes and value are always present. `DEVICE_TYPE` is usually the Capture part name. MPNs appear as the `PART_NUMBER` component property when the Capture flow passed it through; KiCad's own Allegro netlist exporter writes `PACKAGEPROP PART_NUMBER` from `PART_NUMBER`/`mpn`/`mfr_pn` fields (`netlist_exporter_allegro.cpp:465`). KiCad's importer only surfaces the displayed text classes Device Type, User Part Number, Component Value and Tolerance as footprint fields (`allegro_builder.cpp:3235-3280`). A browser reader could read the full `0x03` FIELD chains.
- **Parsers.**
  - **KiCad `PCB_IO_ALLEGRO`** (GPL-3.0-or-later). In 10.0 since 2026-03; the blog says it reads v16 through v23; its development was sponsored by Quilter.
  - **Werni2A/OpenAllegroParser** (MIT, C++17, ★57, last push 2022-08-06, "Current State — April 2022"; padstack-focused, immature).
  - **OpenBoardView** detects Allegro files but refuses them ("use Allegro FREE Physical Viewer").
  - juulsA/exportJson is an Allegro SKILL script (MIT, ★42, pushed 2026-07-14) that writes InteractiveHtmlBom generic JSON. It runs *inside* Allegro.
- **KiCad import.** 10.0+, board only. `CanReadLibrary` returns false, so `.dra`/`.psm` are not read. The KiCad blog lists schematic support as future work.
- **Browser path.** Port KiCad's `allegro/convert/*` parser (`allegro_parser.cpp`, `allegro_pcb_structs.h`) and `allegro_builder.cpp` (4,810 lines) to TypeScript, and emit `.kicad_pcb`. A BOM-plus-placement subset (footprint instances, refdes, the FIELD chain) would be a first milestone.
- **Legal note.** KiCad describes its work as "fully blind reverse engineering … without using any Allegro programs or libraries". We should port KiCad's documented knowledge and must **not** reverse-engineer using Cadence binaries, because Cadence licences forbid it.
- **Detection.** `.brd` is shared with Eagle (XML) and boardview formats; see §1.

### 2.3 Allegro ASCII exports: extracta / "Fabmaster" `.txt` `.fab` `.rpt`, Altium's `.alg`, EasyEDA's `.ebrd`/`.edra`

- **What extracta is.** A Cadence utility, `extracta <brd> <command-file> <out>`. It writes `!`-delimited records:
  - `A!` gives column names,
  - `J!` gives global data (file, date, extents, units, board name, thickness, layer count, DRC state),
  - `S!` gives data rows.
  Sources: Cadence BoardSurfers blog https://community.cadence.com/cadence_blogs_8/b/pcb/posts/extracting-layout-data and KiCad issue #11826 https://gitlab.com/kicad/code/kicad/-/issues/11826 (it notes the KiCad "Fabmaster" importer is really extracta driven by `share/pcb/text/views/fabmaster.txt`).
- **Does extracta need a licence?** The sources disagree. KiCad #11826 says it needs a valid (trial) licence; Altair PollEx says no licence is needed but an Allegro installation is.
- **Which tools use it.**
  - Altium imports Allegro via `.alg` files produced by extracta (https://www.altium.com/documentation/altium-designer/design-tools-interfacing/allegro-import).
  - EasyEDA Pro ships an Allegro-side plug-in that writes `.ebrd`/`.edra` (https://prodocs.easyeda.com/en/import-export/import-allegro-orcad/).
- **BOM value.** High when the view includes `COMPPARTNUMBER`, `COMPVALUE`, `COMPDEVICELABEL`, `REFDES` (KiCad `import_fabmaster.cpp:1864-1880`).
- **Parsers.**
  - KiCad `PCB_IO_FABMASTER` (GPL-3.0-or-later, KiCad 6.0+; extensions `txt`, `fab`).
  - ljmljz/fabmaster (Python, **no licence**, pushed 2026-05-27).
  - edgeforce/cds2f (a batch wrapper, no licence).
- **Browser path.** Easy text parsing. We could even publish our own extracta command file (a "view") that exports exactly the columns our BOM needs.

### 2.4 Allegro netlists: `pstxprt.dat` / `pstxnet.dat` / `pstchip.dat`, and the Telesis third-party netlist

- **What they are.**
  - Capture writes the three `pst*.dat` files for Allegro: `pstxprt.dat` holds parts and sections, `pstxnet.dat` holds nets, `pstchip.dat` holds library primitives (https://www.ema-eda.com/how-to-page/how-to-netlist-a-design-in-orcad-capture/).
  - The Telesis/"third-party" netlist is ASCII with `$PACKAGES` / `$NETS` / `$END` sections. KiCad exports it (Allegro netlist `.txt`, `wildcards_and_files_ext.cpp:146`) and writes device files with `PACKAGEPROP PART_NUMBER`.
- **BOM value.** High and cheap: refdes plus package, value and `PART_NUMBER`. No geometry.
- **Parsers.** The exact grammar is only in Cadence docs. KiCad's exporter is the best open reference for the Telesis side.
- **Browser path.** Small text parser, feeding the BOM table only.

### 2.5 Siemens PADS Layout / PADS Logic (PowerPCB / PowerLogic)

- **Formats.**
  - **PADS ASCII `.asc`.** Layout first line `!PADS-POWERPCB-V9.4-MILS!`; libraries `*PADS-LIBRARY-PCB-DECALS-V9*`; Logic `*PADS-LOGIC…*` / `*PADS-POWERLOGIC…*` (KiCad `pads_parser.cpp:152`, `sch_io_pads.cpp:1549`). Sections include `*PART*`, `*PARTTYPE*`, `*PARTDECAL*`, `*NET*`, `*ROUTE*`, `*POUR*`, `*MISC*` (with `ATTRIBUTE VALUES` per-part blocks), `*REUSE*`, `*TESTPOINT*`, `*NETCLASS*`, `*DIFFPAIR*`.
  - **PADS Layout binary `.pcb`.** Magic `00 FF`, then a u16 version (0x2017, 0x2019, 0x2021, 0x2022, 0x2024–0x2027), a directory of controllers, and a footer GUID (`pads_binary.ksy`, `pads_sdb.cpp:43`).
  - **PADS Logic binary `.sch`.** Magic `00 FE`, then u16 version 0x000C or 0x000D (`pads_sch_sdb.cpp:32`).
- **BOM value.** Medium to high. `*PARTTYPE*` attributes and per-instance `ATTRIBUTE VALUES` carry "Part Number" / "Manufacturer" when populated (KiCad `pads_parser.cpp:3817-3854`, `:4935`).
- **Parsers.**
  - KiCad `PCB_IO_PADS` (ASCII, 10.0+).
  - `PCB_IO_PADS_BINARY` (master only).
  - `SCH_IO_PADS` (ASCII 10.0+; binary `.sch` master only). All GPL-3.0-or-later.
  - **firechip/pads-layout-parser** (TypeScript, MIT, ★3, pushed 2025-01-06; netlist portion of `.asc` only).
  - OpenBoardView issue #60 "Fileformat: PCB (PADS)" has been open since 2016.
- **KiCad import.**
  - 10.0: `.asc` board and schematic (the 10.0 README says "PADS PowerPCB V9.0 through V9.5").
  - Master: binary `.pcb` and `.sch`.
- **Browser path.** `.asc` is plain text: a TS port of `pads_parser.cpp` (5,093 lines) plus the converter, emitting `.kicad_pcb`. For binary, compile `pads_binary.ksy`/`pads_sch_binary.ksy` with Kaitai to JS, then port the builders.

### 2.6 Siemens Xpedition Enterprise / xDX Designer (DxDesigner) / PADS Professional

- **Formats.**
  - **Xpedition Layout.** Binary `.pcb` inside a project folder with `.prj`.
  - **ASCII "keyin" HKP set.** Altair PollEx reads six files: `Cell.hkp` (placement), `JobPrefs.hkp` (layers), `Layout.hkp` (routing), `NetProps.hkp` (nets), `Padstack.hkp`, `PDB.hkp` (part library). Its binary-read option only works with Xpedition installed (https://help.altair.com/pollex/topics/pollex/modeler/pcb_mentor_graphics_xpedition_t.htm).
  - **xDX Designer schematics.** `.prj` project plus `Name.N` sheet files. Altium imports these up to EE7.9.4, and Xpedition PCB up to VX2.x (https://resources.altium.com/p/migration-guide-siemens-xpedition-enterprise-altium-designer-develop).
  - **Exports.** EDIF schematic (File › Export › EDIF Schematic), ODB++ (native to Siemens), IPC-2581.
  - **PADS Professional.** Built on the Xpedition engine. *Unverified here*; assume the same `.prj`/`.pcb` family.
- **Contents and BOM.** Parts come from the central library "Databook"; `PDB.hkp` carries part numbers. High BOM value in principle, but there is no open parser.
- **Parsers.** None open. KiCad has no importer and nothing is in progress.
- **Browser path.** Do not target native files. Route users to ODB++ or IPC-2581 for the board and EDIF for the schematic.

### 2.7 Zuken CADSTAR: `.csa` / `.cpa` / `.lib` (native `.scm` / `.pcb` binary)

- **Container.** ASCII parenthesised "archive" files, starting `(CADSTARSCM` or `(CADSTARPCB`. The parts library `.lib` has a `# FORMAT n` header and `.PartName` entries.
- **BOM value.** Medium to high. KiCad maps the CADSTAR part's `Name`, `Number` ("Part Number"), acceptance name and attributes onto symbol fields (`cadstar_sch_archive_loader.cpp:53-54, 202-244`).
- **Parsers.** KiCad `SCH_IO_CADSTAR_ARCHIVE` + `PCB_IO_CADSTAR_ARCHIVE` + `common/io/cadstar/*` (GPL-3.0-or-later). The archives arrived in 6.0; the `.lib` PEGTL grammar arrived in 8.0.
- **KiCad import.** 6.0+ for schematic and board archives; 8.0+ for the parts library.
- **Browser path.** Our S-expression tokenizer will likely read the archive syntax with light changes. We would need to port KiCad's CADSTAR loaders, which are large.

### 2.8 Zuken CR-5000 Board Designer / CR-8000 Design Force / CR-5000 PWS

- **Formats.**
  - **Native.** BD `.pcb`; CR-8000 `.dsgn`.
  - **ASCII via Zuken utilities.** Single board: `.pcf` or `.dsgf` plus `.ftf` (footprint/technology). Array board: `.pnf` or `.mdgf` plus `.ftf`. Variants: `.dst` (https://help.altair.com/pollex/topics/pollex/modeler/pcb_zuken_cr8000_r.htm).
  - **PWS (a legacy flow).** Five ASCII files: `.BSF` board specification, `.CCF` nets, `.MDF` parts, `.UDF` placement and graphics, `.WDF` routing (…/pcb_zuken_cr5000_pws_t.htm).
  - **Exports.** Design Force exports ODB++ and IPC-2581 natively (https://www.zuken.com/us/blog/ipc-2581-the-open-road-to-reducing-pcb-design-workload/).
- **Parsers.** None open; no public spec.
- **Browser path.** Neutral exports only.

### 2.9 Pulsonix: `.sch` / `.pcb` binary, `.plx` library exchange

- **Native files.** Binary and undocumented. The KiCad forum migration thread (Feb 2026) found no direct path (https://forum.kicad.info/t/import-pulsonix-files-to-kicad/67151).
- **Exports.** Pulsonix "Save As" can write **OrCAD or PADS** formats (EasyEDA Pro guide, https://prodocs.easyeda.com/en/import-export/import-pulsonix/). A forum post claims the PCB Libraries `.plx` library format is P-CAD ASCII (unverified).
- **Browser path.** Route users to PADS ASCII, ODB++ or IPC-2581.

### 2.10 IPC-2581 (IPC-DPMX): `.xml` / `.cvg` (sometimes zipped)

- **Container.** A single XML document, root `<IPC-2581 revision="B|C">`. Its sections are Content, LogisticHeader, HistoryRecord, **Bom**, **Ecad** (CadHeader + CadData: Layer, Stackup, Step: Package, Component, LogicalNet, PhyNetGroup, LayerFeature) and **Avl**.
- **Contents.** Full fabrication and assembly data, stackup, nets and components. **No schematic.**
- **BOM value.** High. `Bom/BomItem@OEMDesignNumberRef` + RefDes, plus `Avl/AvlItem/AvlVmpn/AvlMpn` + `AvlVendor`. KiCad's exporter fills the AVL from user-chosen MPN, manufacturer and distributor fields (`pcb_io_ipc2581.cpp:4791-4863`).
- **Spec.** The standard is sold by IPC (https://shop.electronics.org/ipc-2581/ipc-2581-standard-only; revision C is current). The consortium calls it "open, neutrally maintained" and offers free viewers and test cases (https://www.ipc2581.com/). The schema URL `webstds.ipc.org/2581` returns 403.
- **Parsers.**
  - **midub/boardui** (TypeScript web component, MIT, ★26, pushed 2025-03-08; demo.boardui.com).
  - Chentai-Kao/ipc2581_to_odb (C++, GPL-2.0, 2013, stale).
  - mgburr/ipc2581-to-kicad (C++, **no licence**, 2026-02).
  - Rafa350/EdaTools (C#, LGPL-3.0).
  - KiCad's exporter, which serves as a reference for the element shapes.
- **Demand evidence.** openpnp issue #1731 "IPC-2581 Import" (2025).
- **KiCad import.** No (export only, KiCad 8.0+).
- **Browser path.** `DOMParser` / a SAX parser in a worker. Map to the KiCad board model and emit `.kicad_pcb`, or render directly. This is the most browser-friendly board format in the slice.

### 2.11 ODB++ (ODB++Design): `.tgz` / `.tar.gz` / `.zip` / directory

- **Container.** A directory tree, usually tar+gzip or zip. Mandatory files: `matrix/matrix`, `misc/info`, `fonts/standard`, `steps/<s>/stephdr`, and `steps/<s>/layers/<l>/features` (optionally `features.Z`, Unix-`compress` LZW). Components live in `layers/comp_+_top|bot/components` and link to `steps/<s>/eda/data`.
- **Contents.** Board, layers, stackup, nets, components. **No schematic.**
- **BOM value.** High.
  - The `steps/<s>/boms/<bom>/bom` file has sections `HEADER`, `DESC_ALIASES`, `RD_CPN`, `CPN_MPN`, `CP`, with `CPN`, `MPN`, `VND`, `VPL_MPN`, `VPL_VND` and `QLF` fields (spec 8.1 update 2, p.101–103).
  - Version 8.1 also allows BOM data inside the component file.
- **Spec.** A free download after sign-up (Siemens FAQ: "no restrictions on who can access", https://www.siemens.com/en-us/products/pcb/odb-plus-plus/resources/). The PDF itself says "confidential and proprietary … duplicate … for internal business purposes only" (https://odbplusplus.com/wp-content/uploads/sites/2/2020/03/odb_spec_user.pdf, p.2). Implementing a reader is normal industry practice; we must not redistribute the spec.
- **Parsers.**
  - **nam20485/OdbDesign** (C++, **AGPL-3.0**, ★84, pushed 2026-09-22, active; REST/gRPC server).
  - ulikoehler/ODBPy (Python, Apache-2.0, ★42, last 2019).
  - sjgallagher2/ODBplusplus-Parser (Python, GPL-3.0, pushed 2026-04).
  - capablemonkey/odb-pp-parser (Ruby, no licence, 2017).
  - KiCad's exporter (GPL-3.0-or-later) is the best open reference for the file shapes.
- **KiCad import.** No (export only, KiCad 9.0+; import disabled in code).
- **Browser path.** Untar/unzip in a worker (fflate, which we already use, handles zip and gzip; tar is trivial), a small LZW decoder for `.Z`, and line-record parsers. Map to the KiCad model.

### 2.12 EDIF 2 0 0 schematic/netlist: `.edf` / `.edn` / `.edif`

- **Container.** S-expression text `(edif … (edifVersion 2 0 0) …)`, standardised as ANSI/EIA-548-1988 (https://en.wikipedia.org/wiki/EDIF).
- **Who writes it.**
  - OrCAD Capture (File › Export › EDIF; EasyEDA Pro relies on this).
  - xDX Designer (File › Export › EDIF Schematic).
  - Most enterprise capture tools.
- **Contents.** Libraries, cells with symbol graphics, instances with properties, nets, pages.
- **BOM value.** Medium. Instance properties carry whatever the designer set.
- **Parsers.**
  - byuccl/spydrnet (Python, BSD-3-Clause, ★116, pushed 2026-04; FPGA netlist EDIF, not schematic graphics).
  - kicadtranslator.com, an EDF⇄`.kicad_sch` translator announced 2026-08-16. It is a closed, server-side service, and forum replies raised the privacy objection (https://forum.kicad.info/t/free-bidirectional-edf-kicad-schematic-translator-orcad-capture-kicad-sch/71185).
- **KiCad import.** None.
- **Browser path.** Our `sexpr.ts` tokenizer, plus an EDIF semantic layer, emitting `.kicad_sch`. The BOM/netlist part comes first; schematic graphics are a larger job.

### 2.13 Specctra DSN / SES (Cadence SPECCTRA / Allegro PCB Router): `.dsn` / `.ses`

- **Container.** S-expression text `(pcb …)`. Written by Allegro/OrCAD PCB, PADS, CADSTAR, Pulsonix and KiCad for autorouting.
- **Contents.** Structure (layers, boundary, keepouts), library (images/padstacks), placement, network, wiring. Placement entries can carry `(PN <part_number>)` (KiCad `specctra.cpp:1993`, `specctra.keywords:243`).
- **Parsers.**
  - KiCad `SPECCTRA_DB::LoadPCB` (GPL-3.0-or-later; the UI imports only `.ses`).
  - freerouting/freerouting (Java, GPL-3.0, ★2,022, active 2026-09-24).
- **Browser path.** `sexpr.ts` plus a mapper. This gives an approximate board (copper and pads, no silk or fab) and a PN-bearing placement list.

### 2.14 GenCAD 1.4: `.cad` / `.gcd`

- **Container.** ASCII with `$HEADER` (`GENCAD <ver>`), `$BOARD`, `$PADS`, `$PADSTACKS`, `$SHAPES`, `$DEVICES` (`PART`, `VALUE`, `DESC`), `$COMPONENTS`, `$SIGNALS`, `$TRACKS`, `$ROUTES`, `$TESTPINS`.
- **Who writes it.** Allegro, PADS, Xpedition and KiCad all export it (as a test/assembly format).
- **BOM value.** Medium (device `PART`/`VALUE`).
- **Parsers.** OpenBoardView `GenCADFile` with a BNF grammar (C++, **MIT**, ★1,831, pushed 2026-09-05). KiCad exports only.
- **Browser path.** Port OpenBoardView's grammar to TS.

### 2.15 IDF 3.0 (board + library): `.emn` / `.emp` (also `.bdf` / `.ldf`)

- **Container.** ASCII sections. The `.PLACEMENT` records hold "package name, part number, refdes" (KiCad `utils/idftools/idf_parser.cpp:250`).
- **Who writes it.** Allegro, PADS, Xpedition and CR-8000, as mechanical ECAD–MCAD exchange.
- **Contents.** Board outline, holes, keepouts, component outlines and heights. No copper.
- **Parsers.** KiCad `utils/idftools` (GPL-3.0-or-later; reads IDF 2/3, used by `idf2vrml`).
- **Browser path.** Small parser, feeding the 3D tab (extruded outlines) and a BOM stub.

### 2.16 InteractiveHtmlBom generic JSON: `.json`

- **Schema.** `genericjsonpcbdata_v1.schema` (openscopeproject/InteractiveHtmlBom, MIT, ★4,576, active). Required `spec_version`, `pcbdata`, `components`. Components carry `extra_fields` (MPN and similar).
- **Who writes it.** The Allegro SKILL script juulsA/exportJson (MIT) and others.
- **BOM value.** High when the fields are configured.
- **Browser path.** Trivial (JSON). This is a cheap Allegro on-ramp that needs no binary reverse engineering.

## 3. Licensing summary for a GPL-3.0-or-later client bundle

| Source | Licence | Use in our bundle |
|---|---|---|
| KiCad importers and `.ksy` files | GPL-3.0-or-later | Porting is fine; keep the notices. |
| OpenOrCadParser, OpenAllegroParser, OpenBoardView, boardui, pads-layout-parser, ibom | MIT | Fine. |
| ODBPy, Kaitai JS runtime, `cfb` | Apache-2.0 | Fine (GPLv3-compatible). |
| OdbDesign | AGPL-3.0 | Combinable with GPLv3 under §13, but it adds network-use obligations. Avoid; use it as a reference only. |
| ipc2581_to_odb, rnif2ki | GPL-2.0 (only?) | Possibly **incompatible** with GPL-3.0 if "only". Reference only. |
| ljmljz/fabmaster, cds2f, capablemonkey/odb-pp-parser, mgburr/ipc2581-to-kicad | No licence | Unusable as code. |

**Spec and EULA risks.**
- Cadence and Siemens EULAs forbid licensees from reverse engineering. Use existing clean-room work (KiCad) rather than doing our own reverse engineering with vendor binaries.
- The ODB++ spec is free but marked confidential; implementing from it is fine, redistributing it is not.
- The IPC-2581 standard is paid.
- EDIF is an EIA standard.

## 4. Recommended order (value ÷ effort, privacy-preserving, all in-browser)

1. **IPC-2581** (M): XML, a priceable AVL/BOM, full board, and a TS viewer to learn from. Every enterprise tool exports it.
2. **PADS ASCII `.asc`** (L, BOM-only M): text, KiCad 10 reference code, schematic and board.
3. **ODB++** (L, BOM-only M): universal, and Siemens' own format.
4. **Allegro extracta/Fabmaster `.txt` + Telesis/`pst*.dat` netlists + ibom JSON** (S–M): cheap BOM paths for the Cadence world.
5. **EDIF** and **Specctra DSN** (M): reuse `sexpr.ts`.
6. **CADSTAR archives** (L): a KiCad port.
7. **OrCAD `.DSN`** (XL; BOM-only L): wait until KiCad's master importer ships in KiCad 11 and stabilises, then port its decoders or compile `orcad_dsn.ksy`.
8. **Allegro binary `.brd`** (XL): port KiCad's parser.
9. **PADS binary `.pcb`/`.sch`** (XL): compile the `.ksy` files with Kaitai.
10. **Xpedition / CR-5000/8000 / Pulsonix native:** do not attempt; route users to neutral exports.

**A server-side option (not recommended).** Running kicad-cli on the server would use the same GPL code and cover Allegro, PADS, CADSTAR, Fabmaster and, later, OrCAD in one go. It would break the promise that "your design files never leave your browser", so it should only ever be an explicit, opt-in, clearly labelled mode. Building KiCad itself for WebAssembly (wx + BOARD model) is XL.
