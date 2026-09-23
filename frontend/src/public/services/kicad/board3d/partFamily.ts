// Which FAMILY a footprint belongs to, from its library id and, failing that,
// its reference prefix (owner, 2026-09-22: a learner clicking a part "will just
// be seeing a 3d box"). The family is what tints its estimated body in the 3D
// view — a black package for an IC, a tan chip for a capacitor, a grey housing
// for a connector — so a box reads as the kind of thing it stands for. It is a
// reading of the NAME, never of the geometry: a footprint the names do not
// place stays `other`, drawn as the smoked glass it always was, rather than
// guessed at.
//
// Pure, fixture-tested: Glasgow's J refs come out connectors, its U refs ICs,
// its C and R refs passives, its LED_SMD parts LEDs.

export type PartFamily = 'connector' | 'ic' | 'passive' | 'led' | 'other';

/** The families in the order the legend lists them. */
export const PART_FAMILIES: readonly PartFamily[] = ['ic', 'passive', 'connector', 'led', 'other'];

/**
 * Library-name rules, in the order they are tried. The first match wins, so
 * the more specific patterns come first: `LED_` before the package families
 * (an `LED_SMD:LED_0603` must not read as a passive because it says 0603),
 * `Crystal` and `Oscillator` are ICs to the eye (metal-canned blocks), and a
 * resistor NETWORK (`R_Array`) is a passive. Each pattern is anchored to a
 * TOKEN start — the library prefix, the part after the colon, or an
 * underscore — so `SOT` inside `PinSocket` does not make a socket an IC.
 */
const LIB_RULES: readonly [PartFamily, RegExp][] = [
  ['led', /(^|[:_])(LED|Light|Lamp)(?=[_:-]|\d|$)/i],
  ['connector', /(^|[:_])(Connector|PinHeader|PinSocket|Socket|IDC|Molex|JST|USB|HDMI|RJ45|Jack|Terminal|Header|Wire_Pads?|Card|SIM|DSUB|DB\d|Pogo|FFC|FPC|ZIF)(?=[_:-]|\d|$)/i],
  ['passive', /(^|[:_])(Capacitor|Resistor|Inductor|Choke|Ferrite|Bead|Varistor|Thermistor|Fuse|Potentiometer|Trimmer|C|R|L|FB|R_Array|C_Array|CP|C_Disc|C_Elec)(?=[_:-]|\d|$)/i],
  ['ic', /(^|[:_])(Package|SOIC|SOP|SSOP|TSSOP|MSOP|VSSOP|HTSSOP|QFN|DFN|UDFN|WDFN|TDFN|BGA|CSP|WLCSP|LGA|QFP|LQFP|TQFP|PQFP|SOT|SC-?70|TO-?\d+|DIP|PDIP|SIP|PLCC|Crystal|Oscillator|Resonator|D_SOD|SOD|SMA|SMB|SMC|DO-?\d+|Diode|Transistor|Regulator|Sensor|Module|Relay|Optocoupler)(?=[_:-]|\d|$)/i],
];

/** Reference-prefix rules, tried only when the library said nothing. A `D`
 *  is left out on purpose: it is a diode OR an LED, and a wrong tint teaches
 *  the wrong thing. */
const REF_RULES: readonly [PartFamily, RegExp][] = [
  ['connector', /^(J|P|X|CN|CON)\d/i],
  ['ic', /^(U|IC|Q|Y|X?TAL|VR|K)\d/i],
  ['passive', /^(C|R|L|FB|RN|RV|TH|F|RT|LS?)\d/i],
  ['led', /^(LED|LD)\d/i],
];

/**
 * The family of a footprint named `lib` (KiCad's `Library:Footprint` id, or a
 * bare footprint name) with reference `ref`. Both may be empty.
 */
export function partFamily(lib: string, ref = ''): PartFamily {
  const name = lib.trim();
  if (name !== '') {
    for (const [family, rule] of LIB_RULES) if (rule.test(name)) return family;
  }
  const designator = ref.trim();
  if (designator !== '') {
    for (const [family, rule] of REF_RULES) if (rule.test(designator)) return family;
  }
  return 'other';
}

/** Which passive a passive is, for the tint its chip takes: a capacitor's tan
 *  ceramic, a resistor's black film, an inductor's grey ferrite. */
export type PassiveKind = 'cap' | 'res' | 'ind';

/** Token-anchored like LIB_RULES, tried in this order on the library id. */
const PASSIVE_LIB_RULES: readonly [PassiveKind, RegExp][] = [
  ['cap', /(^|[:_])(Capacitor|C|CP|C_Elec|C_Disc|C_Array)(?=[_:-]|\d|$)/i],
  ['res', /(^|[:_])(Resistor|R|R_Array|Potentiometer|Trimmer|Thermistor|Varistor)(?=[_:-]|\d|$)/i],
  ['ind', /(^|[:_])(Inductor|L|Ferrite|FB|Bead|Choke)(?=[_:-]|\d|$)/i],
];

const PASSIVE_REF_RULES: readonly [PassiveKind, RegExp][] = [
  ['cap', /^C\d/i],
  ['res', /^(R|RN|RV|RT|TH)\d/i],
  ['ind', /^(L|FB)\d/i],
];

/**
 * The kind of a PASSIVE footprint named `lib` with reference `ref` — the
 * library first (`Capacitor_SMD:C_0402…` → cap), the designator only when the
 * library says nothing. Null when neither does: a fuse, a potentiometer the
 * names do not settle, stay the plain passive tint rather than a guessed one.
 * Meaningful only for a footprint `partFamily` calls `passive`.
 */
export function passiveKind(lib: string, ref = ''): PassiveKind | null {
  const name = lib.trim();
  if (name !== '') {
    for (const [kind, rule] of PASSIVE_LIB_RULES) if (rule.test(name)) return kind;
  }
  const designator = ref.trim();
  if (designator !== '') {
    for (const [kind, rule] of PASSIVE_REF_RULES) if (rule.test(designator)) return kind;
  }
  return null;
}
