// @vitest-environment happy-dom
// frontend/src/public/components/kicad/webgl.test.ts
import { describe, expect, it } from 'vitest';
import { resetWebgl2ProbeForTests, webgl2Supported } from './webgl';

function fakeCanvas(gl: { getExtension: (n: string) => { loseContext: () => void } | null } | null) {
  return { getContext: () => gl } as unknown as HTMLCanvasElement;
}

describe('webgl2Supported', () => {
  it('probes once per document and releases the context it created', () => {
    resetWebgl2ProbeForTests();
    let lost = 0;
    let probes = 0;
    const create = () => {
      probes++;
      return fakeCanvas({ getExtension: () => ({ loseContext: () => lost++ }) });
    };
    expect(webgl2Supported(create)).toBe(true);
    expect(webgl2Supported(create)).toBe(true);
    expect(probes).toBe(1);
    expect(lost).toBe(1);
  });
  it('reports false when the browser refuses a context', () => {
    resetWebgl2ProbeForTests();
    expect(webgl2Supported(() => fakeCanvas(null))).toBe(false);
  });
});
