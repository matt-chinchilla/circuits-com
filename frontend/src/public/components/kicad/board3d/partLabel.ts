// The words on the label the 3D view hangs on a selected part (owner,
// 2026-09-22): the designator on the first line, and on the second what the
// part is — its value and its footprint's name, the library it came from
// dropped and its underscores opened into spaces, so
// `Connector_PinHeader_1.27mm:PinHeader_2x22_P1.27mm_Vertical__SMD` reads
// "PinHeader 2x22 P1.27mm Vertical SMD". Pure: the page hands in what
// partFacts knows, and this decides what to print.

export interface PartLabel {
  ref: string;
  value: string | null;
  footprint: string | null;
}

export interface LabelLines {
  title: string;
  /** Null when the sources know nothing beyond the designator. */
  detail: string | null;
}

/** `Package_SO:SOIC-8_3.9x4.9mm_P1.27mm` → `SOIC-8 3.9x4.9mm P1.27mm`. */
export function humanFootprint(footprint: string): string {
  const idx = footprint.indexOf(':');
  const name = idx >= 0 ? footprint.slice(idx + 1) : footprint;
  return name.replace(/_+/g, ' ').trim();
}

const SEP = ' · ';

export function labelLines(label: PartLabel): LabelLines {
  const footprint = label.footprint == null ? '' : humanFootprint(label.footprint);
  const value = label.value?.trim() ?? '';
  // A value that merely repeats the start of the footprint's name (KiCad
  // libraries often set the value to the footprint) says nothing twice.
  const redundant = value !== '' && footprint !== '' && footprint.toLowerCase().startsWith(value.replace(/_+/g, ' ').toLowerCase());
  const parts = [redundant ? '' : value, footprint].filter((s) => s !== '');
  return { title: label.ref, detail: parts.length === 0 ? null : parts.join(SEP) };
}
