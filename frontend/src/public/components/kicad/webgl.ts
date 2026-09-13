// One WebGL2 probe per document, released immediately: browsers cap live
// contexts (~16) and force-lose the oldest, which would blank a working
// schematic and read as a KiCanvas bug (spec §5.2, §9).
let probed: boolean | null = null;

/** Only the sliver of the context we touch: enough to release it again. */
type ProbeContext = { getExtension?: (name: string) => { loseContext: () => void } | null } | null;

export function webgl2Supported(create: () => HTMLCanvasElement = () => document.createElement('canvas')): boolean {
  if (probed != null) return probed;
  // `getContext` is specced to return null, but fingerprint-blocking browsers and
  // extensions have been seen to THROW. This runs in a render body, so an escaping
  // throw would take down the ErrorBoundary instead of showing the no-webgl card the
  // probe exists for — and with `probed` still null it would throw again every render.
  try {
    const gl = create().getContext('webgl2') as ProbeContext;
    probed = gl != null;
    // Releasing the probe context is the other call that has been seen to throw;
    // a throw here must not undo a true verdict.
    if (gl?.getExtension) gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    probed = probed ?? false;
  }
  return probed;
}

export function resetWebgl2ProbeForTests(): void {
  probed = null;
}
