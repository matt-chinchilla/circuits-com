/**
 * Attested BOM fixtures.
 *
 * Every string below traces to a specific, verified claim in
 * `docs/design-briefs/bom-kicad-research-2026-08-19.md` (the 13-agent research
 * packet in which verifier corrections override the original claims). Nothing
 * here is invented shape: if a spelling is not in the packet it is not in a
 * fixture.
 *
 * Imported ONLY by `parseBom.test.ts`, so it never reaches a bundle — but it is
 * a plain `.ts` (not `.test.ts`) on purpose, so tsc and eslint still police it.
 */

/**
 * `kicad-cli sch export bom` with NO flags (KiCad 8/9/10).
 *
 * Packet section 1: stock header `Refs,Value,Footprint,Qty,DNP`, comma field
 * delimiter, **no string delimiter — fields are not quoted**, and — the
 * correction that changes the design — `--group-by` has no default, so a bare
 * export emits ONE ROW PER SYMBOL with a single reference. The DNP field
 * expands to the friendly name when set and to an EMPTY STRING when not; it is
 * never `true`/`false`/`Y`.
 */
export const KICAD_CLI_UNQUOTED = `Refs,Value,Footprint,Qty,DNP
R1,10k,Resistor_SMD:R_0603_1608Metric,1,
R2,10k,Resistor_SMD:R_0603_1608Metric,1,
C1,100nF,Capacitor_SMD:C_0402_1005Metric,1,DNP
U1,LM317T,Package_TO_SOT_THT:TO-220-3_Vertical,1,
`;

/**
 * The unquoted multi-ref hazard (packet section 1, detector rule 4).
 *
 * With grouping ON and no string delimiter, a refs cell of `R1-R3,R7` is
 * byte-identical to two fields. **Cell count > header count is the only
 * signal** — there is no other. Row 1 therefore carries 6 cells against a
 * 5-cell header and must be repaired back into the refs column.
 */
export const UNQUOTED_MULTI_REF_OVERFLOW = `Refs,Value,Footprint,Qty,DNP
R1-R3,R7,10k,Resistor_SMD:R_0603_1608Metric,4,
C1,100nF,Capacitor_SMD:C_0402_1005Metric,1,
`;

/**
 * `bom_csv_grouped_by_value_with_fp.py` — one of the three bundled legacy
 * exporters (packet section 1).
 *
 * Header `Ref,Qnty,Value,Cmp name,Footprint,Description,Vendor,DNP` — note the
 * misspelled `Qnty` and the two-word `Cmp name`. All three legacy scripts write
 * with `csv.QUOTE_ALL` (every cell quoted) and join references with a comma
 * followed by a SPACE. This script and `bom_csv_grouped_by_value.py` also
 * prepend a FIVE-LINE metadata preamble — `Source:`, `Date:`, `Tool:`,
 * `Generator:`, `Component Count:` — so the header row is NOT row 0.
 */
export const LEGACY_GROUPED_WITH_FP = `"Source:","/home/kicad/proj/proj.kicad_sch"
"Date:","2026-08-19 14:02:11"
"Tool:","Eeschema (10.0.1)"
"Generator:","bom_csv_grouped_by_value_with_fp.py"
"Component Count:","5"
"Ref","Qnty","Value","Cmp name","Footprint","Description","Vendor","DNP"
"R1, R2, R3","3","10k","R","Resistor_SMD:R_0603_1608Metric","Resistor 10k 1pct 0603","Yageo",""
"C1, C2","2","100nF","C","Capacitor_SMD:C_0402_1005Metric","Ceramic 100nF X7R 0402","Murata",""
`;

/**
 * The TSV preset (packet section 1, detector rule 2) as KiBot and KiCad 8/9
 * spell it: REAL TAB characters between fields, and the field references still
 * in their unexpanded brace form (KiCad 10 drops the braces).
 *
 * The tabs below are literal U+0009 — do not "tidy" them into spaces or the
 * delimiter sniff has nothing to find.
 */
export const TSV_KIBOT = `References	Value	Footprint	\${QUANTITY}	\${DNP}
R1,R2	10k	Resistor_SMD:R_0603_1608Metric	2	
C1	100nF	Capacitor_SMD:C_0402_1005Metric	1	DNP
`;

/**
 * The semicolon preset (packet section 1, detector rule 2) with the industry
 * `Designator` / `Comment` spellings — `Comment` carries the VALUE (the
 * JLCPCB/Altium convention), never a note.
 */
export const SEMICOLON_EU = `Designator;Comment;Footprint;Quantity
R1,R2;10k;R_0603_1608Metric;2
C1;100nF;C_0402_1005Metric;1
`;

/**
 * The JLCPCB assembly shape: `Comment,Designator,Footprint,LCSC Part #`, refs
 * grouped inside ONE quoted cell. `LCSC Part #` is not a literal in the alias
 * table — it is matched by the LCSC/JLCPCB x Part-variant pattern rule, because
 * the verifier showed those spellings are built as a runtime cross-product
 * rather than enumerated.
 */
export const JLCPCB_STYLE = `Comment,Designator,Footprint,LCSC Part #
10k,"R1,R2",0603,C17414
100nF,"C1,C2,C3",0402,C14663
`;
