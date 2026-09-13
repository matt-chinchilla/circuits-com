// One WebGL2 probe per document, released immediately: browsers cap live
// contexts (~16) and force-lose the oldest, which would blank a working
// schematic and read as a KiCanvas bug (spec §5.2, §9).
let probed: boolean | null = null;

export function webgl2Supported(create: () => HTMLCanvasElement = () => document.createElement('canvas')): boolean {
  if (probed != null) return probed;
  const gl = create().getContext('webgl2') as { getExtension?: (name: string) => { loseContext: () => void } | null } | null;
  probed = gl != null;
  if (gl?.getExtension) gl.getExtension('WEBGL_lose_context')?.loseContext();
  return probed;
}

export function resetWebgl2ProbeForTests(): void {
  probed = null;
}
