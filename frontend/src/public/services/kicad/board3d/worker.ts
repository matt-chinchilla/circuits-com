// The build, off the main thread (spec 2026-09-21 §3.3). A shell and nothing more:
// every decision is in buildScene, so the worker and the same-thread fallback in
// useBoardScene cannot drift apart.
//
// The scene's typed arrays are TRANSFERRED, not copied — a Glasgow-sized board is
// ~7 MB of Float32Array, and structured-cloning it would hand the main thread the
// stall the worker exists to avoid.
import { KicadReadError } from '../types';
import { buildScene, transferList, type BuildInput, type BuildReply } from './buildScene';

/**
 * A dedicated worker's global, narrowed to the two members this file uses. The
 * project compiles against the DOM lib, where `self` is a Window whose
 * `postMessage` takes a targetOrigin string — so the transfer-list call would not
 * type-check. This local view is cheaper and more honest than switching the whole
 * app's `lib` to webworker for one file.
 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<BuildInput>) => void) | null;
  postMessage: (message: BuildReply, transfer?: Transferable[]) => void;
};

ctx.onmessage = (event) => {
  try {
    const scene = buildScene(event.data);
    ctx.postMessage({ ok: true, scene }, transferList(scene));
  } catch (err) {
    // A KicadReadError already carries a sentence written for a person, and its
    // `kind` lets the host tell "not a KiCad board" from "we broke".
    ctx.postMessage({
      ok: false,
      message: err instanceof Error ? err.message : 'The board could not be built.',
      kind: err instanceof KicadReadError ? err.kind : 'error',
    });
  }
};
