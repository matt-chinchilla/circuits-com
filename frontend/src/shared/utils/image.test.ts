// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { fileToDataUrl, canvasToDataUrl, MAX_DATA_URL_BYTES } from './image';

function fakeFile(type: string, bytes = 10): File {
  return new File([new Uint8Array(bytes)], 'x', { type });
}

describe('fileToDataUrl', () => {
  it('rejects a non-image file before encoding', async () => {
    const r = await fileToDataUrl(fakeFile('application/pdf'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/image/i);
  });

  it('rejects an empty file', async () => {
    const r = await fileToDataUrl(fakeFile('image/png', 0));
    expect(r.ok).toBe(false);
  });
});

const stubCanvas = (byMime: Record<string, string>) =>
  ({ toDataURL: (mime: string) => byMime[mime] ?? 'data:image/png;base64,x' }) as unknown as HTMLCanvasElement;

describe('canvasToDataUrl', () => {
  it('prefers webp', () => {
    const r = canvasToDataUrl(stubCanvas({ 'image/webp': 'data:image/webp;base64,ok' }));
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/webp;base64,ok' });
  });

  it('falls back to jpeg when webp encodes as png', () => {
    const r = canvasToDataUrl(stubCanvas({ 'image/jpeg': 'data:image/jpeg;base64,ok' }));
    expect(r).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,ok' });
  });

  it('rejects oversized output', () => {
    const huge = `data:image/webp;base64,${'a'.repeat(MAX_DATA_URL_BYTES)}`;
    const r = canvasToDataUrl(stubCanvas({ 'image/webp': huge }));
    expect(r.ok).toBe(false);
  });
});
