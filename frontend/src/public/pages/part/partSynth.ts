// Pure logic for the part page's derived sections.
//
// Inventory history: the demo tracks no stock time-series, so the chart renders
// a DETERMINISTIC synthetic walk seeded from the part id — same part, same
// curve, every visit — that ends exactly at today's real total stock. Same
// convention as the demo's synthetic prices; the UI captions it "estimated".
//
// Spec extraction: every row is parsed from the REAL catalog description
// (voltages, currents, capacitance, frequency, package, tolerance, temp
// range). Nothing electrical is fabricated — a sparse description yields a
// short list, and real parametrics arrive with the distributor-API sync.

export interface HistoryPoint {
  /** Days before today; 0 = today. */
  daysAgo: number;
  stock: number;
}

export interface SpecRow {
  label: string;
  value: string;
}

/** FNV-1a over the string, for seeding. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Walk BACKWARDS from today's real stock: daily drift of ±2% with an
 * occasional restock cliff (seen in reverse as a drop). One 365-point series
 * per part; presets just window it, so switching presets never re-rolls
 * the curve.
 */
export function buildInventoryHistory(seedKey: string, currentStock: number): HistoryPoint[] {
  const rand = mulberry32(hashString(seedKey));
  const points: HistoryPoint[] = [{ daysAgo: 0, stock: Math.max(0, currentStock) }];
  let stock = Math.max(1, currentStock);
  for (let d = 1; d <= 365; d++) {
    const drift = 1 + (rand() - 0.48) * 0.04;
    stock = stock / drift;
    // A restock landed on this day (walking backwards: stock was lower before)
    if (rand() < 0.02) stock = stock * (0.45 + rand() * 0.3);
    stock = Math.max(0, Math.min(stock, currentStock * 4 + 1000));
    points.push({ daysAgo: d, stock: Math.round(stock) });
  }
  return points;
}

const PACKAGE_RE =
  /\b(SOT-?\d+[A-Z-]*|SOIC-?\d*|TSSOP-?\d*|MSOP-?\d*|QFN-?\d*|DFN-?\d*|LQFP-?\d*|TQFP-?\d*|BGA-?\d*|DIP-?\d*|PDIP-?\d*|TO-?\d+[A-Z]*|DO-?\d+[A-Z]*|SOD-?\d+[A-Z]*|SMA|SMB|SMC|0201|0402|0603|0805|1206|1210|2010|2512)\b/i;

/** Parse spec rows out of a real catalog description. */
export function extractSpecs(description: string | null): SpecRow[] {
  if (!description) return [];
  const specs: SpecRow[] = [];
  const seen = new Set<string>();
  const push = (label: string, value: string) => {
    if (!seen.has(label)) {
      seen.add(label);
      specs.push({ label, value });
    }
  };

  const volts = description.match(/\b(\d+(?:\.\d+)?)\s?(k?V)\b/i);
  if (volts) push('Voltage rating', `${volts[1]} ${volts[2].replace(/v/, 'V')}`);

  // Lookbehind blocks digits glued to a hyphen/word so package designators
  // like TO-220A don't read as a 220 A current rating (a lookahead after the
  // A can't catch this — the char after the package's A is a space).
  const amps = description.match(/(?<![\w-])(\d+(?:\.\d+)?)\s?(m|µ|u)?A\b/);
  if (amps) push('Current rating', `${amps[1]} ${(amps[2] ?? '').replace('u', 'µ')}A`);

  const farads = description.match(/\b(\d+(?:\.\d+)?)\s?(p|n|µ|u|m)?F\b/);
  if (farads) push('Capacitance', `${farads[1]} ${(farads[2] ?? '').replace('u', 'µ')}F`);

  // (?!\w) not \b — a trailing \b after Ω is a no-op without the /u flag
  // (Ω is non-ASCII, so Ω→space never forms an ASCII word boundary).
  const ohms = description.match(/\b(\d+(?:\.\d+)?)\s?(k|M|m)?(?:ohm|Ω)s?(?!\w)/i);
  if (ohms) push('Resistance', `${ohms[1]} ${ohms[2] ?? ''}Ω`);

  const hertz = description.match(/\b(\d+(?:\.\d+)?)\s?(k|M|G)?Hz\b/);
  if (hertz) push('Frequency', `${hertz[1]} ${hertz[2] ?? ''}Hz`);

  const tol = description.match(/±\s?(\d+(?:\.\d+)?)\s?%|\b(\d+(?:\.\d+)?)\s?%\s?(?:tol|tolerance)/i);
  if (tol) push('Tolerance', `±${tol[1] ?? tol[2]}%`);

  const temp = description.match(/(-\d+)\s?(?:°C)?\s?(?:to|~|\/)\s?\+?(\d+)\s?°C/);
  if (temp) push('Operating temp', `${temp[1]}°C to +${temp[2]}°C`);

  const pkg = description.match(PACKAGE_RE);
  if (pkg) push('Package', pkg[1].toUpperCase());

  const watts = description.match(/\b(\d+(?:\.\d+)?)\s?(m)?W\b/);
  if (watts) push('Power', `${watts[1]} ${watts[2] ?? ''}W`);

  return specs;
}
