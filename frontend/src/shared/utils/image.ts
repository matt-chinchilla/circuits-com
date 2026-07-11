// Client-side image normalizer: downscale to a bounded raster data-URL so a
// logo/icon can be stored inline in the DB (no upload endpoint). WebP first,
// JPEG fallback. Pure async — no React. Caller stores the returned data-URL.

export type ImageEncodeResult = { ok: true; dataUrl: string } | { ok: false; error: string };

/** Hard ceiling on the encoded string; keeps /partners responses lean. */
export const MAX_DATA_URL_BYTES = 64000;
const DEFAULT_MAX_EDGE = 256;

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

export async function fileToDataUrl(
  file: File,
  maxEdge: number = DEFAULT_MAX_EDGE,
): Promise<ImageEncodeResult> {
  if (!file.type.startsWith('image/')) {
    return { ok: false, error: 'Please choose an image file (PNG, JPG, WebP, GIF).' };
  }
  if (file.size === 0) {
    return { ok: false, error: 'That file is empty.' };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return { ok: false, error: 'Could not read that image.' };

    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: 'Image processing is unavailable in this browser.' };
    ctx.drawImage(img, 0, 0, cw, ch);

    // Prefer WebP; fall back to JPEG if the browser can't encode WebP
    // (toDataURL silently returns a PNG instead — detect via the prefix).
    let dataUrl = canvas.toDataURL('image/webp', 0.82);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    }

    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      return { ok: false, error: 'That image is too detailed — try a smaller or simpler logo.' };
    }
    return { ok: true, dataUrl };
  } catch (err) {
    console.error('[fileToDataUrl]', err);
    const msg = err instanceof DOMException
      ? 'That image type is not supported — try PNG, JPEG, or WebP.'
      : 'Could not process that image.';
    return { ok: false, error: msg };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
