// The pure half of <CausticField />: the GLSL sources and the colour reader,
// kept DOM-free so the test can witness the shader math and the parser
// without a canvas.
//
// The fragment shader is Figma's first-party "Water caustic" shader fill,
// ported 1:1 from WGSL to GLSL ES 1.00 (WebGL1). Two things differ from the
// Figma source, both by spec (docs/superpowers/specs/2026-09-25-about-page-design.md):
//   - the clock: Figma's `playhead * TAU / 100 + 23` becomes
//     `u_time * 0.10 + 23.0` (u_time in seconds), a slow ambient drift;
//   - the output: Figma's `mix(waterColor, highlightColor, mask)` becomes
//     `mix(u_base, u_accent, mask * 0.30)`, opaque, so the light is a faint
//     accent tint over the section's own ground rather than a water picture.
// Everything between (MAX_ITER 5, intensity 0.35, scale 1.6, the 1.17/1.4/8.0
// shaping) is the Figma math verbatim; causticField.test.ts witnesses it.

/** One triangle that covers clip space: cheaper than a quad (no diagonal seam, 3 vertices). */
export const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

export const VERTEX_SRC = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// highp where the GPU has it: p sits near -250, where mediump (fp16) keeps
// only ~0.125 of precision and the caustic would band into steps.
export const FRAGMENT_SRC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_base;
uniform vec3 u_accent;

const float TAU = 6.28318530718;
const int MAX_ITER = 5;
const float INTENSITY = 0.35;
const float SCALE = 1.6;
const float CENTER = 0.5;

void main() {
  // Figma's uv runs top-down; gl_FragCoord runs bottom-up.
  vec2 uvRaw = vec2(gl_FragCoord.x / u_res.x, 1.0 - gl_FragCoord.y / u_res.y);
  vec2 uv = (uvRaw - CENTER) / SCALE + (1.0 - CENTER);

  float t_val = u_time * 0.10 + 23.0;
  float minDim = min(u_res.x, u_res.y);
  vec2 uvPx = uv * u_res / minDim;
  vec2 p = (fract(uvPx) * TAU) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = mix(0.002519, 0.01178, INTENSITY);

  for (int n = 0; n < MAX_ITER; n++) {
    float nt = t_val * float(n + 1);
    i = p + vec2(cos(nt - i.x) + sin(nt + i.y), sin(nt - i.y) + cos(nt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + nt) / inten), p.y / (cos(i.y + nt) / inten)));
  }
  c /= float(MAX_ITER);
  c = 1.17 - pow(c, 1.4);
  float causticMask = clamp(pow(abs(c), 8.0), 0.0, 1.0);

  gl_FragColor = vec4(mix(u_base, u_accent, causticMask * 0.30), 1.0);
}
`;

export type Rgb = readonly [number, number, number];

/** The steel ground and the brand accent, used when a token is missing or not a hex. */
export const FALLBACK_BASE: Rgb = [0x0e / 255, 0x11 / 255, 0x13 / 255];
export const FALLBACK_ACCENT: Rgb = [0x44 / 255, 0xbd / 255, 0x13 / 255];

/**
 * `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` → 0–1 channels (alpha dropped: the
 * field is opaque). Anything else — an rgb() string, a var(), an empty
 * custom property — is null, and the caller falls back.
 */
export function parseHexColor(value: string): Rgb | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .slice(0, 3)
      .split('')
      .map((ch) => ch + ch)
      .join('');
  } else if (hex.length === 8) {
    hex = hex.slice(0, 6);
  } else if (hex.length !== 6) {
    return null;
  }
  const n = parseInt(hex, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/**
 * Canvas backing size for a CSS box: half-resolution at DPR ≤ 1 and never
 * more than that on a dense screen (a 1180×640 section draws ~590×320
 * fragments). The caustic is soft light; the browser's upscale costs nothing
 * visible and quarters the fragment work.
 */
export function backingSize(cssW: number, cssH: number, dpr: number): { w: number; h: number } {
  const k = Math.min(dpr || 1, 1) * 0.5;
  return { w: Math.max(1, Math.round(cssW * k)), h: Math.max(1, Math.round(cssH * k)) };
}
