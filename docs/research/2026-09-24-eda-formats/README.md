# Other board-design formats for the Design Viewer — research report (2026-09-24)

Owner mandate (2026-09-24): the Design Viewer must EVENTUALLY accept files from other board-design software. This report came from a research workflow: six parallel researchers (Altium; EAGLE/Fusion; Cadence/Siemens/Zuken; web and hobby tools; manufacturing outputs; demand), three skeptic passes (KiCad importer claims, licences, format/BOM/date claims), then a synthesis. 89 format entries. Per-family dossiers with sources sit beside this file.

Engineering guidance, not legal advice. Claims the skeptics could not confirm are marked unverified in the dossiers.

## The short answer

Formats that matter most for circuitcenter.ai, and the order to build them:

1. **Altium (demand #1).** About 50% of professional PCB designers use it weekly (PCD&F/PCEA 2026 survey). The .SchDoc schematic carries MPN parameters, so a priced BOM is possible in the browser. altiumts (MIT) parsed a real 288 KB sheet in 175 ms and pulled 23 MPNs. A .PcbDoc board is an L-XL port.
2. **EAGLE / Fusion: cheapest and most timely.** Autodesk ended EAGLE sales and support on 2026-06-07. The format is documented XML, and its DTD licence explicitly permits readers. Board files carry copies of part attributes: MPN, MF and the Farnell/Newark order codes, verified on a real 9.5.2 .brd. Fusion's .fsch/.fbrd files are just EAGLE XML inside a zip.
3. **Gerber/drill fab zips.** Every tool exports them, and people will drop them by mistake. They give a board picture, not a BOM.
4. **EasyEDA.** Millions of users (vendor figure), and parts carry the MPN plus the LCSC C-number. Most of its designs stay in EasyEDA's cloud.
5. **IPC-2581 (strategic).** One open XML reader covers Allegro, Xpedition, Zuken and Altium boards, and the file includes a BOM plus an approved-vendor list with MPNs.
6. **KiCad 4/5 legacy.** The largest group of files /viewer refuses on GitHub (about 83k legacy .sch). A clear message is enough for now.
7. **OrCAD, Allegro, PADS binary, DipTrace: wait.** KiCad is adding importers for these in 2026 (mostly on master, i.e. KiCad 11). We port them once they settle.
8. **ODB++: legal call first.** The spec is marked confidential, "internal business purposes only".

The build order differs from the demand order:
- First, an intake that recognises formats by content signature (days of work).
- Then BOM-only readers: EAGLE, Altium SchDoc + PrjPcb, EasyEDA, IPC-2581.
- Then drawings, by converting each format to KiCad text in memory so KiCanvas, Stackup and 3D run unchanged.

Every recommended phase stays client-side, so "your design files never leave your browser" holds throughout.

## Roadmap

**How it plugs in.** Today `buildProject()` in `frontend/src/public/services/kicad/project.ts` throws "No KiCad files in what was dropped" (kind `empty`) for anything that isn't KiCad, and refuses KiCad 5 via `KICAD5_MESSAGE`. The new work plugs in at four points:
1. **A `detectFormat(files)` seam before `buildProject`.** It sniffs content — CFB magic and stream names, XML roots, first-line headers, zip member names — and never relies on the extension. .sch, .brd, .pcb, .asc, .dsn and .cad each mean several different formats. It routes each drop to one of:
   - the KiCad reader, unchanged;
   - a tailored refusal;
   - a foreign reader.
2. **Most foreign readers emit .kicad_sch/.kicad_pcb text in memory**, as TypeScript ports of KiCad's GPL-2.0+/3.0+ importers. The result is a normal `KicadProject`, so KiCanvas, `readStackup`, `boardPlacements`, board3d, the part panel and `schematicBom` all run unchanged. That keeps one renderer.
3. **A second engine behind the `CanvasController` seam** (mount/activate/focusRef/zoom/dispose), only for geometry that isn't a design: Gerber, drill, ODB++, IPC-2581. It lives in its own async chunk. X2 `.C` refdes attributes make `focusRef` possible.
4. **BOM readers feed the existing `/api/bom/match`**, which takes identity fields only. No new server surface, and no new data leaves the browser.

Each phase ends with a local playtest and owner approval.

**Phase 0 — recognise and explain (S, about 1 week)**
- Signature detector plus the per-format copy in quick_wins.
- A fab zip's BOM/CPL CSVs are routed to /bom.
- A .gbrjob's MaterialStackup is shown in the Stackup tab.
- Risk: false matches on shared extensions, mitigated by content sniffing.

**Phase 1 — priced BOMs, no drawings yet (M total, each reader S-M)**
- **EAGLE XML + Fusion zip.** Resolve part → library → deviceset → device → technology attributes; handle variants and DNP (`populate=no`); drop supply symbols. A lone .brd also works.
- **Altium SchDoc.** Read `RECORD=1/34/41` through cfb (Apache-2.0) or altiumts (MIT). PrjPcb acts as the manifest and supplies variant DNP and alternates. BomDoc is the MPN fallback. Alias the various parameter names.
- **EasyEDA Std, Pro v2 and Pro v3.** The LCSC number goes in as `distributor_pn`.
- **IPC-2581.** Read BomItem, RefDes, AVL MPN/vendor and the stackup with a streaming parser. It needs its own caps: the consortium's Rev C test case is a 6 MB zip that unzips to 152 MB (full.xml is 56 MB), against today's 8 MB per file / 12 MB total.
- **Optional:** LibrePCB, Horizon, DipTrace ASCII, Allegro extracta and pst netlists, and a PADS ASCII BOM.
- **Risks:**
  - MPN coverage varies. Hobby EAGLE parts often carry only value and package, so the value/footprint fallback stays essential.
  - Whether a PcbDoc carries MPNs is UNVERIFIED.
- Drawing tabs say "coming soon" for these formats.

**Phase 2 — first drawings (L)**
- **EAGLE → KiCad text**, ported from KiCad's GPL importers: schematic, board, stackup (from layerSetup, mtCopper and mtIsolate; no material or finish), and 3D. Pours arrive unfilled. Estimated 4-8 weeks.
- **Gerber + Excellon + X2/X3 + gbrjob viewer** as a second engine.
  - Candidate: wasm-gerber-viewer (MIT, WebGL2, active; also imports ODB++). Only its README was read; its rendering was not measured.
  - tracespace (MIT) is on "indefinite hiatus".
- **Risks:** conversion fidelity (MR/SR rotations, arcs, smashed text, multi-gate parts) and bundle weight.

**Phase 3 — Altium and EasyEDA drawings (L each)**
- **Altium SchDoc**, by either:
  - a port of KiCad's GPL-2.0+ `sch_io_altium` (5,992 lines) emitting .kicad_sch, or
  - altiumts SVG output as an Engine.
- **EasyEDA Std, Pro v2 and Pro v3**, via ports of KiCad's GPL-2.0+ importers (about 3.3k + 4.7k + 4.3k lines). Pro v3 could ship before stable KiCad reads it.
- **Risk:** Altium's format is undocumented. Use python-altium format.md and KiCad's .ksy; never decompile Altium.

**Phase 4 — professional boards (L-XL)**
- Altium PcbDoc → .kicad_pcb, a port of the 6,130-line altium_pcb, including embedded STEP.
- PADS ASCII, CADSTAR, gEDA and KiCad 4/5 legacy, as demand dictates.
- IPC-2581 geometry.

**Watch list — port only after KiCad 11 settles**
OrCAD Capture .DSN (master since 2026-07-21, open bugs), Allegro .brd (released in 10.0, XL), PADS binary, DipTrace binary, Sprint-Layout, EAGLE 3-5 binary, Autotrax, P-CAD schematics.

**Never native — serve through their exports instead**
Xpedition, CR-5000/8000, Pulsonix, DesignSpark, TARGET 3001!, Proteus, Multisim, Fusion .f3d, Flux .flx, Upverter, Qucs/uSimmics.

ODB++ waits on the legal decision.

**Every format at a glance** (Show = schematic/board/3D/priced BOM; effort S/M/L/XL; "master" means KiCad nightly):
- **Altium SchDoc**: S, $. KiCad binary 6.0, ASCII 8.0.2. Own TS/altiumts → BOM S-M; drawing M-L. Very high demand.
- **Altium PrjPcb/variants**: DNP and alternates for the BOM. KiCad 9.0.3 (variants 10.0). S.
- **Altium BomDoc**: MPN fallback. S.
- **Altium PcbDoc / CMPcbDoc / CSPcbDoc / SWPcbDoc**: B, 3D, ~$. KiCad 6.0, SW 8.0. Convert, L-XL.
- **Altium libraries**: defer.
- **Legacy Protel, P-CAD, Autotrax**: redirect. P-CAD PCB since 6.0; Autotrax/Easytrax and P-CAD schematics on master; Protel 99 SE DDB never.
- **EAGLE XML**: S, B, 3D, $. KiCad 4.0 (board) / 5.0 (schematic). BOM S-M, drawings L. High demand.
- **Fusion .fsch/.fbrd**: S on top of EAGLE.
- **EAGLE 3-5 binary**: master only; L. Refuse by name for now.
- **EasyEDA Std**: KiCad 8.0, including the backup-zip project import. BOM S, full M.
- **EasyEDA Pro v2**: KiCad 8.0; M-L.
- **EasyEDA Pro v3**: master; M-L.
- **EasyEDA .eprj3**: reuses the v3 port. **.eprj (SQLite)**: redirect.
- **OrCAD .DSN**: master; wait. L for BOM, XL overall.
- **Allegro .brd**: KiCad 10.0; XL.
- **Allegro extracta**: KiCad 6.0; S (BOM) to M.
- **pst*.dat / Telesis netlists**: S-M, BOM only.
- **PADS ASCII**: KiCad 10.0; M-L.
- **PADS binary**: master; XL.
- **Xpedition, CR-8000, Pulsonix, DesignSpark, TARGET**: redirect.
- **CADSTAR .csa/.cpa**: KiCad 6.0; L.
- **DipTrace binary**: master; L-XL. **DipTrace ASCII**: S (BOM) to M.
- **gEDA/Lepton**: KiCad 10.0; M-L.
- **LibrePCB, Horizon**: BOM S-M (MPN is a first-class field).
- **Fritzing**: BOM S; core parts are CC-BY-SA 3.0.
- **Proteus, Multisim**: redirect.
- **Sprint-Layout**: master; M.
- **LTspice .asc**: KiCad 8.0; detect only.
- **Gerber RS-274X/X2**: engine, M.
- **Gerber X3**: S, but KiCad-written X3 carries no MPN.
- **.gbrjob**: S.
- **Excellon/XNC**: S.
- **Fab-zip recogniser**: S.
- **IPC-2581**: KiCad export only (8.0+). M (BOM) to L.
- **ODB++**: KiCad export only (9.0+). L; legal.
- **IPC-D-356, pick-and-place**: S each.
- **GenCAD**: M, porting EasyEDA's Apache-2.0 parser.
- **IDF**: S-M, straight into board3d.
- **STEP**: M, via LGPL occt-import-js loaded separately.
- **VRML, glTF, STL**: S, via three.js loaders.
- **EDIF, Specctra**: M.
- **HyperLynx**: S-M.
- **Repair boardviews**: detect and refuse.

## Quick wins (no new renderer)

These messages replace the single "No KiCad files in what was dropped". Detection is all local. The KiCad menu names come from KiCad's source and release notes; confirm them in KiCad 10 before the copy ships.

**Altium** (CFB magic plus FileHeader "Protel for Windows" or Board6 streams; .PrjPcb INI):
"This is an Altium Designer project. The viewer can't open Altium files yet. To see it today, open it in KiCad 9.0.3 or newer (free): in the project window choose File → Import → Altium Project, save, then drop the saved KiCad folder here. To price its parts right now, export a BOM from Altium and drop it on the BOM tool."

**CircuitMaker / CircuitStudio / SOLIDWORKS PCB** (.CMPcbDoc/.CSPcbDoc/.SWPcbDoc):
Same as Altium, plus "KiCad imports this board file directly in the PCB editor."

**EAGLE XML** (`<!DOCTYPE eagle` / `<eagle version=`):
"This is an EAGLE design. KiCad (free) imports it: in the project window choose File → Import → EAGLE Project, save, and drop the KiCad folder here. EAGLE support directly in this viewer is on our roadmap."

**Fusion .fsch/.fbrd:**
"This is a Fusion Electronics file. It holds an EAGLE design: in Fusion use Export → EAGLE 9.X compatible, then open it in KiCad as above."

**EAGLE 5 or older** (first bytes 10 00 / 10 80):
"This was saved by EAGLE 5 or older. Re-save it in EAGLE 6+ or Fusion. Released KiCad can't read this version yet; its next major release can."

**Fusion .f3d/.f3z:**
"That's a Fusion 3D archive. It doesn't contain the circuit. In Fusion, export the electronics design as EAGLE 9.X files instead."

**EasyEDA Std / Pro v2** (head.docType JSON; zip containing project.json):
"This is an EasyEDA project. KiCad 8 or newer imports it (File → Import → EasyEDA in the project window); save and drop the KiCad folder here. Or export the BOM from EasyEDA and drop it on the BOM tool: its LCSC part numbers price directly."

**EasyEDA Pro v3 or .eprj** (project2.json + .epru):
"This is an EasyEDA Pro 3 project. Released KiCad can't import this version yet. Export the BOM from EasyEDA to price it on the BOM tool today."

**OrCAD Capture .DSN/.OLB** (CFB + "OrCAD Windows"):
"This is an OrCAD Capture schematic. Neither this viewer nor released KiCad can read it yet. Export a BOM from Capture (it usually carries part numbers) and drop it on the BOM tool."

**Allegro .brd:**
"This is a Cadence Allegro board. KiCad 10 imports it in the PCB editor; save and drop the KiCad folder here. Only the board comes across; Allegro files don't contain the schematic."

**PADS ASCII** (`!PADS-` / `*PADS-LOGIC`):
"This is a PADS design. KiCad 10 imports PADS ASCII files; save and drop the KiCad folder here."

**CADSTAR** (`(CADSTARSCM` / `(CADSTARPCB`) and **gEDA** (`v YYYYMMDD N` / `PCB[`):
The same KiCad-import message, naming the tool.

**Fab zip** (Gerber %FS / %TF / G04, drill M48, .gbrjob):
"These are manufacturing files (Gerbers and drill) from {tool}: {n} copper layers. They describe the copper, not the design, so there's no schematic or part list in them. Drop the design project instead."
If a BOM or CPL is inside the zip, add: "We found a parts list in the zip. Price it in the BOM tool →"

**ODB++ / IPC-2581:**
"This is an {ODB++ / IPC-2581} manufacturing package. The viewer can't show it yet. If your tool can export a BOM alongside it, drop that on the BOM tool."

**STEP / VRML / glTF / STL:**
"That's a 3D model export: shapes only, no circuit. Drop the design project to get the 3D view with parts identified."

**Proteus, Multisim, DesignSpark, Pulsonix, TARGET 3001!, Xpedition:**
"{Tool} files can't be opened here. Export a BOM (CSV or Excel) to price it on the BOM tool, or {EAGLE XML for TARGET; IPC-2581/ODB++ for the enterprise tools}."

**LTspice / Qucs:**
"This looks like a circuit-simulation file, not a PCB design."

**Repair boardviews:**
"This looks like a repair boardview file, which the viewer doesn't read."

**Other cheap wins:**
- The LCSC/JLCPCB BOM aliases are already done. `headerAliases.ts` maps `lcsc`, `lcsc part #` and the `LCSC_JLCPCB` pattern to `distributor_pn`. The only gap found is a plain "supplier part" header.
- Route a CPL/pick-and-place file to /bom and join it by designator.
- Show the .gbrjob stackup in the existing Stackup tab (a JSON read).
- A refusal counter that records only the detected format class, pending the owner's decision.

## Licensing

This is engineering guidance, not legal advice. The Design Viewer programme is GPL-3.0-or-later.

**CAN go in the client bundle:**
- **KiCad importer code ported to TypeScript.** Licences vary file by file. GPL-2.0-or-later: Altium, EAGLE board/parser, all three EasyEDA generations, gEDA PCB, DipTrace, Sprint-Layout, the PADS PCB side, Autotrax, P-CAD schematic. GPL-3.0-or-later: EAGLE schematic, PADS schematic, OrCAD, CADSTAR, gEDA schematic, most Allegro .cpp files. All are compatible, and ported code stays GPL.
- **MIT, Apache-2.0, BSD and ISC libraries:** altiumts, cfb, parseagle (MIT or Apache-2.0), the MakerPnP Gerber crates, wasm-gerber-viewer, tracespace, boardui, the EasyEDA GenCAD viewer (Apache-2.0), three.js loaders, fflate, and circuit-json-to-kicad (MIT). circuit-json declares ISC only in its npm metadata; check the tarball before vendoring.
- **LGPL-2.1 occt-import-js (STEP)**, kept as a separately loaded, replaceable WASM module.
- **Readers written from published specs:**
  - The EAGLE DTD (CC BY-ND 3.0) explicitly permits reader/writer implementations. We don't need to ship the DTD.
  - Gerber and XNC can be read freely; Ucamco only forbids extending or renaming the format.
  - The IDF 3.0 spec states no restrictions.

**CANNOT go in the bundle:**
- **GPL-2.0-only code:** Swoop. ipc2581_to_odb is GPL-2.0; check whether it is "only" or "or later" first.
- **Unlicensed repos (all rights reserved):** altium-cli, easyedats, ipc2581-to-kicad, Altium-IntLib-Parser, ljmljz/fabmaster, cds2f, odb-pp-parser, the Upverter converter fork, ms14_decoder, and EasyEDA's own easyeda-pro-file-format and eprj3-format repos (read those as documentation only).
- **Fritzing core parts (CC-BY-SA 3.0):** not declared GPLv3-compatible. If ever used, serve them as separate data with attribution.
- **AGPL code:** altium-toolkit (via circuitjson-toolkit), BoardRipper, altium_monkey, OdbDesign, easyeda2kicad.py. It can legally be combined with GPL-3.0, but it adds network-use source obligations. Use these as references only.

**Specs and EULAs:**
- **ODB++:** the spec is marked "unpublished work … for internal business purposes only" (confirmed in the PDF). Shipping a public reader built from it needs the owner's or counsel's decision. Alternatives are the free ODB++ Solutions Alliance or skipping ODB++ for IPC-2581. Never redistribute the PDF.
- **IPC-2581:** the standard is sold by IPC and the XSD returns 403 (the price is unverified; IPC dates Rev C to 2020-12-01). Implementing from the consortium's free test cases and KiCad's GPL writer is normal practice.
- **Vendor EULAs** (Altium, Cadence, Siemens, Autodesk) bind their licensees against reverse engineering the software. Our rule: port KiCad's clean-room work and read users' files; never decompile vendor binaries. The Altium EULA §3.3 wording is unverified.

**Server-side options, and why to avoid them:**
- **kicad-cli pcb import on our server.** KiCad 10 covers altium, eagle, cadstar, fabmaster, pads, pcad and solidworks — not allegro, geda or easyeda. Schematic import is on master only. This would upload the files, which BREAKS "your design files never leave your browser" for those formats. It would also load a heavy KiCad install onto the t3.small that swap-thrashed on 2026-09-23. If ever offered, it must be an explicit, separately worded opt-in upload. Recommendation: don't.
- **The Altium 365 / Nexar API** would route design data through our servers under a competitor's terms. Not recommended.
- **KiCad compiled to WASM:** the sweeps judged it blocked by wxWidgets. That judgement is unverified as a hard blocker, but it would be a very large project either way.

Every recommended phase stays fully client-side.

## Open questions for the owner

- Phase 1 order: EAGLE, then the Altium SchDoc BOM, then EasyEDA, then IPC-2581. This puts cheap, documented formats ahead of Altium's #1 demand. Do you agree?
- May the viewer send an anonymous 'refused: {format class}' event (no file names or content) so we can measure real demand? It is a new network call from /viewer, so the privacy copy would need a line about it.
- ODB++: take the 'internal business purposes only' spec legend to counsel, join the free ODB++ Solutions Alliance, or skip ODB++ and rely on IPC-2581?
- Is a second renderer engine for Gerber/drill (added bundle weight, its own async chunk) acceptable? Or should fab zips stay 'recognise and route the BOM' only?
- IPC-2581 and ODB++ files can reach tens or hundreds of MB, far above today's 8 MB per file / 12 MB total intake caps. Should these formats get their own higher caps, since everything runs on the visitor's machine?
- May a format ship as 'priced BOM only' with drawing tabs saying 'coming soon', or should a format appear only once it fully renders?
- Confirm that server-side conversion (kicad-cli) stays off the table, i.e. the 'never leaves your browser' promise outranks format coverage.
- Marketing: Altium 365 Viewer uploads designs to Altium's cloud and prices BOMs through Octopart. Once Phase 1 ships, do you want 'Altium files, priced, without uploading' as a line?

## Corrections the skeptics applied

- Altium ASCII SchDoc import first shipped in KiCad 8.0.2, not 8.0.0.
- Altium .PrjPcb whole-project import first shipped in KiCad 9.0.3 (2025-07-07), not 9.0.0. Variants arrived in 10.0.
- OpenOrCadParser, OpenAllegroParser and LC2KiCad are ARCHIVED repositories, so treat them as dead references.
- KiCad's EasyEDA (Std, Pro v2, Pro v3), gEDA PCB, DipTrace, Sprint-Layout and PADS PCB-side importers are GPL-2.0-or-later, not GPL-3.0-or-later. Fabmaster and Allegro mix GPL-2.0+ and GPL-3.0+ files. All are still compatible with our GPL-3.0-or-later programme.
- EasyEDA Standard DOES have a project-level import in KiCad (the backup .zip, since 8.0).
- Added three formats the sweeps missed: LTspice .asc schematics (KiCad 8.0+), Protel Autotrax/Easytrax boards (master only), and P-CAD 2006 schematics/projects (master only).
- The KiCad 10 'pcb import' CLI covers altium, eagle, cadstar, fabmaster, pads, pcad and solidworks. It does NOT cover allegro, geda or easyeda.
- 'Fabmaster is the only format KiCad turns into a .kicad_pcb' holds only within the manufacturing/neutral-format slice.
- circuit-json-to-kicad is MIT, not NOASSERTION. circuit-json's ISC licence appears only in its npm metadata.
- IPC-2581C is dated 2020-12-01 by IPC. The price is unverified.
- The claim that a PcbDoc carries no MPN is downgraded to unverified: it reflects what KiCad reads, not the format.
- Downgraded to unverified heuristics: DesignSpark CFB streams, the TARGET 3001! signature, Multisim container details, Flux .flx, the Proteus 9 zip layout, and the Altium EULA §3.3 wording.
- Added a detection collision: legacy Proteus ISIS .DSN files share the .DSN extension with OrCAD Capture.
- The Gerber job schema describes itself as revision 2023.06.
- The sweep's suggested LCSC/JLCPCB BOM aliases already exist in headerAliases.ts (mapped to distributor_pn), so that item is marked done.
