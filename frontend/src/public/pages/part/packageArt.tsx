// Representative package illustrations — the industry-standard middle tier
// between a real product photo and a bare category icon. Distributors do the
// same (a generic package render + "image is a representation only"); ours
// are in-house schematic-style line art, so no licensing strings attached.
//
// Selection keys off the package token extractSpecs already parses from the
// REAL description (DFN-10, TO-220, 0805, ...) — no fabricated data.

const ARCHETYPES = [
  { key: 'chip', re: /^(0201|0402|0603|0805|1206|1210|2010|2512)/ },
  // SOD is a two-terminal DIODE package — it belongs with the axial/diode
  // art, not the 3-pin SOT render (review-caught).
  { key: 'axial', re: /^(DO-?\d|SOD|SMA$|SMB$|SMC$)/ },
  { key: 'sot', re: /^SOT/ },
  { key: 'soic', re: /^(SOIC|TSSOP|MSOP)/ },
  { key: 'qfn', re: /^(QFN|DFN)/ },
  { key: 'qfp', re: /^(LQFP|TQFP)/ },
  { key: 'bga', re: /^BGA/ },
  { key: 'to', re: /^TO-?\d/ },
  { key: 'dip', re: /^P?DIP/ },
] as const;

type ArchetypeKey = (typeof ARCHETYPES)[number]['key'];

export function packageFamily(pkg: string | null | undefined): ArchetypeKey | null {
  if (!pkg) return null;
  const token = pkg.trim().toUpperCase();
  for (const a of ARCHETYPES) {
    if (a.re.test(token)) return a.key;
  }
  return null;
}

const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Art({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true" width="100%" height="100%">
      <g {...S}>{children}</g>
    </svg>
  );
}

const ART: Record<ArchetypeKey, () => React.JSX.Element> = {
  // SMD chip passive: body with metallized end caps
  chip: () => (
    <Art>
      <rect x="22" y="44" width="76" height="32" rx="3" />
      <rect x="22" y="44" width="14" height="32" rx="3" fill="currentColor" fillOpacity="0.18" />
      <rect x="84" y="44" width="14" height="32" rx="3" fill="currentColor" fillOpacity="0.18" />
    </Art>
  ),
  // SOT-23: 3-pin gullwing
  sot: () => (
    <Art>
      <rect x="34" y="38" width="52" height="44" rx="5" />
      <path d="M44 38 V26 M76 38 V26 M60 82 V94" />
      <path d="M44 26 H36 M76 26 H84 M60 94 H68" />
    </Art>
  ),
  // SOIC/TSSOP: dual-row gullwing IC
  soic: () => (
    <Art>
      <rect x="34" y="28" width="52" height="64" rx="5" />
      <circle cx="44" cy="38" r="3" fill="currentColor" stroke="none" />
      <path d="M34 40 H20 M34 56 H20 M34 72 H20 M34 88 H20" />
      <path d="M86 40 H100 M86 56 H100 M86 72 H100 M86 88 H100" />
    </Art>
  ),
  // QFN/DFN: no-lead top view, pads on the perimeter + pin-1 dot
  qfn: () => (
    <Art>
      <rect x="28" y="28" width="64" height="64" rx="6" />
      <circle cx="42" cy="42" r="3.5" fill="currentColor" stroke="none" />
      <path d="M40 28 V20 M60 28 V20 M80 28 V20" />
      <path d="M40 92 V100 M60 92 V100 M80 92 V100" />
      <path d="M28 40 H20 M28 60 H20 M28 80 H20" />
      <path d="M92 40 H100 M92 60 H100 M92 80 H100" />
      <rect x="48" y="48" width="24" height="24" rx="2" strokeDasharray="3 3" strokeWidth="1.5" />
    </Art>
  ),
  // LQFP/TQFP: quad flat pack with gullwing leads on all sides
  qfp: () => (
    <Art>
      <rect x="32" y="32" width="56" height="56" rx="5" />
      <circle cx="44" cy="44" r="3" fill="currentColor" stroke="none" />
      <path d="M42 32 V22 M52 32 V22 M62 32 V22 M72 32 V22" strokeWidth="2" />
      <path d="M42 88 V98 M52 88 V98 M62 88 V98 M72 88 V98" strokeWidth="2" />
      <path d="M32 42 H22 M32 52 H22 M32 62 H22 M32 72 H22" strokeWidth="2" />
      <path d="M88 42 H98 M88 52 H98 M88 62 H98 M88 72 H98" strokeWidth="2" />
    </Art>
  ),
  // BGA: body with solder-ball grid
  bga: () => (
    <Art>
      <rect x="26" y="26" width="68" height="68" rx="5" />
      {[42, 56, 70, 84].flatMap((x) =>
        [42, 56, 70, 84].map((y) => (
          <circle key={`${x}-${y}`} cx={x - 3} cy={y - 3} r="4" strokeWidth="2" />
        )),
      )}
    </Art>
  ),
  // TO-220 family: tab + body + 3 legs
  to: () => (
    <Art>
      <rect x="34" y="20" width="52" height="26" rx="3" />
      <circle cx="60" cy="33" r="6" />
      <rect x="34" y="46" width="52" height="34" rx="3" />
      <path d="M44 80 V102 M60 80 V102 M76 80 V102" />
    </Art>
  ),
  // Axial / SMx diode: body with cathode band and leads
  axial: () => (
    <Art>
      <path d="M10 60 H34 M86 60 H110" />
      <rect x="34" y="44" width="52" height="32" rx="4" />
      <rect x="72" y="44" width="9" height="32" fill="currentColor" fillOpacity="0.22" stroke="none" />
    </Art>
  ),
  // DIP: through-hole dual inline with notch
  dip: () => (
    <Art>
      <rect x="36" y="24" width="48" height="72" rx="4" />
      <path d="M52 24 A 8 8 0 0 0 68 24" />
      <path d="M36 36 H24 M36 52 H24 M36 68 H24 M36 84 H24" />
      <path d="M84 36 H96 M84 52 H96 M84 68 H96 M84 84 H96" />
    </Art>
  ),
};

export default function PackageArt({ family }: { family: ArchetypeKey }) {
  const Fn = ART[family];
  return <Fn />;
}
