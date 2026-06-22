// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { fileToDataUrl } from './image';

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
