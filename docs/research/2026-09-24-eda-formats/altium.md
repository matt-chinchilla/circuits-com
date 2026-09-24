# Altium family: format dossier for the Circuit Center Design Viewer

Researched 2026-09-24. Primary sources: KiCad source (gitlab.com/kicad/code/kicad master @ d1191971, 2026-09-24, plus the 6.0 through 10.0 release branches via the GitLab API), parser repositories (licence and last-push dates from the GitHub API), Altium documentation, and real sample files. Two items were measured locally rather than reasoned about; they are marked MEASURED.

## TL;DR

- **Most of the family shares one container.** SchDoc, PcbDoc, SchLib, PcbLib, IntLib and the CircuitMaker, CircuitStudio and SOLIDWORKS PCB board files are Microsoft Compound File Binary (CFB/OLE2, magic `D0 CF 11 E0 A1 B1 1A E1`). Inside are streams of pipe-delimited `|KEY=VALUE|` property records, plus fixed binary structs for PCB primitives. PrjPcb, OutJob, DbLib and LibPkg are INI text. BomDoc and the legacy ASCII SchDoc/PcbDoc are pipe-record text.
- **Pricing a BOM is realistic from the schematic.** SchDoc component parameters (RECORD=41) normally carry `Manufacturer` / `Manufacturer Part Number` (or `Manufacturer 1` / `Manufacturer Part Number 1`, the names ActiveBOM reserves) and `Supplier Part Number n`. MEASURED: a real 288 KB binary SchDoc gave 23 MPN parameters, for example `04023A330JAT2A`, `MCP23016-I/SO` and `PCA9306D`. A PcbDoc alone gives designator + LibReference + footprint + description, and no parameter block (see KiCad's `ACOMPONENT6`).
- **A browser path exists today without a server.** `altiumts` (MIT, TypeScript, npm 0.0.76, pushed 2026-09-22) detects and reads binary and ASCII SchDoc/PcbDoc plus PrjPcb/OutJob. Its dependencies are `cfb` (Apache-2.0), `fflate` (MIT, already in our bundle) and `transformation-matrix` (MIT). MEASURED: it parsed the 288 KB SchDoc in 175 ms (Node, cold, 1,006 records, 481 parameter records). `altium-toolkit` (npm 1.4.18) is fuller and ships a renderer and a 3D scene. Its own licence is GPL-3.0-or-later, but it depends on `circuitjson-toolkit`, which is **AGPL-3.0-or-later**.
- **KiCad imports all of it, and its code is GPL-2.0-or-later.** That is compatible with our GPL-3.0-or-later programme, so the importer logic can be ported to TypeScript and emit `.kicad_sch`/`.kicad_pcb` text into our existing KiCanvas and reader pipeline. It is about 17.3k lines of C++, of which altium_pcb.cpp is 6,130 and sch_io_altium.cpp is 5,992.
- **Recommended order:**
  1. SchDoc → BOM lines (S–M).
  2. PrjPcb as the project manifest, including variants/DNP (S).
  3. SchDoc → rendered schematic, either via a TS port to kicad_sch or altiumts SVG behind the `CanvasController` seam (L).
  4. PcbDoc → kicad_pcb for the board, stackup and 3D tabs (L–XL).

## 1. Extensions, containers and detection

| Ext | Product | Container | Detect (first bytes / structure) | Holds |
|---|---|---|---|---|
| `.SchDoc` | Altium Designer, CircuitMaker (schematics are plain SchDoc) | CFB binary; legacy ASCII variant | CFB magic, then stream `FileHeader` whose first record has `HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0`. The ASCII form starts `\|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0` (lines ending `\|>` continue). Sources: KiCad `sch_io_altium.cpp:321-331,1683,1784`; `altium_ascii_parser.cpp` | Sheet, symbols (RECORD=1), pins, wires, net labels, ports, sheet symbols (hierarchy), parameters (RECORD=41), implementations/footprint links (44/45), harnesses, images (in `Storage` stream, zlib) |
| `.SchDot` | AD sheet template | as SchDoc | as SchDoc | Title block template |
| `.PcbDoc` | Altium Designer | CFB binary; legacy ASCII "PCB 5.0" | CFB with storages `Board6/Header` + `Board6/Data` (altiumts `detect-altium-file.ts`). ASCII: a line `\|RECORD=Board\|…` | Storages `<Name>6/{Header,Data}`: Board6 (layer stack/stackup, outline), Components6, Nets6, Classes6, Rules6, Pads6, Vias6, Tracks6, Arcs6, Fills6, Regions6, ShapeBasedRegions6, Polygons6, Texts6, Dimensions6, ComponentBodies6 (3D bodies), Models (embedded STEP, zlib), EmbeddedFonts6, WideStrings6, DifferentialPairs6… (KiCad `altium_pcb.h:37-84`) |
| `.CMPcbDoc` | CircuitMaker | CFB (PcbDoc layout) | CFB + Board6 | Same as PcbDoc; KiCad reads it with a different stream map (`pcb_io_altium_circuit_maker.cpp`) |
| `.CSPcbDoc` | CircuitStudio | CFB | as above | as above |
| `.SWPcbDoc`, `.PWPcbDoc` | SOLIDWORKS PCB / PCBWorks (Altium-powered) | CFB | as above | as above; AD imports both (Altium import-export doc) |
| `.SchLib` | AD symbol library | CFB (ASCII legacy exists) | `FileHeader` with `HEADER=Protel for Windows - Schematic Library Editor Binary File Version 5.0` (KiCad `sch_io_altium.cpp:5900`) | Symbols, with per-symbol parameters (can include MPN) |
| `.PcbLib` | AD footprint library | CFB | `FileHeader` text includes "PCB Library"; per-footprint storages with `Data` + `Parameters` streams | Footprints and 3D models |
| `.IntLib` | AD integrated library | CFB whose streams are **zlib-compressed nested CFB** SchLib/PcbLib (first byte `0x02` = compressed, `0x00` = raw; KiCad `altium_binary_parser.cpp:114-150`) | CFB + nested | Compiled symbols, footprints, models, parameters |
| `.PrjPcb` (also `.PrjMbd` multi-board, `.PrjScr` script, `.PrjFpg`, `.PrjEmb`) | AD project | INI text | `[Design]`, `[Document1]…` with `DocumentPath=` (altiumts `detect-altium-file.ts`) | Document list, project parameters `[ParameterN]`, variants `[ProjectVariantN]` with DNP / alternate-part / parameter overrides (KiCad `altium_project_variants.cpp`), output settings |
| `.OutJob` | AD output job | INI text | `[OutputJobFile]` / `OutputType=` keys | Output recipes only; no design data |
| `.BomDoc` | ActiveBOM | pipe-record ASCII | starts `\|RECORD=BOM\|VERSION=…\|KIND=ALTIUM_DESIGNER_LIVEBOM` (sample from luxonis/oak-hardware) | `RECORD=CatalogItem` rows with `DESIGNITEMID`, `COMPONENTPARAMETERS="Manufacturer=…","Manufacturer Part=…","Supplier Part=…"`; part-choice groups; options. It has no designators or quantities (those come from the schematic) |
| `.DsnWrk` | AD workspace / project group | INI | `[ProjectGroup]`/`[Workspace]` | List of projects |
| `.DbLib`, `.SVNDbLib`, `.DbLink` | Database libraries | INI | INI | ODBC/ADO links to company part tables (MPN lives in the external DB, not the file) |
| `.CmpLib` | Component library | XML (not verified by fetch) | XML root | Component definitions |
| `.LibPkg` | Integrated library package | INI | INI | Sources of an IntLib |
| `.PCBDwf` | Draftsman drawing | binary (altium-toolkit lists it as parseable) | n/a | Fabrication/assembly drawings |
| `.Harness`, `.MbsDoc`, `.MbaDoc` | Harness definitions, multi-board schematic/assembly | text/binary (unverified) | n/a | Multi-board system data |
| `.DDB` | Protel 99 SE design database | Microsoft Access/Jet database ("Access® Database DDB", Altium import-export doc) | Jet header | All 99SE docs in one DB |
| `.PCB` / `.SCH` / `.LIB` | Protel 2.8 ASCII, Tango, Autotrax, P-CAD 200x (Altium-owned lineage) | ASCII | varies | AD can still **export** "Protel PCB 2.8 ASCII" and P-CAD formats (Altium import-export doc). KiCad has a P-CAD ASCII importer (`kicad-cli pcb import --format pcad`, 10.0) |

CFB background: the container is [MS-CFB], a Microsoft Open Specification (https://learn.microsoft.com/en-us/openspecs/windows_protocols/MS-CFB/53989ce4-7b05-4f8d-829b-d08d6148375b). SchDoc stream framing, per python-altium `format.md`: 2-byte LE payload length, a 0 byte, a record-type byte, then the property list with a NUL terminator. Image records in `Storage` are `0xD0`, name length, name, 4-byte size and zlib data. Property keys are case-insensitive; newer files use mixed case (`|RECORD=41|…|Text=04023A330JAT2A|Name=Manufacturer Part Number`, MEASURED on a real file). Strings are CP-1252 with `%UTF8%`-prefixed duplicates for Unicode.

## 2. BOM / MPN value

- **SchDoc (best source).** `RECORD=1` components carry `LibReference`, `DesignItemId`, `ComponentDescription`, `SourceLibraryName`, `UniqueID` and part count (multi-part symbols). Child `RECORD=41` parameters carry whatever the library put there. Common names are `Manufacturer`, `Manufacturer Part Number`, `Manufacturer 1`/`Manufacturer Part Number 1` (system-reserved names that ActiveBOM auto-fills from Part Choices; Altium KB: https://www.altium.com/documentation/knowledge-base/altium-designer/manufacturer-parameters-overwritten-by-part-choices-in-exported-bom), and `Supplier n` / `Supplier Part Number n`, `Comment`, `Value`.
  - MEASURED on `pidp11-io-expander.SchDoc`: 23 × `Manufacturer Part Number` + 23 × `Supplier Part Number 1/2`.
  - The designator is a separate `RECORD=34` owned by the component; the part suffix (U4A) is computed at runtime (altium.js README).
  - The DNP / "not fitted" state lives in PrjPcb variants, not in the SchDoc.
- **Library conventions vary.** With Altium's "Unified Components" / Celestial libraries, `LibReference` **is** the MPN (MEASURED: `LibReference=04023A330JAT2A` in PowerSupply.SchDoc). Company libraries use custom names such as `MPN`, `Mfr Part #` or `ASiD Part Number`, so reuse our existing `headerAliases` role mapping for parameter names.
- **Workspace components (Altium 365 / Develop).** Part Choices live in the Workspace. What reaches the file is whatever parameters were placed on the component, plus ActiveBOM's BomDoc cache (https://www.altium.com/documentation/altium-designer/components-libraries/adding-supply-chain-information-component).
- **BomDoc.** `CatalogItem.COMPONENTPARAMETERS` includes manufacturer, MPN and supplier PN keyed by `DESIGNITEMID`. Use it as a fallback join to fill missing MPNs, never as the quantity source.
- **PcbDoc alone.** `Components6` has `SOURCEDESIGNATOR`, `SOURCELIBREFERENCE`, `PATTERN`, `SOURCEDESCRIPTION`, `SOURCEUNIQUEID` and the `COMMENTON` text (KiCad `altium_parser_pcb.cpp:683-716`). There is no MPN unless LibReference is one. That is enough for a designator/footprint BOM, but not for pricing in general.

## 3. Parsers

| Name | Lang | Licence | Status (GitHub API, 2026-09-24) | Scope |
|---|---|---|---|---|
| KiCad Altium importers (pcbnew/pcb_io/altium, eeschema/sch_io/altium, common/io/altium) | C++ | GPL-2.0-or-later (file headers) | Active; master commit 2026-09-24 | SchDoc (bin + ASCII), SchLib, PcbDoc, PcbLib, IntLib, CMPcbDoc, CSPcbDoc, SWPcbDoc, PrjPcb + variants. `.ksy` Kaitai specs (`altium_parser.ksy`, `altium_storage_parser.ksy`) document the binary. CFB via `thirdparty/compoundfilereader` (MIT) |
| tscircuit/altiumts | TS | MIT | 3 stars; created 2026-07-30; pushed 2026-09-22; npm 0.0.76 (1.6 MB unpacked) | Read binary + ASCII SchDoc/PcbDoc, PrjPcb, OutJob; ASCII edit/write. SchLib/PcbLib/IntLib are detection-only. Hosted browser viewer at altiumviewer.tscircuit.com (local parsing). MEASURED to parse a real SchDoc |
| SunboX/altium-toolkit | JS (ESM) | GPL-3.0-or-later (+ paid commercial option); **dep circuitjson-toolkit is AGPL-3.0-or-later** | 7 stars; created 2026-05-05; npm 1.4.18 (6.9 MB unpacked) + 4.6 MB dep | SchDoc, PcbDoc, PCBDwf, SchLib, PcbLib, PrjPcb, PrjScr, IntLib; SVG render, BOM HTML, 3D scene description, workers; "no network calls". Used by ecadforge.app |
| gsuberland/altium_js | JS | MIT | 143 stars; last push 2025-05-20 | SchDoc parse + browser render + CSV BOM. Its OLE reader handles one contiguous stream only (the README warns about files over about 55 MB) |
| vadmium/python-altium | Python | WTFPL | 195 stars; last code commit 2021-03-17 | SchDoc format doc (`format.md`), SVG/Tk viewer, `ascii.py`. It is the de-facto reference |
| wavenumber-eng/altium_monkey | Python | AGPL-3.0 | 203 stars; created 2026-04; pushed 2026-09-22 | Read/write/render SchDoc, PcbDoc, PrjPcb, OutJob, IntLib extraction |
| issus/AltiumSharp (OriginalCircuit.Altium 2.0) | C# | Apache-2.0 | 111 stars; pushed 2026-07-24 | Read/write SchLib, PcbLib, SchDoc, PcbDoc; SVG/raster/glTF render |
| a3ng7n/Altium-Schematic-Parser | Python | MIT | 51 stars; pushed 2026-01 | SchDoc → JSON |
| thesourcerer8/altium2kicad | Perl | GPL-2.0 | 954 stars; **archived** | Historic PcbDoc/SchDoc → KiCad; lineage cited in KiCad's `.ksy` |
| akiselev/altium-cli | Rust | **none (all rights reserved)** | 15 stars | CFB only, no ASCII PcbDoc; cannot be vendored |
| stevegrn/AtoK | C# | GPL-3.0 | last push 2021 | PcbDoc → KiCad |
| IntelligentElectron/universal-netlist | TS | Apache-2.0 | pushed 2026-09-22 | SchDoc via PrjPcb netlist + variants (MCP server) |
| AlexeyInwerp/BoardRipper | TS | AGPL-3.0 | pushed 2026-09-23 | Boardview renderer incl. PcbDoc/CMPcbDoc/CSPcbDoc (CFB + ASCII 5.0); `docs/formats/ALTIUM_PCB_FORMAT.md` |
| Huaqiu-Electronics/ecad-viewer | JS | MIT | 91 stars | KiCanvas fork. Altium support is **server-side**: files go to a `kicad-cli` service (`/convert_ad_to_kicad`) |
| SheetJS `cfb` | JS | Apache-2.0 | 1.2.2 | Generic CFB reader. **Already in our bundle**: the `xlsx` 0.20.3 tarball exports `CFB` (`xlsx.mjs` export list) |

## 4. KiCad import support (verified per release branch)

| Capability | First KiCad branch | Evidence |
|---|---|---|
| Altium PcbDoc, CircuitStudio CSPcbDoc and CircuitMaker CMPcbDoc boards, plus SchDoc schematics | **6.0** (2021-12) | `pcbnew/plugins/altium/{altium_designer,altium_circuit_studio,altium_circuit_maker}_plugin.cpp` and `eeschema/sch_plugins/altium/sch_altium_plugin.cpp` exist @6.0; 6.0 notes list "Altium Designer importer (Thomas Pointhuber)" |
| PcbLib footprint libraries | **7.0** | `FootprintEnumerate` appears in `altium_designer_plugin.h` @7.0 (absent @6.0) |
| SchLib symbol libraries + IntLib; SOLIDWORKS PCB `.SWPcbDoc` | **8.0** | 8.0 release notes; `pcb_io_solidworks.cpp` @8.0 |
| ASCII SchDoc | 8.0 branch (first commit 2024-02-29), listed in the **9.0** notes | `altium_ascii_parser.cpp` @8.0; KiCad 9.0 release notes |
| Import a whole Altium project (`.PrjPcb`) from the project manager | **9.0** | `OnImportAltiumProjectFiles` exists @9.0, not @8.0 |
| Altium project variants → KiCad variants; project parameters → text variables | **10.0** (first commit 2026-03-12) | `altium_project_variants.cpp` @10.0, absent @9.0 |
| Headless `kicad-cli pcb import --format altium` | **10.0** | `kicad/cli/command_pcb_import.cpp` @10.0 |
| Headless `kicad-cli sch import` | master only (11.0-dev) | `command_sch_import.cpp` on master, absent @10.0 |

Fidelity notes from the source:
- Binary PcbDoc only; there is no ASCII PcbDoc in KiCad (`checkFileHeader` = CFB magic only).
- Design rules are translated (`altium_rule_transformer`).
- Embedded STEP models are extracted (`ALTIUM_EMBEDDED_MODEL_DATA`).
- Parameter `COMMENT` maps to KiCad Value, and Altium `VALUE` is kept as `ALTIUM_VALUE` (`sch_io_altium.cpp:5304-5460`).
- Layer mapping is interactive (`LAYER_MAPPABLE_PLUGIN`).

## 5. Browser paths (ranked)

1. **Our own TS reader on altiumts, feeding our existing model (recommended).**
   - Detect by magic and stream names, then parse SchDoc records. Build `BomLine`s from RECORD=1/34/41 (designator, qty, LibRef, MPN/manufacturer via the parameter-name aliases). Apply PrjPcb variants for DNP.
   - This drops into `services/bom/*` and `useBomWorkbench`, and keeps "your design files never leave your browser" true.
   - CFB via altiumts's `cfb`, or reuse xlsx's `CFB` to avoid a second copy.
2. **Altium → KiCad text converter in TS.** Port KiCad's GPL-2.0+ `sch_io_altium`/`altium_pcb` to emit `.kicad_sch`/`.kicad_pcb`, so KiCanvas, stackup and 3D work unchanged. The mapping is proven and licence-clean, but it is a large port: about 12k lines of C++ for the two main files. The PCB half needs the binary primitive structs (see `altium_parser_pcb.cpp` and `.ksy`).
3. **Dedicated renderer behind `CanvasController`.** Use altiumts SVG (MIT), or altium-toolkit's renderer and 3D scene. altium-toolkit is the most complete, but pulling in AGPL `circuitjson-toolkit` puts AGPL §13 obligations on the served page. It is also about 11 MB unpacked.
4. **KiCad-as-WASM.** The importers depend on wxWidgets (`wxString`, `wxZlibInputStream`, `wxFileConfig`), so this is XL.
5. **Server `kicad-cli pcb import`** (10.0; the schematic command is only on master). This is ecad-viewer's approach. It breaks the no-upload promise; do not adopt it unless the owner changes that promise.

Altium's own Altium 365 Viewer (https://www.altium.com/viewer/) uploads SchDoc, PcbDoc, Eagle, KiCad (beta), Gerber and ODB++ to Altium's cloud. A local-only Altium viewer is a real differentiator.

## 6. Cloud: Altium 365, Altium Develop, CircuitMaker

- **Altium 365 / Altium Develop / Agile** (the product names as of Oct 2025 on the docs banner). Projects are still native SchDoc/PcbDoc files under Workspace version control. Opening a CircuitMaker A365 project writes local `*.SchDoc` + `*.CMPcbDoc` (https://www.altium.com/documentation/knowledge-base/altium-designer/importing-circuitmaker-projects-from-altium-365). There is no separate cloud-only file format to support.
- **Nexar Design API** (GraphQL, OAuth, requires the user's A365 workspace; https://support.nexar.com/support/solutions/articles/101000434423-make-your-first-altium-365-design-data-query). It could pull BOM/part choices server-side, but it is vendor-gated and competes with our own catalogue. Treat it as optional.

## 7. Altium export options (a user's fallback when we cannot read native)

- Fabrication outputs: Gerber RS-274X and Gerber X2, ODB++, IPC-2581, NC Drill (https://www.altium.com/documentation/altium-designer/preparing-for-manufacture/output-jobs/fabrication-data).
- Save As / Export to earlier formats: 99 SE (V4), Protel PCB 2.8 ASCII, P-CAD V16 schematic/PCB, CircuitMaker and CircuitStudio PCB (https://www.altium.com/documentation/altium-designer/design-tools-interfacing/altium-design-software-import-export).
- The legacy ASCII SchDoc/PcbDoc exist, and parsers read them. Whether current AD still offers ASCII PcbDoc in Save As was **not verified**.
- IPC-2581 carries BOM with manufacturer parts when populated. That is a separate slice; it is the cleanest universal fallback.

## 8. Licensing risk (GPL-3.0-or-later client bundle)

- **Compatible:** KiCad importer code (GPL-2.0-or-later), altiumts (MIT), cfb (Apache-2.0), fflate (MIT), altium_js (MIT), python-altium (WTFPL, as a reference), AltiumSharp (Apache-2.0, as a reference).
- **Compatible but viral / network clause:** altium-toolkit (GPL-3.0+) + circuitjson-toolkit (AGPL-3.0+), altium_monkey (AGPL-3.0), BoardRipper (AGPL-3.0).
- **Unusable:** akiselev/altium-cli (no licence).
- **Altium EULA §3.3** forbids licensees to "decompile, reverse engineer, disassemble" the *Licensed Materials* (the software), and preserves EU interoperability decompilation rights (EULA PDF 2025, https://cdn.files.altium.com/sites/default/files/2025-10/altium_license_agreement_en_2025.pdf). It binds Altium licensees about Altium's software, not third parties reading their own users' design files. Risk is low if we build only from open-source parsers and public docs, never from decompiling Altium binaries, and use no Altium trademarks beyond nominative "opens Altium files".
- The file format itself is undocumented by Altium.

## 9. Effort

| Item | Effort | Why |
|---|---|---|
| Detect every Altium extension by magic/stream/header and name it in intake | S | Signatures above; altiumts already has `detectAltiumFile` |
| SchDoc (bin + ASCII) → priced BOM | S–M | altiumts gives records; the work is multi-part designators, hierarchy (sheet symbols → child SchDocs via PrjPcb), parameter-name aliasing |
| PrjPcb (docs, variants/DNP, parameters) | S | INI; KiCad variants code is a reference |
| BomDoc as MPN fallback | S | Pipe text |
| SchDoc render | M (altiumts SVG behind `CanvasController`) / L (port to kicad_sch for KiCanvas) | Fonts, IEEE symbols, harnesses, images |
| PcbDoc → board, stackup, 3D | L–XL | Binary primitive structs, polygons/regions, padstacks, embedded STEP, layer mapping; about 6k lines of reference C++ |
| CMPcbDoc / CSPcbDoc / SWPcbDoc | +S on top of PcbDoc | Same container, different stream map |
| SchLib / PcbLib / IntLib | M | Library content, not a design; low priority for the viewer |
| Protel 99 SE DDB, P-CAD, Protel 2.8 ASCII | M–L each | Legacy; defer |

## Sources

- KiCad source: https://gitlab.com/kicad/code/kicad (master d1191971; branch checks via the GitLab API `repository/files?ref=6.0…10.0`)
- KiCad release notes: https://www.kicad.org/blog/2021/12/KiCad-6.0.0-Release/ · https://www.kicad.org/blog/2024/02/Version-8.0.0-Released/ · https://www.kicad.org/blog/2025/02/Version-9.0.0-Released/ · https://www.kicad.org/blog/2026/03/Version-10.0.0-Released/
- https://github.com/vadmium/python-altium (format.md)
- https://github.com/tscircuit/altiumts (docs/compatibility.md, lib/parser/detect-altium-file.ts)
- https://github.com/SunboX/altium-toolkit · https://www.npmjs.com/package/circuitjson-toolkit
- https://github.com/gsuberland/altium_js · https://github.com/wavenumber-eng/altium_monkey · https://github.com/issus/AltiumSharp
- https://github.com/Huaqiu-Electronics/ecad-viewer · https://github.com/AlexeyInwerp/BoardRipper · https://github.com/akiselev/altium-cli
- https://www.altium.com/documentation/altium-designer/design-tools-interfacing/altium-design-software-import-export
- https://www.altium.com/documentation/altium-designer/components-libraries/adding-supply-chain-information-component
- https://www.altium.com/documentation/knowledge-base/altium-designer/manufacturer-parameters-overwritten-by-part-choices-in-exported-bom
- https://www.altium.com/documentation/knowledge-base/altium-designer/importing-circuitmaker-projects-from-altium-365
- https://www.altium.com/documentation/altium-designer/preparing-for-manufacture/output-jobs/fabrication-data
- https://www.altium.com/viewer/
- https://cdn.files.altium.com/sites/default/files/2025-10/altium_license_agreement_en_2025.pdf
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/MS-CFB/53989ce4-7b05-4f8d-829b-d08d6148375b
- https://support.nexar.com/support/solutions/articles/101000434423-make-your-first-altium-365-design-data-query
- Sample BomDoc: https://github.com/yasir-shahzad/STM32-ST-Link-V2.0-Programmer (hardware/ST_LINK_V2-1.BomDoc) · https://github.com/luxonis/oak-hardware
