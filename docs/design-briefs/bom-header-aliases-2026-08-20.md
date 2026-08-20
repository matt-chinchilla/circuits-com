# BOM header aliases — attested table (2026-08-20)

Source: 6 KiCad-ecosystem tool repos (kicad-jlcpcb-tools, KiBoM, KiCost,
InteractiveHtmlBom, KiBot, Fabrication-Toolkit) + vendor help pages, harvested by a
7-agent workflow; every repo claim re-grepped by a citation verifier: **301 upheld,
14 refuted** (refuted = runtime-constructed strings, kept below as PATTERN rules).
Raw claims with file:line citations: `bom-header-aliases-raw.json`.

Feeds `frontend/src/public/pages/bom/lib/headerAliases.ts`. Match case-insensitively,
trimmed of whitespace/punctuation.

## mpn
- `mpn` — fabrication-toolkit, interactivehtmlbom, kibot, kicost
- `man#` — kibot, kicost
- `man-num` — kibot, kicost
- `man_num` — kibot, kicost
- `manf#` — kibot, kicost
- `manf-num` — kibot, kicost
- `manf_num` — kibot, kicost
- `mfg part#` — kibot, kicost
- `mfg#` — kibot, kicost
- `mfg-num` — kibot, kicost
- `mfg_num` — kibot, kicost
- `mfr#` — kibot, kicost
- `mfr-num` — kibot, kicost
- `mfr_num` — kibot, kicost
- `mnf#` — kibot, kicost
- `mnf-num` — kibot, kicost
- `mnf_num` — kibot, kicost
- `Mpn` — fabrication-toolkit, interactivehtmlbom
- `MPN` — fabrication-toolkit, interactivehtmlbom
- `p#` — kibot, kicost
- `part#` — kibot, kicost
- `part-num` — kibot, kicost
- `part_num` — kibot, kicost
- `pn` — kibot, kicost
- `Manf#` — kicost
- `manpartno` — kicost
- `manufacturer part number` — kicost
- `mfr. no` — kicost
- `MFR.Part` — kicad-jlcpcb-tools
- `stock code` — kicost

## manufacturer
- `man` — kibot, kicost
- `manufacturer` — kibot, kicost
- `mfg` — kibot, kicost
- `mfr` — kibot, kicost
- `mnf` — kibot, kicost
- `manf` — kicost
- `Manf` — kicost
- `Manufacturer` — kicad-jlcpcb-tools
- `manufacturer name` — kicost

## refs
- `References` — interactivehtmlbom, kibom, kibot
- `Designator` — fabrication-toolkit, kicad-jlcpcb-tools
- `reference` — kicad-jlcpcb-tools, kicost
- `customer no` — kicost
- `designator` — kicost
- `part` — kicost
- `part reference` — kicost
- `parts` — kicost
- `Reference` — kibot
- `reference designator` — kicost
- `references` — kicost
- `refs` — kicost
- `Refs` — kicost

## qty
- `Quantity` — fabrication-toolkit, interactivehtmlbom, kicad-jlcpcb-tools
- `Build Quantity` — kibom, kibot
- `Quantity Per PCB` — kibom, kibot
- `${QUANTITY}` — kibot
- `manf#_qty` — kicost
- `order qty` — kicost
- `qty` — kicost
- `Qty` — kicost
- `quantity` — kicost

## value
- `Value` — fabrication-toolkit, interactivehtmlbom, kibom, kibot, kicost
- `value` — interactivehtmlbom, kicad-jlcpcb-tools
- `Comment` — kicad-jlcpcb-tools
- `Part Value` — kicad-jlcpcb-tools
- `Val` — kicad-jlcpcb-tools

## footprint
- `Footprint` — fabrication-toolkit, interactivehtmlbom, kibom, kibot, kicad-jlcpcb-tools, kicost
- `Footprint Lib` — kibom, kibot
- `package` — interactivehtmlbom, kicost
- `footprint` — kicad-jlcpcb-tools
- `Footprint Full` — kibot
- `Package` — kicad-jlcpcb-tools
- `pcb footprint` — kicost
- `pcb package` — kicost

## description
- `Description` — interactivehtmlbom, kibom, kibot, kicad-jlcpcb-tools
- `description` — kibot, kicost
- `desc` — kicost
- `Desc` — kicost

## datasheet
- `Datasheet` — interactivehtmlbom, kibom, kibot, kicad-jlcpcb-tools, kicost
- `pdf` — kibot, kicost

## dnp
- `dnp` — fabrication-toolkit, interactivehtmlbom, kibom, kicost
- `Config` — kibom, kibot
- `nopop` — kibot, kicost
- `${DNP}` — kibot
- `DNP` — interactivehtmlbom
- `exclude_from_bom` — kibom
- `fit_field` — kibom
- `fit_field = Config` — kibom
- `kicad_dnp` — interactivehtmlbom

## distributor_pn
- `LCSC` — fabrication-toolkit, kibot, kicad-jlcpcb-tools
- `lcsc` — kibot, kicad-jlcpcb-tools, kicost
- `arrow` — kibot, kicost
- `digikey` — kibot, kicost
- `farnell` — kibot, kicost
- `mouser` — kibot, kicost
- `newark` — kibot, kicost
- `part#` — kibot, kicost
- `rs` — kibot, kicost
- `tme` — kibot, kicost
- `#` — kibot
- `cat#` — kicost
- `Cat#` — kicost
- `JLC` — fabrication-toolkit
- `JLC_PN` — kicad-jlcpcb-tools
- `LCSC Part #` — fabrication-toolkit
- `LCSC Part #(optional)` — kicost
- `LCSC#` — kibot
- `LCSC_PN` — kicad-jlcpcb-tools
- `num` — kibot
- `p#` — kibot
- `pn` — kibot
- `vendor#` — kibot
- `vp#` — kibot
- `vpn` — kibot

## Pattern rules (verifier-corrected: derived at runtime, not literals)

- `<distributor> + '#'` — KiCost accepts `digikey#`, `mouser#`, `arrow#`, ... for every distributor it knows (kicost/edas/eda.py:92-96).
- `{LCSC|JLCPCB} × {Part #, Part, PN, P/N, Part No., Part Number}` — Fabrication-Toolkit cross-product (plugins/process.py:463-465).

## Vendor templates (web-attested)

- JLCPCB upload columns: `Comment` (= VALUE, not a note!), `Designator`, `Footprint`, `JLCPCB Part #` — jlcpcb.com help.
- Digi-Key myLists template: **UNVERIFIED** (login-gated); only 'Customer Reference' attested via their blog.
- Mouser template file: **UNVERIFIED** (Akamai blocks non-browser fetches).

## Detector implications

1. `Comment` maps to VALUE (JLCPCB convention) — never treat it as a free-text note.
2. `Designator` dominates fab-world refs; `Refs`/`Reference(s)`/`References` dominate KiCad-world. Accept all.
3. `Package` is a footprint-role alias (kicad-jlcpcb-tools) — feeds the parts.package warn feature directly.
4. KiCost's `manf#` family (~25 spellings incl. `mfg#`, `mfr#`, `man_num`, `part-num`) is the attested MPN alias set.
5. `Config` / `nopop` / `kicad_dnp` are DNP-role aliases beyond the literal `DNP`.