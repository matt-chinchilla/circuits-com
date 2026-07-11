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

/**
 * Encode a canvas to a bounded data-URL: WebP 0.82 with JPEG 0.85 fallback
 * (Safari cannot encode WebP — toDataURL silently returns PNG there).
 */
export function canvasToDataUrl(canvas: HTMLCanvasElement): ImageEncodeResult {
  try {
    let dataUrl = canvas.toDataURL('image/webp', 0.82);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.85);
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
