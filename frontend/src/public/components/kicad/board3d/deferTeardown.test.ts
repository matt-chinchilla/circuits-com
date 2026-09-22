import { describe, expect, it } from 'vitest';
import { deferTeardown } from './sceneRenderer';

// Leaving the 3D tab used to lose the WebGL context synchronously inside the
// tab click's React commit — 4.7 s on a software rasteriser — so the tab the
// reader had just picked could not paint until the old one had finished dying.
// The contract: the teardown NEVER runs on the calling task, runs exactly once,
// and runs whether or not the browser offers requestIdleCallback.
describe('deferTeardown', () => {
  it('uses requestIdleCallback with a timeout when the browser has it, never synchronously', () => {
    let ran = 0;
    let queued: { fn: () => void; timeout?: number } | null = null;
    deferTeardown(() => { ran++; }, {
      requestIdleCallback: (fn, options) => { queued = { fn, timeout: options?.timeout }; return 1; },
      setTimeout: () => { throw new Error('should prefer idle'); },
    });
    expect(ran).toBe(0);
    expect(queued).not.toBeNull();
    expect(queued!.timeout).toBeGreaterThan(0);
    queued!.fn();
    queued!.fn();
    expect(ran).toBe(1);
  });
  it('falls back to a macrotask where requestIdleCallback is missing', () => {
    let ran = 0;
    let queued: (() => void) | null = null;
    deferTeardown(() => { ran++; }, { setTimeout: (fn) => { queued = fn; return 1; } });
    expect(ran).toBe(0);
    queued!();
    expect(ran).toBe(1);
  });
});
