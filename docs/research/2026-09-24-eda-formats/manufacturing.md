# Manufacturing & exchange formats: dossier for the /viewer

Slice: fabrication, assembly, test and ECAD↔MCAD outputs. Researched 2026-09-24 with Firecrawl (search and scrape), the GitLab API against `kicad/code/kicad` master, the GitHub API, the npm and crates.io registries, and specs and sample files downloaded and read locally. Raw material is in `scratchpad/eda-formats/fc/`.

## TL;DR: what matters for Circuit Center

1. **The most likely wrong drop is a fab-output ZIP.** It holds Gerbers, drill files, a `.gbrjob` and often a BOM/CPL CSV. Today `project.ts` answers it with "No KiCad files in what was dropped" (`'empty'`). A recogniser (S effort) could:
   - name what was dropped and which CAD tool produced it;
   - send any BOM or CPL CSV inside it to `/bom`, which already prices CSV and XLSX;
   - later, open the Gerbers.

   Tracespace's MIT `identify-layers` rules and gerbonara's Apache-2.0 `layer_rules.py` already cover filename conventions for KiCad, Altium/Protel, Eagle (legacy, OSH Park, PCB:NG), OrCAD, Allegro, gEDA, DipTrace, Target, Siemens, PADS and Zuken.
2. **Only four formats in this slice can carry a manufacturer part number (MPN) you could price:**
   - **IPC-2581**: `Avl/AvlItem/AvlVmpn/AvlMpn`, or tool-named `BomItem/Characteristics/Textual` values.
   - **ODB++**: `CMP` + `PRP` component properties, plus the optional `steps/<step>/boms/<bom>/bom` with `MPN`/`VND`/`VPL_MPN`.
   - **Gerber X3 component layers**: `.CMPN`/`.CMfr`/`.CSup`.
   - **BOM or pick-and-place CSVs**, when the author added the column.

   Measured caveat: **KiCad's own X3 writer does NOT emit `.CMPN`.** The Ucamco StickHub sample (KiCad 8.99) has only CRot, CMnt, CVal, CFtp and CLbN. LibrePCB does emit it (9 `.CMPN` in the can2usb sample). KiCad's IPC-2581 and ODB++ writers do carry MPNs: IPC-2581 through AVL field mapping, and ODB++ writes every footprint field as a `PRP`.
3. **Gerber + Excellon is the highest-demand render path.** Fabs take a zip of Gerbers. Three browser engines are licence-clean for a GPL-3.0+ bundle:
   - **tracespace v4**: MIT, SVG. It has been on "indefinite hiatus" since Jan 2025.
   - **wasm-gerber-viewer**: MIT, Rust/WASM/WebGL2. It is active (pushed 2026-09-23) and also imports ODB++ zip/tgz.
   - **MakerPnP `gerber_parser` + `gerber-types`**: MIT OR Apache-2.0 Rust crates, for a WASM parser of our own.
4. **IPC-2581 gives the richest single file** (copper, stackup, BOM, AVL, netlist) and it is plain XML, so `DOMParser` in a worker needs no dependency. Two costs:
   - **Size:** the consortium's Rev C test case 1 is 6.0 MB zipped and 152 MB unzipped, and its `-full.xml` alone is 56 MB. That is far over today's `INTAKE_CAPS` (8 MB per file, 12 MB total), so it needs a streaming parser and its own caps.
   - **Documentation:** the standard costs $198 (non-member, IPC shop) and the XSD URL returns 403. The consortium's free test cases and KiCad's GPL writer are the practical references.
5. **ODB++ is the licence-risk item.** The 8.1u3 spec PDF is publicly downloadable but marked "trade secrets or otherwise confidential information … may not be copied, distributed". Implementations exist anyway: KiCad 9 ships a GPL ODB++ *writer*, OdbDesign is AGPL-3.0, pcb2svg is BSD-3 and wasm-gerber-viewer is MIT. Get legal eyes before shipping a reader.
6. **KiCad as a conversion target.** KiCad master can import only Fabmaster (added Jan 2021, shipped in 6.0) from this slice. The IPC-2581 plugin says `// Reading currently disabled`, and the ODB++ plugin returns `CanReadBoard → false`. GerbView can "Export to PCB Editor", but lossily. "Convert to our KiCad model" is therefore mostly not available off the shelf for manufacturing data.

## Per-format entries

### 1. Gerber RS-274X / X2 (and legacy X1, RS-274-D)
- **Extensions:** `.gbr` (X2 recommended), `.ger`, `.gbx`, `.pho`, `.art` (Allegro), and Protel/Altium-style `.gtl .gbl .gts .gbs .gto .gbo .gtp .gbp .gko .gm1..gmN .g1..gN / .gp1..`. Also Eagle `.cmp .sol .stc .sts .plc .pls .crc .crs .dim .mil .gml .ly2..`, OrCAD `.top .bot .smt .smb .sst .ssb .spt .spb .in1 .fab`, Target `.Top .StopTop .PosiTop`, Siemens `*.gdo`, Zuken `.fph` and EasyEDA `Gerber_TopLayer.GTL` / `Gerber_BoardOutlineLayer.GKO`. KiCad's own recogniser regex is `(gbr|gko|pho|(g[tb][alops])|(gm?\d\d*)|(gp[tb]))` (`common/wildcards_and_files_ext.cpp:213`).
- **Container:** ASCII, one image per file.
- **Detect:**
  - Content usually starts with `G04` comments, `%TF.` (X2 file attributes such as `%TF.GenerationSoftware,KiCad,Pcbnew,…*%` or `%TF.FileFunction,Copper,L1,Top*%`), `%FS`, or `%MO`.
  - Commands end with `*` and the file ends `M02*`.
  - Tool fingerprints in the header: `G04 #@! TF.` for X2 attributes written as comments, `G04 DipTrace …`, and `G04 File Origin: Cadence Allegro …` (per gerbonara).
  - For "is this Gerber", mirror KiCad's `GERBER_FILE_IMAGE::TestFileIsRS274`.
- **Contains:** 2D image only, per layer. X2 adds the layer function (`.FileFunction`), polarity, aperture functions (pad, via, fiducial…), and object attributes `.N` (net), `.P` (pin) and `.C` (refdes) on copper. There is no BOM and no stackup: layer order is inferable from `.FileFunction … L1..Ln`, but dielectrics are absent.
- **Spec:** Ucamco *Gerber Layer Format Specification*, **rev 2026.05** (19/05/2026, 219 pp.), free PDF. Copyright Ucamco. §1.4 says no licence is granted, and implementers agree not to rename the format, create "derivative versions, modifications, or extensions" or make "alternative interpretations". Reading files is fine; don't invent extensions.
- **Parsers:**
  - tracespace (TS, MIT, 951★). v4.2.8 packages were last published June 2022, and v5 `@tracespace/*@5.0.0-alpha.0` Jan 2023. The repo has been on "indefinite hiatus" since 2025-01-20.
  - wasm-gerber-viewer (Rust→WASM + WebGL2, MIT, 15★, pushed 2026-09-23). It claims more than 10 MB Gerbers, NC drill and ODB++ import.
  - MakerPnP `gerber_parser` 0.5.0 (May 2026) and `gerber-types` 0.7.0 (Rust, MIT OR Apache-2.0).
  - gerbonara (Python, Apache-2.0, pushed 2026-04).
  - pygerber (Python, MIT, X3/X2 plus a renderer).
  - gerbv (C, GPL-2.0-or-later, maintained fork pushed 2026-08).
  - KiCad GerbView (C++, GPL-3.0+).
- **KiCad:** GerbView has loaded RS-274X for many releases. It highlights X2 component, net and attribute items (KiCad 9 docs) and loads zip archives (`gerbview/files.cpp` `LoadZipArchiveFile`, which picks the Excellon or RS-274 reader per entry). "Export to PCB Editor" converts flashes to vias and draws to tracks; "rasterized items cannot be converted". Pcbnew cannot import Gerber.
- **Browser path:** wasm-gerber-viewer (MIT) as an engine behind `CanvasController` is the least effort; X2 `.C`/`.N` attributes would even allow `focusRef`. Tracespace v4 (SVG) is proven but unmaintained, and SVG struggles past a few MB. The third option is our own TS parser plus a Canvas2D/WebGL2 renderer on MakerPnP's grammar (L).
- **BOM value:** none on layer files. Only X3 component layers (entry 2) carry parts.
- **Licence:** MIT and Apache-2.0 are fine in GPL-3.0+. gerbv (GPL-2+) and GerbView (GPL-3+) are compatible but impractical in a browser. The Ucamco terms constrain *extending* the format, not reading it.
- **Effort:** M with wasm-gerber-viewer; L for our own renderer.

### 2. Gerber X3 component layers (assembly data)
- **Extensions:** `.gbr`. KiCad names them `<board>-pnp_top.gbr` / `-pnp_bottom.gbr`, LibrePCB `…_PnP-TOP.gbr` / `…_PnP-BOT.gbr`.
- **Detect:** `%TF.FileFunction,Component,L1,Top*%` (or `…,Ln,Bot*%`), then `%TO.C,<refdes>*%` on each ComponentMain flash.
- **Contains:**
  - Per component: refdes (`.C`), rotation `.CRot`, **manufacturer `.CMfr`, MPN `.CMPN`**, value `.CVal`, mount type `.CMnt` (TH|SMD|Pressfit|Other), footprint `.CFtp`, package `.CPgN` / `.CPgD`, **height `.CHgt`**, library `.CLbN` / `.CLbD`, and **supplier + supplier part `.CSup,<SN>,<SPN>…`** (spec rev 2026.05 pp.166-167).
  - Geometry: ComponentMain flash, outline, courtyard and pin-1.
- **Measured:** Ucamco's KiCad sample (StickHub, KiCad 8.99) has 35 components with CRot/CMnt/CVal/CFtp/CLbN and **zero CMPN**. KiCad's placefile writer (`pcbnew/exporters/gerber_placefile_writer.cpp`) never sets `m_MPN`, although `common/gbr_metadata.cpp:778-782` could print CMfr/CMPN. Ucamco's LibrePCB sample (can2usb) carries `.CMPN` on 9 parts, for example `STM32F042C4T6` and `USBLC6-2SC6`; LibrePCB's `gerberattribute.cpp:470-478` writes `.CMfr`, `.CMPN` and `.CVal`.
- **Parsers:** any X2-aware parser exposes `%TO` attributes (gerbonara, pygerber, gerbv, KiCad GerbView, the MakerPnP crates). Tracespace parses `%TO` into its syntax tree only as generic attribute nodes; verify before relying on it.
- **KiCad:** writes X3 since 6.x and GerbView displays it. It can't import X3 into a board.
- **Browser path:** a parser of about 200 lines on top of the Gerber tokenizer. It yields placements (refdes, x, y, rotation, side, height) plus MPN when present, and feeds `/bom` pricing and 3D placement boxes (`.CHgt`).
- **BOM value:** **YES when the exporter fills `.CMPN`/`.CMfr`** (LibrePCB yes, KiCad no). Otherwise the value and footprint give only a fuzzy BOM, like our CSV path.
- **Effort:** S once the Gerber tokenizer exists.

### 3. Gerber job file (`.gbrjob`)
- **Container:** JSON. Ucamco publishes a JSON Schema (2023-08-30) and *Gerber Job Format Spec* rev 2020.08.
- **Detect:** `.gbrjob` extension, or JSON whose top-level keys are among `Header`, `GeneralSpecs`, `DesignRules`, `FilesAttributes` and `MaterialStackup`. `Header.GenerationSoftware.Vendor` names the tool.
- **Contains:**
  - `FilesAttributes[]`: path, FileFunction and polarity for every Gerber, which is authoritative layer identification with no filename guessing.
  - `MaterialStackup[]`: Type, Thickness, Color, DielectricConstant, LossTangent, Material, Name.
  - `GeneralSpecs`: size, layer count, finish, board thickness.
  - `DesignRules`.
- **Measured:** the StickHub job has 9 `MaterialStackup` entries and 9 `FilesAttributes`. KiCad writes it through `pcbnew/exporters/gerber_jobfile_writer.cpp`, and GerbView opens it (`files.cpp:305`, `:501`).
- **Browser path:** trivial (`JSON.parse`). It feeds our existing Stackup tab (`BoardStackup`) directly.
- **BOM value:** none.
- **Effort:** S.

### 4. Excellon / XNC drill (and Gerber-format drill)
- **Extensions:** `.drl`, `.xln`, `.txt` (Altium, legacy Eagle), `.exc`, `.drd`, `.tap` / `.npt` (OrCAD), `.nc`, `.xnc`, `.cnc` (gEDA), `.ncd` (Siemens), `.fdr` (Zuken), `.rou` (Allegro routing). Also Eagle `.dri` (drill rack info), Allegro `nc_param.txt` / `ncdrill.log`, and Zuken `.fdl`. Gerber-format drill files look like KiCad's `-PTH-drl.gbr`.
- **Detect:** first non-comment line `M48`, then `METRIC` or `INCH` and tool definitions `T<n>C<dia>`, with `%` or `M95` ending the header and `M30` ending the file. XNC attributes are comments `; #@! TF.FileFunction,Plated,1,4,PTH` (XNC spec §3). KiCad's detector is `EXCELLON_IMAGE::TestFileIsExcellon`.
- **Contains:** hole positions, diameters, plated or non-plated, routed slots. There is no BOM.
- **Spec:** Ucamco *XNC Format Specification* rev 2021.11, a strict subset of IPC-NC-349 co-authored by KiCad's Jean-Pierre Charras. Original Excellon manuals survive only on archive.org (linked from KiCad's GerbView docs).
- **Parsers:** tracespace, gerbonara (`excellon.py`), gerbv, KiCad GerbView, wasm-gerber-viewer ("NC drill overlay").
- **KiCad:** GerbView reads Excellon and XNC. The PCB editor writes both (`gendrill_excellon_writer.cpp`, `gendrill_gerber_writer.cpp`).
- **Browser path:** part of any Gerber engine. It gives holes to the 3D view (drills through the substrate).
- **Effort:** S alongside Gerber. The headache is format sniffing: zero suppression and unit inference when the header is missing.

### 5. The fab-output bundle (zip / tgz / rar / 7z): what people drop by mistake
- **Typical members:** Gerber layers, drill files, a `.gbrjob`, an IPC-D-356 netlist (`.ipc` or `.d356`), pick-and-place (`.pos`, `*-pos.csv`, `Pick Place for *.txt` or `.csv`, `.mnt`/`.mnb`, `*CPL*.csv`), a BOM (`.csv`, `.xlsx`), fab drawings (`.pdf`, `.dxf`, `.svg`, `.ps`, `.plt`), ReadMe `.txt`, Eagle `.gpi`/`.dri`, Allegro `.art` + `nc_param.txt`, sometimes IPC-2581 `.xml` or an ODB++ `.tgz` nested inside.
- **Detection recipe** (cheap, reading headers only):
  1. A `.gbrjob` is present: parse it and you are done.
  2. Otherwise, score files by content sniff: `%TF.`, `G04`, `%FS` / `%MO` → Gerber; `M48` → drill; `P  JOB` or `C  ` → IPC-D-356; `$HEADER` → GenCAD; `ISO-10303-21;` → STEP; `<IPC-2581` → IPC-2581; `.HEADER` + `BOARD_FILE` → IDF; a `matrix/matrix` member → ODB++.
  3. Then apply filename rules by CAD flavour (tracespace `packages/identify-layers/src/layer-types.ts`, gerbonara `layer_rules.py`) and pick the best-matching tool.
  4. Report "fabrication outputs from <tool>; N copper layers" and offer the BOM/CPL CSVs to `/bom`.
- **Sizes seen:** Ucamco X3 StickHub zip 124 KB (560 KB unzipped, 14 files). The IPC-2581 test case zip is 6.0 MB but **152 MB unzipped**, over `ARCHIVE_GUARD`'s 250 MB declared ceiling proportionally and far over `INTAKE_CAPS`.
- **Effort:** S (recogniser plus message plus CSV hand-off). M if it also renders.

### 6. ODB++ (ODB++Design, v7 / 8.x)
- **Extensions:** `.tgz`, `.tar.gz`, `.tar`, `.zip` (KiCad's exporter offers ZIP), or a directory. Inner files may be `.Z` (Unix compress, LZW).
- **Detect:** an archive whose root `<job>/` contains `matrix/matrix`, `misc/info`, `steps/<step>/stephdr`, `steps/<step>/layers/<layer>/features[.Z]`, `steps/<step>/eda/data`, and `steps/<step>/layers/comp_+_top|comp_+_bot/components` (spec p.~20). `misc/info` carries `ODB_VERSION_MAJOR` and similar keys.
- **Contains:**
  - Full fabrication geometry per layer (features), the netlist (`netlists/cadnet`), and packages (`eda/data PKG`).
  - Components: `CMP <pkg_ref> x y rot mirror comp_name part_name` plus `PRP <name> '<value>'` properties and `TOP` toeprints.
  - **Stackup** in `matrix/stackup.xml` (added in 8.x) and `matrix/matrix` layer order.
  - **BOM** in `steps/<step>/boms/<bom>/bom`, whose records include `CPN`, `IPN`, `DSC`, `QNT`, `RD`, **`MPN`, `VND`**, `VPL_MPN` and `VPL_VND`. It also carries the AVL source files and variants (`AFFECTING_BOM`, `.no_pop`).
- **Measured:** KiCad's writer copies every footprint field except Reference as `PRP <FieldNameNoSpaces> '<value>'` (`pcbnew/pcb_io/odbpp/odb_component.cpp:106-115`). A KiCad field named "MPN" or "Manufacturer" therefore arrives as a PRP, and DNP becomes `.no_pop`.
- **Spec:** *ODB++Design Format Specification* 8.1 Update 3 (Feb 2021), a free download from odbplusplus.com. Front matter: "Unpublished work. © 2021 Siemens. This material contains trade secrets or otherwise confidential information … may not be copied, distributed, or otherwise disclosed … without the express written permission of Siemens".
- **Parsers:**
  - OdbDesign (C++, **AGPL-3.0**, 84★, active 2026-09).
  - vlovo/pcb2svg (C++, BSD-3, 2023).
  - wasm-gerber-viewer (MIT, ODB++ zip/tgz/tar import, active).
  - sjgallagher2/ODBplusplus-Parser (Python, GPL-3.0).
  - Delta-Proto/delta-odbpp (Java, no licence).
  - capablemonkey/odb-pp-parser (Ruby, no licence, 2017).
  - onlineBomFromOdbpp (Python, MIT: InteractiveHtmlBom fork).
- **KiCad:** **export only**, added in 9.0 (release notes). `pcb_io_odbpp.h:141` returns `CanReadBoard → false`, so there is no import.
- **Browser path:** fflate (MIT) for zip and gzip, a tar reader of about 60 lines, an LZW `.Z` decoder of about 100 lines, and text-record parsers for `matrix`, `components`, `eda/data`, `features`, `stackup.xml` and `bom`. Render features the way we render Gerber apertures. Or use wasm-gerber-viewer's importer.
- **BOM value:** **YES, often.** `PRP` properties carry whatever the CAD tool exports: KiCad, all fields; Altium/Xpedition, their part parameters. An explicit `boms/` BOM has `MPN`/`VND` when an AVL was attached.
- **Licence:** code licences are fine (MIT, BSD, GPL-3). AGPL OdbDesign would pull AGPL terms onto its part. **Spec terms are the risk:** Siemens' confidentiality legend and the odbplusplus.com terms ("information may not be distributed, sold … or otherwise exploited"). Mitigations: implement from KiCad's GPL writer and public files, or join the free ODB++ Solutions Alliance partner programme. Needs an owner or legal call.
- **Effort:** L. Many record types, `.Z` handling, and symbol libraries (`symbols/`, standard symbol names like `r10`, `rect20x40`).

### 7. IPC-2581 (Rev A/B/B1/C; "DPMX")
- **Extensions:** `.xml`; also `.cvg`, which some tools use for the same content. Often split per function mode (the Rev C test case ships `-Fabrication`, `-Assembly`, `-BOM`, `-stackup`, `-Stencil`, `-Test` and `-full` `.xml`).
- **Detect:** XML root `<IPC-2581 revision="C" xmlns="http://webstds.ipc.org/2581">` (KiCad `pcb_io_ipc2581.cpp:515-530`; the consortium test case matches). `<Content><FunctionMode mode="FABRICATION|ASSEMBLY|…"/>` says which subset is present.
- **Contains:**
  - Everything: layers, geometry, padstacks, netlist, drill, **stackup** (`Stackup/StackupGroup/StackupLayer` with dielectric specs), components (`Component refDes packageRef part layerRef` + `Location`).
  - **BOM:** `Bom/BomItem OEMDesignNumberRef quantity category` + `RefDes` + `Characteristics/Textual name=value`.
  - **AVL:** `Avl/AvlItem/AvlVmpn/AvlMpn name` + `AvlVendor enterpriseRef`.
- **Measured:** Rev C test case 1 (Cadence Allegro) has 173 BomItem, 1,657 RefDes, 1,656 Component and 23 StackupLayer. MPNs appear as `Textual textualCharacteristicName="VENDOR_PN" … "QD48S018033NS00"` with `VENDOR "DI/DT"`. There is no `Avl` section in that file. KiCad's exporter maps user-chosen MPN, Manufacturer, Distributor and DistPN fields into `AvlVmpn/AvlMpn/AvlVendor` (`pcb_io_ipc2581.cpp:4791-4865`).
- **Spec:** IPC-2581C (released 2020-11-20). It costs $198 non-member / $139 member at shop.electronics.org, and Rev B (2013-09-01) is also sold there. The XSD at `webstds.ipc.org/2581/IPC-2581C.xsd` returns **403**. The consortium (ipc2581.com) calls it "an open, neutrally maintained global standard", and its test cases for Rev A, B and C are free downloads.
- **Parsers:**
  - midub/boardui (TS web component, **MIT**, 26★, last push 2025-03; demo.boardui.com).
  - mgburr/ipc2581-to-kicad (C++, **no licence**, 2026-02: IPC-2581 → `.kicad_pcb` for KiCad 7/8).
  - Chentai-Kao/ipc2581_to_odb (GPL-2.0, 2013).
  - sjgallagher2/ipc2581 (Python, MIT, experiments).
  - Rafa350/EdaTools (C#, LGPL-3.0).
  - gerbonara's Zuken rule tags `.xml` as ipc-2581, but gerbonara has no reader.
- **KiCad:** **export only, added in 8.0** (release notes: "exporting boards to IPC-2581 format (Seth Hillbrand)"). Master's plugin `CanReadBoard` returns false with `// Reading currently disabled` (`pcb_io_ipc2581.h:117-121`).
- **Browser path:** best value per effort. Stream-parse the XML in a worker (for example with a SAX parser, since `DOMParser` on 56 MB is memory-heavy), build BOM + AVL (MPN → `/bom` pricing), stackup (→ Stackup tab), placements (→ part panel and 3D boxes), then render geometry with the renderer used for Gerber. Or evaluate boardui (MIT).
- **BOM value:** **YES.** Designators, quantities, AVL MPN plus vendor, or tool-named textual characteristics. It needs an alias table for names like `VENDOR_PN`, `MPN`, `MFR_PN` and `Manufacturer Part Number`, the same idea as our `headerAliases.ts`.
- **Licence:** implementing from public files and KiCad's GPL writer is fine. Buying the standard document is optional but advisable. boardui (MIT) is compatible.
- **Effort:** M for BOM + stackup + placements; L for full geometry rendering.

### 8. IPC-D-356 / 356A / 356B netlist (bare-board test)
- **Extensions:** `.ipc` (Altium, gEDA, Eagle and others per gerbonara), `.d356` (KiCad), `.net`, `.356`, `.tst`.
- **Detect:** fixed-column ASCII, 80-char records.
  - `C  ` comment lines.
  - `P  JOB <name>` and `P  UNITS CUST 0|1|2` parameter records.
  - Test records `317` (through-hole), `327` (SMD) and `367` (non-plated / tooling), and `378` conductor records in 356A.
  - `999` end.
  - KiCad writes `P  JOB`, `P  NNAME` aliases and 317/327/367 (`pcbnew/exporters/export_d356.cpp`).
- **Contains:** net name, refdes, pin, access side, x/y, pad size, drill, per test point. No MPN.
- **Spec:** IPC-D-356 sold by IPC (shop.electronics.org). Revisions A and B exist; A is most commonly supported (Altium resources). There is a community "IPC-D-356 for Dummies" PDF.
- **Parsers:** gerbonara `ipc356.py` (Apache-2.0: reads and writes, handles UNITS CUST 0/1/2); KiCad export only; Altium exports it as its assembly testpoint report option.
- **KiCad:** export only (`export_d356.cpp`). GerbView does not load it (no 356 in `gerbview/files.cpp`).
- **Browser path:** S. Parse into a net → pads map to add net highlighting over a Gerber render, standing in for X2 `.N` when the Gerbers are X1.
- **BOM value:** none, but refdes lists can cross-check a BOM.
- **Effort:** S.

### 9. Pick-and-place / centroid / CPL
- **Extensions:** KiCad `.pos` (ASCII) or `-pos.csv` / `-top-pos.csv`; Altium `Pick Place for <board>.txt | .csv`; Eagle `mountsmd.ulp` → `.mnt` / `.mnb`; JLC CPL `.csv` / `.xlsx`; Eagle PCB:NG `pnp_bom`; X3 as in entry 2.
- **Detect:**
  - KiCad ASCII: `### Footprint positions - created on …`, `## Unit = mm, Angle = deg.`, `# Ref Val Package PosX PosY Rot Side`. KiCad CSV header: `Ref,Val,Package,PosX,PosY,Rot,Side` (`place_file_exporter.cpp:50-252`).
  - Altium columns: Designator, Comment, Layer, Footprint, Center-X(mm), Center-Y(mm), Rotation, Description. The user can add any parameter column, CSV or text.
  - JLC CPL: `Designator, Mid X, Mid Y, Layer, Rotation`.
- **Contains:** refdes, x/y, rotation, side, and often value/package. **MPN only when the user added the column** (Altium lets them select any parameter).
- **Parsers:** papaparse and SheetJS, already in our `/bom` stack.
- **KiCad:** exports it (`place_file_exporter.cpp`) but never imports it.
- **Browser path:** S. Detect it with header aliases, as `headerAliases.ts` does for BOMs, and join to BOM lines by designator to give the part panel side and position without a board.
- **BOM value:** partial. Designators + value + package give a fuzzy BOM, and a real one when there is an MPN column.
- **Effort:** S.

### 10. GenCAD 1.4
- **Extensions:** `.cad` (KiCad `GencadFileExtension`), also `.gcd`. `.cad` collides with Mentor Boardstation neutral files, which BoardRipper sniffs by content.
- **Detect:** first section `$HEADER` containing `GENCAD 1.4`. Sections: `$BOARD $PADS $PADSTACKS $ARTWORKS $SHAPES $COMPONENTS $DEVICES $SIGNALS $TRACKS $LAYERS $ROUTES $MECH $TESTPINS $POWERPINS $PSEUDOS $CHANGES`.
- **Contains:** outline, pads and padstacks, shapes, component placements, nets, routes, tracks, test pins.
  - `$DEVICES` records: `DEVICE <part_name>`, `PART <part_name>` ("a corporate part number or a unique CAD part name"), `TYPE`, `STYLE`, `PACKAGE`, `VALUE`, `TOL`, `DESC`, `ATTRIBUTE`.
  - KiCad writes `PART "<value>"` and `PACKAGE "<fpid>"` (`export_gencad_writer.cpp:1152-1153`), so no MPN.
- **Spec:** Mitron Corporation *GenCAD Specification 1.4* (CIMBridge 97/A), © 1990-97 Mitron. The only practical copy is republished (PDF + Markdown) in EasyEDA's repo.
- **Parsers:**
  - **easyeda/online-gencad-viewer** (TypeScript, **Apache-2.0**, created 2026-05, LeaferJS canvas renderer; parser in `src/parser/`).
  - BoardRipper (TS, AGPL-3.0: GenCAD among 14 boardview formats).
  - OpenBoardView (C++, MIT).
- **KiCad:** export only ("GenCAD 1.4 board files").
- **Browser path:** port EasyEDA's Apache-2.0 parser (Apache-2.0 → GPL-3 is compatible) and render it through our canvas.
- **BOM value:** weak. `PART` / `ATTRIBUTE` may hold a corporate part number or MPN, depending on the exporter; KiCad writes the value.
- **Effort:** M.

### 11. IDF 2.0 / 3.0 (board + library)
- **Extensions:** `.emn` (board / panel) and `.emp` (library). Also `.idf` for KiCad per-footprint outline files (`IDF3DFileWildcard`), and `.bdf` / `.ldf` in some tools. `.emp` collides with KiCad's legacy footprint export (`wildcards_and_files_ext.cpp:507`).
- **Detect:** `.HEADER` section, then `BOARD_FILE 3.0 …` or `LIBRARY_FILE 3.0 …`. Sections `.BOARD_OUTLINE`, `.DRILLED_HOLES`, `.PLACEMENT`, `.ELECTRICAL` / `.MECHANICAL`.
- **Contains:**
  - Board outline with **thickness**, cutouts, drilled holes and keep-outs.
  - `.PLACEMENT` records: package name, **part number**, refdes (or NOREFDES / BOARD), x, y, mounting offset, rotation, side, status (IDF 3.0 spec §`.PLACEMENT`).
  - The `.emp` library gives each package an extruded outline with **height**.
- **Spec:** *Intermediate Data Format … Version 3.0 Rev 1* (Oct 1996): "non-proprietary. This specification may be used by any party for any purpose; there are no restrictions on its use."
- **Parsers:**
  - KiCad `utils/idftools` (GPL-3+; idf2vrml).
  - FreeCAD/IDF addon (Python, CC-BY-SA-4.0: an odd licence for code).
  - bradenkallin/idf-3-checker (GPL-3.0).
  - No JS parser found.
- **KiCad:** export only (`pcbnew/exporters/export_idf.cpp`). The component outline comes from a footprint's `.idf` 3D model file (`export_idf.cpp:495-533`).
- **Browser path:** S–M. It is a text parser, and it feeds our existing `board3d` pipeline directly (outline + thickness + extruded boxes with real heights).
- **BOM value:** partial. The "part number" field is whatever the ECAD wrote (may be MPN, value, or internal PN), keyed by refdes.
- **Effort:** S–M.

### 12. IDX (ProSTEP iViP EDMD, PSI 5)
- **Extensions:** `.idx`, sometimes zipped with STEP / geometry.
- **Detect:** XML root element `EDMDDataSet` in namespace `http://www.prostep.org/ecad-mcad/edmd/<ver>/foundation` (v4.5 schema; v3.5 also referenced). The schema is split into foundation / pdm / geometry.d2 / material / property / text / grouping / administration / annotation / external / 3dpart.
- **Contains:** board outline and stackup-ish body, components with 3D envelopes and heights, holes, keep-outs, and incremental change proposals (baseline / change / response). No BOM section; part names and ids only.
- **Spec:** free download of the recommendation, implementation guidelines and schema (PSI5_IDXv4.5_release.zip, 16 MB), © prostep ivip 2006-2019. **IDX v6 schema released Dec 2025** (prostep implementor forum page).
- **Parsers:** commercial (Cadence, Siemens, Altium, PTC Creo, SolidWorks, CATIA via MECODES). No open-source parser found.
- **KiCad:** none (no `.idx` in KiCad's extension table).
- **Browser path:** XML + our `board3d`. Low demand from hobbyists.
- **BOM value:** low.
- **Effort:** M. The schema is large, but the subset for outline + components is small.

### 13. STEP (AP203 / AP214 / AP242) and STEPZ
- **Extensions:** `.step`, `.stp`, `.stpz` (gzip); KiCad `StepFileExtension`, `StepFileAbrvExtension` and `StepZFileAbrvExtension`.
- **Detect:** text starting `ISO-10303-21;`, with `FILE_SCHEMA(('AUTOMOTIVE_DESIGN…` (AP214) or `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING…`. STEPZ is gzip (`1f 8b`).
- **Contains:** B-rep solids of board and components, with assembly structure (product names are usually model or refdes names). **No BOM semantics.** KiCad can include copper since 8.0 (release notes).
- **Parsers:**
  - occt-import-js (Emscripten OpenCascade, **LGPL-2.1**, npm 0.0.23, Dec 2024, ~11.6 MB unpacked). It reads STEP, IGES and BREP and returns meshes.
  - opencascade.js (LGPL-2.1-only, 1.1.1 2023 / 2.0 beta, 66.7 MB unpacked).
  - Online3DViewer (MIT, 3.7k★, uses occt-import-js).
- **KiCad:** exports STEP (the kicad2step lineage, now `pcbnew/exporters/step`). It can't import STEP boards (models only, for footprints).
- **Browser path:** lazy-load occt-import-js in a worker (it's a large chunk; keep it out of entry chunks as `board3d-three` is today), mesh the result and hand it to our three renderer. It only shows the board. The part panel can't bind parts except by product name ≈ refdes.
- **BOM value:** none.
- **Licence:** LGPL-2.1 is compatible with GPL-3 (LGPL-2.1 §3 allows GPL conversion). Keep it a separate dynamically loaded WASM to honour the LGPL relinking spirit.
- **Effort:** M.

### 14. VRML 97 (`.wrl`) / X3D
- **Detect:** `#VRML V2.0 utf8` (VRML97). X3D is XML `<X3D`.
- **Contains:** tessellated board and components with colours; no BOM. KiCad exports a board VRML (`exporter_vrml.cpp`) and uses `.wrl` for footprint models.
- **Parsers:** three.js `examples/jsm/loaders/VRMLLoader.js` (MIT, already our 3D stack).
- **Effort:** S.

### 15. Other 3D exports: glTF/GLB, STL, PLY, BREP, XAO, U3D (PDF 3D)
- **Detect:** GLB magic `glTF` (0x46546C67); STL ascii `solid` or 80-byte header; PLY `ply\n`; BREP `DBRep_DrawableShape`; XAO is XML; U3D magic `U3D\0`.
- **KiCad:** GLB export since 8.0 ("glTF and VRML 3D models can be exported from the CLI"). XAO, STL, BREP and PLY export since 9.0 ("including silk screen and solder mask layers"). A U3D exporter exists in master (`pcbnew/exporters/u3d`).
- **Parsers:** three GLTFLoader, STLLoader and PLYLoader (MIT). BREP through occt-import-js.
- **BOM value:** none.
- **Effort:** S each via three loaders.

### 16. BOM exports (CSV / TSV / XLSX / XLS)
- Already implemented in `/bom`: `parseBom.ts`, generated `headerAliases.ts` and the official SheetJS tarball. Worth widening the aliases for:
  - JLC (`Comment, Designator, Footprint, LCSC Part #`), where LCSC is a supplier PN, not an MPN;
  - Altium BOM (`Comment, Description, Designator, Footprint, LibRef, Quantity` + parameters);
  - KiCad `bom_csv_grouped_by_value`;
  - Octopart / Nexar-style (`MPN`, `Manufacturer`).
- **BOM value:** YES, the best source when present. **Effort:** S (aliases only).

### 17. HyperLynx (`.hyp`): SI/PI exchange with stackup
- **Detect:** text `{VERSION=2.14}` (KiCad writes that), `{BOARD …}`, `{STACKUP …}`, `{DEVICES (? REF="…" L="…")}`, `{NET=…}`.
- **Contains:** stackup with dielectrics, outline, padstacks, nets and routing, and device refs with value strings. No MPN.
- **KiCad:** export since 6.0 ("HyperLynx exporter (Tomasz Wlostowski)"); `pcbnew/exporters/export_hyperlynx.cpp`.
- **Browser path:** stackup + outline are easy; full copper is M. Low demand.
- **Effort:** S (stackup) to M.

### 18. Fabmaster / Allegro extract ASCII
- **Extensions:** `.txt`, `.fab` (Cadence `extracta` output, `A!…` records).
- **KiCad:** **imports it**: `pcbnew/pcb_io/fabmaster/import_fabmaster.cpp`, first commit "pcbnew: Add Fabmaster import" 2021-01-16, so it shipped in 6.0.
- This is the one manufacturing-side format KiCad can turn into a `.kicad_pcb`, which makes the "convert to our KiCad model" path a real option (via a KiCad-WASM engine someday, or a TS port of the importer: GPL-3+, compatible).
- **BOM value:** part names and values; MPN depends on the extract.
- **Effort:** M–L. Probably overlaps the Allegro slice.

### 19. Specctra DSN / SES (autorouter exchange), and the `.dsn` collision
- KiCad exports and imports Specctra DSN / SES (`SpecctraDsnFileExtension`). KiCad master also has an **OrCAD Capture** schematic importer (`eeschema/sch_io/orcad`, wildcard "OrCAD Capture schematic files (.dsn)").
- **Detect:** Specctra is an ASCII s-expression starting `(pcb ` or `(PCB `. OrCAD Capture `.DSN` is a binary OLE/CFB compound file (`D0 CF 11 E0 A1 B1 1A E1`).
- The owner's pasted list attributes `.dsn` to OrCAD; the intake must sniff the content.
- **BOM value:** Specctra has component images and places but no MPN.
- **Effort:** S to detect; M to render.

### 20. Repair "boardview" formats (adjacent: often confused with design files)
- **Extensions:** `.brd` (Apple repair, bit-rotated binary, and BDV text), `.bdv`, `.bvr` / `.bv`, `.fz` (ASUS, RC6 + zlib), `.tvw`, `.pcb` (XZZ, DES-encrypted), `.asc`, `.cad` (GenCAD / Mentor neutral).
- **Parsers:** OpenBoardView (C++, **MIT**, 1.8k★) and BoardRipper (TS, **AGPL-3.0**; 14 formats, content-sniffs shared `.brd`/`.cad`).
- `.brd` collides with Eagle XML (`<?xml` + `<eagle`), Allegro binary and repair boardview, so content sniffing is mandatory.
- **BOM value:** refdes + part names only.
- **Licence:** several formats are encrypted or obfuscated by vendors, so reverse-engineering concerns apply. Low priority.

### 21. Fab drawings & documentation inside bundles
- **Extensions:** `.pdf`, `.dxf`, `.svg`, `.ps`, `.plt` / `.hpgl`. Also Ucamco's "Gerber fabrication documentation" (FileFunction `FabricationDrawing`, `Drillmap`), and KiCad drill maps (`-drl_map.gbr`/`.pdf`/`.svg`/`.dxf`/`.ps`).
- **Browser:** list them, and show PDF/SVG natively. There is nothing to extract for BOM or stackup (the stackup table in a fab PDF is text-only).
- **Effort:** S (list them).

## Recommended order (for the owner)
1. **S: Fab-zip recogniser.** Content sniff + CAD-flavour filename rules + `.gbrjob`, replacing today's "No KiCad files" message with "These are fabrication outputs from <tool>". Route BOM/CPL CSVs and `.gbrjob` stackup to existing surfaces.
2. **M: Gerber + Excellon + X3 + job-file view** as a second `CanvasController` engine. wasm-gerber-viewer (MIT) is the first candidate to evaluate; fallback is our own parser on MakerPnP's grammar or a tracespace v4 fork. X3 gives placements and, when present, MPNs.
3. **M: IPC-2581 BOM + AVL + stackup + placements.** Streaming XML in a worker, with separate, larger intake caps. Render geometry later.
4. **S–M: IDF 3.0 → 3D; IPC-D-356 → net highlight; GenCAD** (port of EasyEDA's Apache-2.0 parser).
5. **M: STEP / VRML / GLB into the 3D tab.** occt-import-js (LGPL-2.1) is lazily loaded, and three loaders cover the rest.
6. **L: ODB++**, after a licence decision on the Siemens spec terms.
