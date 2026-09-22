// How far back the camera stands so the whole board fits the canvas (spec
// 2026-09-21 §5, refined 2026-09-22). Pure: the renderer hands in the model's
// box and the camera's numbers, and gets a distance.
//
// The first cut framed the board's DIAGONAL in the vertical field of view, so a
// wide canvas — the common desktop shape, 2.2:1 — showed the board at about a
// third of its width with sky on both sides. This one projects the box's eight
// corners through the actual perspective camera and asks the only question
// that matters: at what distance does every corner clear both edges?
//
// It answers for EVERY azimuth the auto-orbit will pass through, not just the
// reset pose — a tight fit that clips a corner ten seconds into the orbit is
// worse than a slightly loose one — so a rectangular board keeps a small slack
// at the reset azimuth and none at its widest.

export interface Vec3 { x: number; y: number; z: number }
export interface Box3Like { min: Vec3; max: Vec3 }

export interface FramingOptions {
  /** Vertical field of view, degrees — three's `PerspectiveCamera.fov`. */
  fovDeg: number;
  /** Canvas width / height. */
  aspect: number;
  elevationDeg: number;
  /** The azimuths the fit must hold at. Default: every 10°, the whole turn. */
  azimuthsDeg?: readonly number[];
  /** Slack beyond an exact fit; 1 is edge-to-edge. */
  margin?: number;
}

const DEG = Math.PI / 180;
const DEFAULT_AZIMUTHS: readonly number[] = Array.from({ length: 36 }, (_, i) => i * 10);

/**
 * Camera-to-target distance at which the box's corners all sit inside the
 * frustum, for a camera looking at the origin from (azimuth, elevation) with
 * +Z up — the same spherical convention `sceneRenderer.placeCamera` uses.
 */
export function fitDistance(box: Box3Like, options: FramingOptions): number {
  const margin = options.margin ?? 1.04;
  const tanV = Math.tan((options.fovDeg / 2) * DEG);
  const tanH = tanV * Math.max(1e-6, options.aspect);
  const el = options.elevationDeg * DEG;
  const corners: Vec3[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push({ x, y, z });

  let needed = 0;
  for (const azDeg of options.azimuthsDeg ?? DEFAULT_AZIMUTHS) {
    const az = azDeg * DEG;
    // Unit vector from the target to the camera; the camera's forward is -d.
    const d = { x: Math.cos(el) * Math.sin(az), y: Math.cos(el) * Math.cos(az), z: Math.sin(el) };
    // right = normalize(forward × up) with up = +Z; trueUp = right × forward.
    const rx = -d.y, ry = d.x;
    const rl = Math.hypot(rx, ry) || 1;
    const r = { x: rx / rl, y: ry / rl, z: 0 };
    const f = { x: -d.x, y: -d.y, z: -d.z };
    const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
    for (const c of corners) {
      // A corner at depth (D - along) in front of the camera is visible when its
      // lateral offset is within depth·tan(half-fov); solve for D.
      const along = c.x * d.x + c.y * d.y + c.z * d.z;
      const lateral = Math.abs(c.x * r.x + c.y * r.y + c.z * r.z);
      const vertical = Math.abs(c.x * u.x + c.y * u.y + c.z * u.z);
      needed = Math.max(needed, along + vertical / tanV, along + lateral / tanH);
    }
  }
  return Math.max(1e-3, needed * margin);
}
