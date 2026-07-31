// Client-side image helpers: async decode (`loadImage`) plus a synchronous,
// bounded data-URL encode (`canvasToDataUrl`) so a logo/icon can be stored
// inline in the DB (no upload endpoint). WebP first, JPEG fallback (Safari
// can't encode WebP), capped at MAX_DATA_URL_BYTES. No React.

export type ImageEncodeResult = { ok: true; dataUrl: string } | { ok: false; error: string };

/** Hard ceiling on the encoded string; keeps /partners responses lean. */
export const MAX_DATA_URL_BYTES = 64000;

export function loadImage(url: string, crossOrigin?: 'anonymous'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.src = url;
  });
}

/** Coarse transparency probe (every 16th pixel) — decides the encode fallback. */
function canvasHasAlpha(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 64) {
    if (data[i] < 255) return true;
  }
  return false;
}

/**
 * Encode a canvas to a bounded data-URL: WebP 0.82 first. Fallback when the
 * browser can't encode WebP (Safari — toDataURL silently returns PNG there):
 * JPEG 0.85 for opaque canvases, PNG when the canvas carries transparency
 * (a rounded-square crop's corners — JPEG would flatten them to black).
 */
export function canvasToDataUrl(canvas: HTMLCanvasElement): ImageEncodeResult {
  try {
    let dataUrl = canvas.toDataURL('image/webp', 0.82);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvasHasAlpha(canvas)
        ? canvas.toDataURL('image/png')
        : canvas.toDataURL('image/jpeg', 0.85);
    }
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      return { ok: false, error: 'That image is too detailed to store. Try a simpler version.' };
    }
    return { ok: true, dataUrl };
  } catch (err) {
    console.error('canvasToDataUrl failed', err);
    return { ok: false, error: 'Your browser could not process this image.' };
  }
}
