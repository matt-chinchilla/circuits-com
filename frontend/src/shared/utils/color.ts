/** Strict #RRGGBB gate for stored brand colors (defense-in-depth mirror of safeImageUrl). */
export function safeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : null;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** Per-channel sRGB mix — numerically equivalent to CSS color-mix(in srgb, a W%, b). */
export function mixHex(a: string, b: string, weightA: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const w = weightA;
  return rgbToHex(pa.r * w + pb.r * (1 - w), pa.g * w + pb.g * (1 - w), pa.b * w + pb.b * (1 - w));
}
