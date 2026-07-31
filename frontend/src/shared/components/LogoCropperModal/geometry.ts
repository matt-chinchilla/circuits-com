// Zoom below 1 letterboxes: the image no longer covers the frame and the
// export pads the margins white — how a wide wordmark fits a square tile.
export const MIN_ZOOM = 0.5;
export const DEFAULT_ZOOM = 1; // cover-fit; the historical minimum
export const MAX_ZOOM = 4;
export const OUTPUT_SIZE = 256;

/** Display scale at zoom 1: smallest scale where the image covers the square frame. */
export function coverScale(imgW: number, imgH: number, frame: number): number {
  return frame / Math.min(imgW, imgH);
}

/** Clamp a pan offset (display px, relative to centered) so the frame stays covered. */
export function clampOffset(
  imgW: number, imgH: number, frame: number, scale: number, offsetX: number, offsetY: number,
): { offsetX: number; offsetY: number } {
  const maxX = Math.max(0, (imgW * scale - frame) / 2);
  const maxY = Math.max(0, (imgH * scale - frame) / 2);
  return {
    // `+ 0` normalizes a `-0` result (e.g. Math.min(0, Math.max(-0, -50)) === -0
    // per IEEE-754) to `0` — a no-op for every non-zero value, but keeps this
    // in lockstep with the geometry tests' `toEqual({ offsetX, offsetY: 0 })`.
    offsetX: Math.min(maxX, Math.max(-maxX, offsetX)) + 0,
    offsetY: Math.min(maxY, Math.max(-maxY, offsetY)) + 0,
  };
}

/** Destination rect (output px) for export drawing — mirrors the on-screen
 *  CSS math exactly, so it is correct at EVERY zoom, including below cover-fit
 *  where a source-rect approach would read outside the image bounds. */
export function destRect(
  imgW: number, imgH: number, frame: number, scale: number,
  offsetX: number, offsetY: number, out: number,
): { dx: number; dy: number; dw: number; dh: number } {
  const k = (out / frame) * scale;
  return {
    dx: out / 2 - (imgW * k) / 2 + offsetX * (out / frame),
    dy: out / 2 - (imgH * k) / 2 + offsetY * (out / frame),
    dw: imgW * k,
    dh: imgH * k,
  };
}

/** Source rect (image px) shown in the frame — feeds the 9-arg drawImage. */
export function sourceRect(
  imgW: number, imgH: number, frame: number, scale: number, offsetX: number, offsetY: number,
): { sx: number; sy: number; size: number } {
  const size = frame / scale;
  const sx = (imgW - size) / 2 - offsetX / scale;
  const sy = (imgH - size) / 2 - offsetY / scale;
  return {
    sx: Math.min(Math.max(0, sx), Math.max(0, imgW - size)),
    sy: Math.min(Math.max(0, sy), Math.max(0, imgH - size)),
    size,
  };
}
