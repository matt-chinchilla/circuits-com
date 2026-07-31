import { describe, it, expect } from 'vitest';
import { canvasToDataUrl, MAX_DATA_URL_BYTES } from './image';

// alpha=255 everywhere -> opaque canvas; any sampled alpha<255 -> transparent.
const stubCanvas = (byMime: Record<string, string>, alpha = 255) =>
  ({
    width: 2,
    height: 2,
    toDataURL: (mime: string) => byMime[mime] ?? 'data:image/png;base64,x',
    getContext: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, alpha, 0, 0, 0, alpha]) }),
    }),
  }) as unknown as HTMLCanvasElement;

describe('canvasToDataUrl', () => {
  it('prefers webp', () => {
    const r = canvasToDataUrl(stubCanvas({ 'image/webp': 'data:image/webp;base64,ok' }));
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/webp;base64,ok' });
  });

  it('falls back to jpeg when webp encodes as png and the canvas is opaque', () => {
    const r = canvasToDataUrl(stubCanvas({ 'image/jpeg': 'data:image/jpeg;base64,ok' }));
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,ok' });
  });

  it('falls back to png when the canvas has transparency (rounded-crop corners)', () => {
    const r = canvasToDataUrl(
      stubCanvas({ 'image/png': 'data:image/png;base64,alpha' }, 128),
    );
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/png;base64,alpha' });
  });

  it('rejects oversized output', () => {
    const huge = `data:image/webp;base64,${'a'.repeat(MAX_DATA_URL_BYTES)}`;
    const r = canvasToDataUrl(stubCanvas({ 'image/webp': huge }));
    expect(r.ok).toBe(false);
  });
});
