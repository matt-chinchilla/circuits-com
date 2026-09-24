# EAGLE / Fusion Electronics family — format dossier for the Design Viewer

Researched 2026-09-24. Scope: Autodesk (ex-CadSoft) EAGLE, Autodesk Fusion Electronics, and the tools nearest to it: DesignSpark PCB (RS / Number One Systems Easy-PC lineage) and TARGET 3001! (Ing.-Büro Friedrich).
Raw evidence (scrapes, KiCad sources, sample files, hexdumps) is in `eagle-fc/` next to this file.

---

## 0. Summary

| Format | Container | Parse in browser? | BOM with MPNs? | Verdict |
|---|---|---|---|---|
| EAGLE 6.0+ `.sch` / `.brd` / `.lbr` (XML) | XML, **published DTD (CC BY-ND 3.0, explicitly allows reader implementations)** | Yes. Plain XML, ~1 file per view | Yes, when the libraries carry `MPN`/`MF` attributes (common in CadSoft/Farnell, SnapEDA and similar libraries); otherwise value + package | **Build it first.** Size L to reach the KiCad path's level (BOM + stackup + 3D + drawings) |
| Fusion `.fsch` / `.fbrd` / `.flbr` | **ZIP containing the EAGLE XML file plus a thumbnail** | Yes (we already ship fflate) | Same as EAGLE | Size S on top of the EAGLE XML reader |
| Fusion "EAGLE 9.X compatible" export `.sch`/`.brd` | EAGLE XML, `version="9.7.0"` | Yes | Same | No extra work |
| EAGLE ≤5.x binary `.sch` / `.brd` / `.lbr` | 24-byte-record binary, magic `10 00` (v4/5) / `10 80` (v3) | Possible (port pcb-rnd's or KiCad's GPL decoder) | Weak (attributes arrived in v5) | Recognize it and refuse it by name for now; port it later if people upload these files |
| Fusion `.f3d` / `.f3z` | `.f3z` = ZIP of `.f3d`; `.f3d` proprietary | No | — | Recognize it and refuse it with export instructions |
| DesignSpark PCB `.sch` / `.pcb` / `.prj` | **OLE CFB** (same magic as Altium) + MFC CArchive `Contents` stream | No public spec, no parser | Yes in the data (`Manufacturer_Part_Number`, `RS Part Number`, as seen in a real file), but we can't read it | Recognize it and refuse it; ask for ODB++ / IPC-2581 / Gerber + CSV |
| TARGET 3001! `.T3001` | Proprietary binary | No | — | Recognize it and refuse it; TARGET can **export the project as EAGLE XML**, which we then read |

---

## 1. EAGLE status, lineage and migration

- CadSoft → Premier Farnell (24 Sep 2009) → Autodesk (27 Jun 2016). XML file format introduced in 5.91 (2011), and 6.0+ writes XML only. 8.0 (2017) went subscription-only and its files are not backward-compatible with 7.x. The last standalone release was 9.6.2 (27 May 2020). **Fusion Electronics files carry version 9.7.0.** — https://en.wikipedia.org/wiki/EAGLE_(program)
- **End of life: 7 June 2026** (already passed). EAGLE can no longer be downloaded, and its licensing no longer works. Autodesk: "Autodesk Fusion is fully compatible with native EAGLE files and can be opened directly through its user interface." — https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Autodesk-EAGLE-Announcement-Next-steps-and-FAQ.html ; https://www.autodesk.com/products/fusion-360/blog/future-of-autodesk-eagle-fusion-360-electronics/
- Consequence for us: the installed base is a large archive of existing `.sch`/`.brd` files, and those owners are now being pushed to migrate. The owner of an old EAGLE design who has no licence anymore is exactly who a browser viewer helps. OSH Park still takes EAGLE `.brd` uploads directly (https://docs.oshpark.com/design-tools/eagle/), so the files are still traded as-is.
- Rough scale (GitHub code-search index counts, 2026-09-24): `"DOCTYPE eagle"` in `.brd` ≈ 45,952; in `.sch` ≈ 24,640; in `.lbr` ≈ 28,672 (for comparison, KiCad-legacy `EESchema Schematic File Version` in `.sch` ≈ 83,328).

---

## 2. Extensions (EAGLE + Fusion)

| Ext | What | Container | Notes |
|---|---|---|---|
| `.sch` | Schematic (all sheets + embedded copies of used libraries) | XML (6+) / binary (≤5) | Extension **collides** with KiCad-legacy `.sch`, DesignSpark `.sch`, gEDA/Lepton `.sch` → always sniff the content |
| `.brd` | Board (layout + embedded packages + element attributes) | XML / binary | Collides with Allegro `.brd` and repair "boardview" `.brd` formats |
| `.lbr` | Library (packages, packages3d refs, symbols, devicesets) | XML / binary | KiCad reads it as a footprint lib (pcbnew) and a symbol lib (eeschema, 8.0+) |
| `.fsch` / `.fbrd` / `.flbr` | Fusion local copies of schematic / board / library | **ZIP containing EAGLE XML + thumbnail** | Autodesk's Matt Berggren: "The FBRD, FSCH, FLBR files … are zip files … Rename them and unzip them and eagle XML is inside … enables us to bundle a thumbnail" — https://www.eevblog.com/forum/eagle/eagle-will-be-part-of-fusion360/25/ (reply #29, 2020-01-24). InteractiveHtmlBom opens `.fbrd` by unzipping and picking the `.brd` member: https://github.com/openscopeproject/InteractiveHtmlBom/blob/master/InteractiveHtmlBom/ecad/fusion_eagle.py |
| `.fprj` | Fusion "Electronics Design" (the doc that links schematic + board + 3D PCB) | cloud document | "These file types are not downloadable (.fsch => .ElectronicsSchematic, .fbrd => .ElectronicsBoard, .fprj => .ElectronicsDesign)" — https://forums.autodesk.com/t5/fusion-design-validate-document/autodesk-fusion-360-f3d-f3z-fsch-fbrd-flbr/td-p/9897711 |
| `.f3d` / `.f3z` | Fusion archive of one design / of a distributed design | `.f3z` "is a ZIP file that contains one or more F3D files"; `.f3d` is proprietary | https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-make-a-local-archive-back-up-file-in-Fusion-360.html |
| `.dru` | Design rules | text | pcb-rnd imports it (http://www.repo.hu/projects/pcb-rnd/datasheet.html). A board also embeds its rules in `<designrules>` |
| `.cam` | CAM processor job | text | Not needed |
| `.ulp` / `.scr` | User Language program / command script | text | Code and scripts, never design data. Ignore them |
| `.epf` | EAGLE project file (window/session state) | text | No design data (not re-verified here) |
| `.b#1…9`, `.s#1…9`, `.l#1…9` | Numbered backups of brd/sch/lbr | same format as the original | EAGLE convention (not re-verified in this pass). Sniffing the content handles them |
| Fusion Gerber job | `Copper_Top_L1.gbr`, `Profile.gbr`, `Soldermask_Top.gbr`, … + `.gbrjob` + Excellon `.xln` + BOM `.txt` + pick-and-place `_Front.txt`/`_Back.txt` | Gerber/Excellon | https://www.autodesk.com/products/fusion-360/blog/how-to-export-gerber-and-odb-manufacturing-files-in-autodesk-fusion/ (belongs in the Gerber slice) |
| Fusion ODB++ | `.tgz` / `.tar` / folder | ODB++ | Same page. Fusion has exported ODB++ since the Aug 2021 update. **IPC-2581 not supported** (Autodesk KB, 1 Oct 2025): https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Does-Fusion-Electronics-support-IPC-2581.html |

Fusion File→Export offers "EAGLE 9.X schematic compatible Files (*.sch)" and "… brd compatible Files (*.brd)", e.g. https://www.flashpcb.com/blog/Fusion360-export. **This is the escape hatch we tell Fusion users about.**

---

## 3. Detection signatures (for the intake)

1. **EAGLE XML**: optional UTF-8 BOM, `<?xml version="1.0" encoding="utf-8"?>`, `<!DOCTYPE eagle SYSTEM "eagle.dtd">`, root `<eagle version="9.1.3">` (the version string was `V.RR` in older DTDs and three-part since 8.x). The child of `<drawing>` decides the kind: `<schematic>`, `<board>` or `<library>` (DTD: `<!ELEMENT drawing (settings?, grid?, layers, (library | schematic | board))>`). KiCad's check reads up to 8 lines looking for `<eagle` (`pcbnew/pcb_io/eagle/pcb_io_eagle.cpp` `checkHeader`, `eeschema/sch_io/eagle/sch_io_eagle.cpp` `checkHeader`). Classify by the `<drawing>` child, **never** by extension, because backups and Fusion exports keep the XML but change the name.
2. **EAGLE binary (≤5.x)**: first two bytes `0x10 0x00` (v4/v5) or `0x10 0x80` (v3). The stream is fixed 24-byte records, section `0x1000` = start, `0x1500` = library. — `common/io/eagle/eagle_bin_parser.{h,cpp}` in KiCad master (`EAGLE_BIN_PARSER::IsBinaryEagle`).
3. **Fusion `.fsch/.fbrd/.flbr`**: `PK\x03\x04`. Unzip and take the single member ending in `.sch`/`.brd`/`.lbr`, then apply rule 1.
4. **`.f3z`**: `PK\x03\x04` with `.f3d` members. **`.f3d`**: anything else under that name. Refuse both.
5. **KiCad legacy `.sch`**: first line `EESchema Schematic File Version N` (`SCHEMATIC_HEAD_STRING` in `eeschema/sch_io/kicad_legacy/sch_io_kicad_legacy.h`). **This is how to tell it from EAGLE `.sch`: EAGLE starts `<?xml`/`<!DOCTYPE eagle`/`<eagle`, KiCad-legacy starts with the `EESchema` text line, and binary EAGLE starts `0x10`.**
6. **DesignSpark PCB `.sch`/`.pcb`**: OLE CFB magic `D0 CF 11 E0 A1 B1 1A E1` (same as Altium `.SchDoc/.PcbDoc`). It is distinguished by its stream set: `\x05FileType` holds the ASCII text `PCB Design\n` or `Schematic Design\n`, plus `\x05SummaryInformation` and one big `Contents` stream that starts with MFC CArchive class tags (`FF FF 01 00 <len> "CAreaArray"` for a PCB, `"CNetClassArray"` for a schematic). `.prj` is a small non-CFB MFC stream containing `CProjectItem` and the member file names. (Verified on 4 real files: github.com/eChook/eChook-Nano-PCB, damienmaguire/Tesla-Drive-Unit, helioz2000/DS_PCB. Hexdumps are in `eagle-fc/dsp/`.)
7. **TARGET 3001! `.T3001`**: proprietary binary. On two samples (github.com/SimonWaldherr/Target3001-templates-and-examples, palsbo/ESP8266-12F-Testboard) it starts with a 4-byte LE integer (`24 27 00 00`, `3B 27 00 00`) followed by length-prefixed strings `05 00 00 00 "Arial"`, `0C 00 00 00 "DIN-ISO-ANSI"`. That is a heuristic from two samples, so match on the extension + this prefix.
8. Other `.sch` owners to exclude: gEDA/Lepton (first line `v <date> <n>`), OrCAD SDT / P-CAD (other slices).

---

## 4. What the EAGLE XML holds (and what matters for us)

DTD sources: 7.1.0 (CadSoft 2014, https://github.com/openpnp/openpnp/blob/develop/src/main/resources/eagle.dtd), 8.3.2 (https://github.com/meyskens/docker-eagle/blob/master/eagle/doc/eagle.dtd), 9.2.2 (https://github.com/NVSL/Swoop/blob/master/eagle-9.2.2.dtd). Licence text in every DTD: "made available under the creative commons 'CC BY-ND 3.0' license … You may use this file to implement a program that reads and/or writes files in the EAGLE File Format."

- **Units** are always mm, whatever the editor's grid (https://github.com/AlexeyInwerp/BoardRipper/blob/main/docs/formats/EAGLE_BRD_FORMAT.md).
- **Schematic**: `libraries` (full copies of used library devicesets/symbols/packages), `attributes`, `variantdefs`, `classes`, `modules` (hierarchy, 7.0+/8.x), `parts`, `sheets` (instances, nets, busses, `moduleinsts`).
- **Board**: `plain`, `libraries` (packages only: no devicesets, verified on a 9.5.2 board), `attributes`, `variantdefs`, `designrules`, `elements`, `signals` (wires, vias, polygons, contactrefs), and in 9.x `fusionsync`, `mfgpreviewcolors` (fab preview colours).
- **Stackup**: only in `designrules` params: `layerSetup` (e.g. `(1*16)`), `mtCopper` (per-layer copper thickness), `mtIsolate` (dielectric thicknesses). There is no dielectric material, surface finish or mask colour (a 9.x board may carry `mfgpreviewcolors`). KiCad's importer ignores these params entirely. A stackup tab would have to derive from them.
- **Pours**: `<polygon>` stores vertices plus `pour`/`isolate`/`orphans`/`thermals`/`rank` only. **No computed fill is stored** (DTD `<!ELEMENT polygon (vertex)*>`), so copper pours are "unfilled" just like KiCad's un-refilled zones. Our 3D path already has this caveat.
- **3D**: 9.x `package3d` elements are `urn:adsk.eagle:package:…` references to Autodesk's cloud, not geometry. The existing courtyard/estimate body approach still applies.
- **Variants / DNP**: `<variantdef name current>`; per part or element `<variant name populate="no" value technology>` (DTD). KiCad master maps `populate=no` → DNP and variant value/technology → variant fields (`sch_io_eagle.cpp` ~L2142-2207).

### BOM / MPN — can we price it?
- Attributes are free-form `<attribute name value>` on **library `<technology>`** (per device variant), overridable on the schematic `<part>`, and **copied onto board `<element>` with `display="off"`**. Verified: a 9.5.2 `.brd` carried `MF`, `MPN=REG1117`, `OC_FARNELL=1097566`, `OC_NEWARK=14P6981` on element IC2 (github.com/dekuNukem/duckyPad `pcb/old/V2/lul.brd`). **So a lone `.brd` can yield a priced BOM**, and so can a `.sch` once each part is resolved through part → library/deviceset/device/technology.
- Common attribute conventions:
  - `MF` + `MPN` + distributor order codes `OC_FARNELL` / `OC_NEWARK` (CadSoft/Premier Farnell libraries). About 7,648 GitHub `.sch` files have `attribute name="MPN"`.
  - SnapEDA exports `MF`/`MPN`/`SNAPEDA_PN`.
  - SparkFun uses `PROD_ID`, their internal SKU, which is **not** an MPN. About 9,696 `.brd` files have it.
  - Many hobby parts carry only `value` ("560K") + package ("0805"). Those need the same value/footprint fallback the KiCad path uses.
- Exclude from the BOM any part whose device has no `package` (supply symbols like `+3V3`, frames). Dedupe by designator (`part name`). Multi-gate devices are one part with several `<instance gate=…>` rows.
- Mirror KiCad's attribute→field mapping so a KiCad-imported and a direct-read EAGLE design give the same BOM.

---

## 5. Parsers and prior art

| Name | Lang | Licence | URL | Maturity |
|---|---|---|---|---|
| KiCad EAGLE importers (`pcb_io_eagle`, `sch_io_eagle`, `eagle_parser`) | C++ | GPL-2.0-or-later (board, parser) / **GPL-3.0-or-later** (schematic) | https://gitlab.com/kicad/code/kicad/-/tree/master/pcbnew/pcb_io/eagle , `/eeschema/sch_io/eagle`, `/common/io/eagle` | Mainline, active. Board since 4.0.0, schematic + project since **5.0.0** (the tag 5.0.0 has `eeschema/sch_eagle_plugin.cpp`; 4.0.0 does not). Symbol-library `.lbr` via `GetLibraryDesc` since 8.0. Does **not** read `.fbrd/.fsch` |
| KiCad `EAGLE_BIN_PARSER` (pre-v6 binary → synthetic XML DOM) | C++ | GPL-2.0-or-later (ported from pcb-rnd `eagle_bin.c`, © Palinkas/Heinzle 2017) | https://gitlab.com/kicad/code/kicad/-/blob/master/common/io/eagle/eagle_bin_parser.cpp | **Master only.** First commit 46368ddc on 2026-06-03 "pcbnew: read pre-v6 binary Eagle boards", schematics f81ea66f on 2026-06-17, detection 652e573c on 2026-08-30. Absent from 10.0.6 (404), so it will ship in 11.0 |
| `kicad-cli pcb import --format eagle` | C++ | GPL | https://gitlab.com/kicad/code/kicad/-/blob/10.0.6/kicad/cli/command_pcb_import.cpp | Ships in 10.0. `kicad-cli sch import` exists on master only. Useful to generate **reference output for tests** offline. Running it on a server would break "files never leave your browser" |
| pcb-rnd `io_eagle` | C | GPL-2.0-or-later | http://www.repo.hu/projects/pcb-rnd/ (svn trunk/src_plugins/io_eagle) | Boards XML 6-8 + binary 3-5, `.lbr` XML/binary footprints, `.dru`. **sch-rnd does NOT load EAGLE schematics** (http://www.repo.hu/projects/sch-rnd/datasheet.html) |
| LibrePCB `parseagle` | C++/Qt | **MIT OR Apache-2.0** | https://github.com/LibrePCB/parseagle | Small typed DOM, pushed 2026-05-11. Backs LibrePCB's EAGLE **project** import (1.1.0, 2024-04-03, https://librepcb.org/blog/2024-04-03_release_1.1.0/) |
| InteractiveHtmlBom `fusion_eagle.py` | Python | MIT | https://github.com/openscopeproject/InteractiveHtmlBom | ★4.5k, pushed 2026-09-10. Reads `.brd` and `.fbrd` (zip). Best reference for EAGLE board → pads/tracks/zones/BOM in a browser-rendered view |
| BoardRipper `eagle-parser.ts` | TypeScript | **AGPL-3.0** | https://github.com/AlexeyInwerp/BoardRipper | Pushed 2026-09-23. XML `.brd` for board-view repair (pins/nets). Refuses binary. Good format notes in `docs/formats/EAGLE_BRD_FORMAT.md` |
| `@tscircuit/eagle-xml-converter` | TypeScript | MIT (package.json) | https://github.com/tscircuit/eagle-xml-converter | Archived 2024-03. XML→typed JSON via fast-xml-parser. Useful as type definitions |
| Omniblox `Eagle-Loader` | JS (three.js r79) | MIT | https://github.com/Omniblox/Eagle-Loader | 2019, ★19, "not 100% accurate". `.brd` → 3D |
| `eagle-to-svg` | JS | MIT | https://github.com/dvdfreitag/eagle-to-svg | 2016, stale |
| `jspcb` | JS | MIT | https://github.com/firepick/jspcb | 2016, stale. EAGLE `.brd` XML for pick-and-place |
| Swoop | Python | **GPL-2.0-only** (not compatible with our bundle) | https://github.com/NVSL/Swoop | 2021. Ships the 9.2.2 DTD |
| qt_eagle_xml_parser | C++/Qt | LGPL-3.0 | https://github.com/martonmiklos/qt_eagle_xml_parser | Archived 2019 |
| mango-cad | Java | Apache-2.0 | https://github.com/maehem/mango-cad | EAGLE-clone, 2025 |
| GerberTools EagleLoaders | C# | MIT | https://github.com/ThisIsNotRocketScience/GerberTools | Active 2026-03 |
| lachlanA eagle-to-kicad | ULP (runs inside EAGLE) | GPL-2.0 | https://github.com/lachlanA/eagle-to-kicad | ★429, 2022. Needs an EAGLE install |

---

## 6. Browser paths (ranked)

**A. Our own TypeScript EAGLE-XML reader → the existing KiCad-shaped pipeline (recommended).**
1. Intake: sniff (section 3). Unzip `.fbrd/.fsch/.flbr` with fflate. Pair `name.sch` + `name.brd` by basename, as EAGLE does. Parse XML in the worker with our own small tokenizer (no `DOMParser` in workers; BoardRipper did the same) or fast-xml-parser (MIT).
2. **BOM first** (size S–M): part → library/deviceset/device/technology attribute resolution, part overrides, variants/DNP, supply-part exclusion, designator dedupe, attribute-name aliases (`MPN`, `MANUFACTURER_PART_NUMBER`, `MF`/`MANUFACTURER`, order codes `OC_*`) into the existing `parseBom`/`bom/match` identity fields. This alone makes EAGLE designs priceable.
3. **Board data → the existing 3D and stackup modules** (size M): elements plus embedded packages (`smd`/`pad`/`wire`/`polygon`/`hole`), signals, dimension layer 20 as the outline, and `designrules` for stackup.
4. **Drawings** (size L): either (a) emit KiCad S-expression text in memory and hand it to the vendored KiCanvas (reuses the renderer seam, selection and search; port the layer/rotation/text/arc mapping from KiCad's GPL-2+/GPL-3+ importers, which is licence-compatible with our GPL-3.0-or-later programme), or (b) write a `CanvasController` implementation that draws EAGLE directly. (a) is less code and keeps one renderer. KiCanvas keys its virtual FS by basename, so synthesize `name.kicad_sch`/`name.kicad_pcb`.

**B. WASM build of KiCad's importers.** None exists. It needs wxWidgets/wxXml, so size XL. Not recommended.

**C. Server-side `kicad-cli pcb import`.** Breaks the privacy promise. Use it only offline to produce golden fixtures for tests of path A.

**Binary pre-6**: port KiCad's `EAGLE_BIN_PARSER` (~3,000 lines, output is an XML-shaped tree, so path A consumes it unchanged). Size L, low demand (files from 2011 or earlier). For now, refuse it by name ("saved by EAGLE 5 or older — open and re-save in EAGLE 6+/Fusion, or KiCad 11").

**Fusion `.f3d/.f3z`, DesignSpark, TARGET 3001!**: recognize each one by name and show export instructions:
- Fusion: File → Export → "EAGLE 9.X … compatible (*.sch / *.brd)".
- DesignSpark: ODB++ (all tiers), or IPC-2581 (Engineer tier), or Gerber + CSV reports. Tier list: https://www.rs-online.com/designspark/which-file-formats-can-i-import-and-export-from-designspark-pcb
- TARGET: "Export project as Eagle XML file" (https://server.ibfriedrich.com/wiki/ibfwikien/index.php/Data_exchange/Documentation). We read that output directly.

---

## 7. Near relatives

### DesignSpark PCB (RS Components; Easy-PC lineage)
- Native: `.prj` project, `.sch` schematic, `.pcb` board. Libraries: `.ssl` (schematic symbol lib), `.psl` (PCB symbol/footprint lib), `.cml` (component lib), plus index variants `.ssx/.psx/.cmx` asked about on RS's forum (https://www.rs-online.com/designspark/library-file-extension-meanings). Also `.ssy`/`.psy`/`.cmp` single items, `.stf`/`.ptf` technology files, `.pnl` panels, `.elt` Easy-PC library transfer, `.bct` BOM Composer template.
- Import: native plus **EAGLE `.brd`/`.sch`, "Eagle Intermediate" `.eip`/`.eis`**, OrCAD netlists, and (Engineer tier) BoardMaker, Ultiboard `.ddf`, UltiCAP.
- Export: Gerber 274-D/X/X2, Excellon `.drl`, **ODB++ (`.tgz`)**, IDF, DXF, PDF, netlists, SPICE, and **IPC-2581 (`.cvg`) on the Engineer tier**. Source: https://www.rs-online.com/designspark/which-file-formats-can-i-import-and-export-from-designspark-pcb
- Container: **OLE CFB with an MFC CArchive `Contents` stream** (section 3.6). No spec and no parser found on GitHub or npm.
- Strings in a real board: `CComponent`, `CPcbComponent`, `CAttribute`, and attribute names `RS Part Number`, `Allied_Number`, `Manufacturer_Name`, **`Manufacturer_Part_Number`**, `3D Package`, `Height`. So the MPN data is in the file, but we can't reach it without reverse engineering.
- Licensing: DesignSpark PCB is free to use behind an RS account and EULA. Reverse engineering was not reviewed. Size XL.

### TARGET 3001! (Ing.-Büro Friedrich)
- One project file `*.T3001` (schematic + layout together) in proprietary binary. Libraries `*.sym3001`/`*.pck3001`. Old EAGLE 3.5-4.1 conversion went through ULPs to ASCII `.TXT`. Current TARGET imports EAGLE **XML only** (https://server.ibfriedrich.com/wiki/ibfwikien/index.php/Convert_Eagle_to_TARGET_3001!).
- Exports: Gerber/Excellon, DXF, PDF, HPGL, IDF, STEP, OBJ, POV, GenCAD, FABmaster, **EAGLE XML project**, BOM, netlist (https://server.ibfriedrich.com/wiki/ibfwikien/index.php/Data_exchange/Documentation). The vendor says "Direct converters from other CAD systems to TARGET 3001! … currently are not planned" (https://server.ibfriedrich.com/wiki/ibfwikien/index.php?title=CAD_formats).
- No parser exists. Size XL. Route users through "Export project as Eagle XML".

### Other EAGLE consumers (they show the ecosystem, not parsers we can use)
LibrePCB 1.1+ (project import), EasyEDA (EAGLE import), OSH Park and other fabs (upload `.brd`), PCB-Investigator (https://www.pcb-investigator.com/en/features/import-export/eagle-import/), DesignSpark PCB, TARGET 3001!.

---

## 8. Licensing for a GPL-3.0-or-later browser bundle
- EAGLE XML: the DTD is CC BY-ND 3.0 and explicitly permits implementing readers. We don't need to ship the DTD. There is no reverse-engineering question.
- Code we could port: KiCad (GPL-2+/GPL-3+), pcb-rnd (GPL-2+), parseagle (MIT/Apache-2.0), IBOM / tscircuit / Omniblox / jspcb / eagle-to-svg (MIT). All are fine.
- Swoop is GPL-2.0-**only**: don't combine it.
- BoardRipper is AGPL-3.0: legally combinable with GPL-3 (§13), but it adds the network-use clause. Read it, don't vendor it.
- Binary EAGLE ≤5: community reverse engineering by pcb-rnd (2017). Porting that GPL code is licence-clean. Autodesk's EULA binds licensees, not us (not legal advice).
- DesignSpark / TARGET / `.f3d`: undocumented binaries under vendor EULAs. Clean-room reverse engineering would need owner and counsel sign-off.
