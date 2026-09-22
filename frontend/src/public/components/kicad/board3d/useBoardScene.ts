// The worker plumbing and the per-project scene cache (spec 2026-09-21 §3.3, §7).
//
// Three promises the hook keeps:
//  1. A board is built ONCE per (project identity, quality). The second visit to
//     the 3D tab pays nothing — the same discipline useBomWorkbench uses for its
//     match snapshot.
//  2. The build never runs on the main thread when a worker is available, and
//     always runs when one is not: a browser without module workers still sees
//     the board, a frame later.
//  3. Nothing is left running. Leaving the tab terminates a worker mid-build and
//     forgets the half-built promise, so the next visit starts clean instead of
//     awaiting a message that can never arrive.
import { useEffect, useRef, useState } from 'react';
import { buildScene, type BuildInput, type BuildReply } from '@public/services/kicad/board3d/buildScene';
import type { BoardScene, Quality } from '@public/services/kicad/board3d/types';
import type { BoardStackup, KicadProject } from '@public/services/kicad/types';

export type SceneStatus = 'idle' | 'building' | 'ready' | 'error';
export interface SceneState { status: SceneStatus; scene: BoardScene | null; error: string | null }

const IDLE: SceneState = { status: 'idle', scene: null, error: null };
const BUILDING: SceneState = { status: 'building', scene: null, error: null };

/** Keyed on project IDENTITY, so a re-parse (a new project object) rebuilds and a
 *  tab change does not. Weak, so closing a design releases its scenes. */
const cache = new WeakMap<KicadProject, Map<Quality, Promise<BoardScene>>>();

/** Vite compiles this literal into its own module chunk. `Worker` is absent in
 *  node and can throw behind a strict CSP, and both mean "build here instead". */
function defaultSpawn(): Worker | null {
  try {
    return new Worker(new URL('../../../services/kicad/board3d/worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/**
 * The longest a worker build may run before it is stopped and the reader told
 * why. The face budget bounds what buildScene does with holes (a 50,000-via
 * board builds in ~4 s in node), so this is the backstop for whatever else a
 * hostile or simply enormous file can make it do — an honest "too large" is
 * better than a spinner that never ends.
 */
export const BUILD_TIMEOUT_MS = 45_000;
export const TOO_LARGE = 'This board is too large to build in 3D in the browser. The Board tab still draws it.';

const messageOf = (err: unknown): string =>
  err instanceof Error && err.message !== '' ? err.message : 'The board could not be built.';

/**
 * One build. With a worker: post the input and settle on its reply. Without one:
 * a `setTimeout(0)` slice, so the caller still gets its `building` paint before
 * the main thread goes away for a second.
 */
function runBuild(input: BuildInput, spawn: () => Worker | null, took: (w: Worker) => void): Promise<BoardScene> {
  const worker = spawn();
  if (worker == null) {
    return new Promise<BoardScene>((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(buildScene(input));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(messageOf(err)));
        }
      }, 0);
    });
  }
  took(worker);
  // The handlers are wired BEFORE postMessage: a worker that answers
  // synchronously (a fake in a test, a browser that inlines a tiny module) must
  // not reply into a null handler.
  const settled = new Promise<BoardScene>((resolve, reject) => {
    const watchdog = setTimeout(() => {
      worker.terminate();
      reject(new Error(TOO_LARGE));
    }, BUILD_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<BuildReply>) => {
      clearTimeout(watchdog);
      const reply = event.data;
      if (reply != null && reply.ok) resolve(reply.scene);
      else reject(new Error(reply == null ? messageOf(null) : reply.message));
    };
    worker.onerror = () => {
      clearTimeout(watchdog);
      reject(new Error('The board builder stopped unexpectedly.'));
    };
  });
  worker.postMessage(input);
  return settled;
}

export function useBoardScene(
  project: KicadProject | null,
  stackup: BoardStackup | null,
  quality: Quality,
  deps?: { spawn?: () => Worker | null },
): SceneState & { retry: () => void } {
  const text = project?.board == null ? null : project.files.get(project.board) ?? null;
  const [state, setState] = useState<SceneState>(text == null ? IDLE : BUILDING);
  const [attempt, setAttempt] = useState(0);
  // A caller writing `{ spawn }` inline would hand the effect a new object every
  // render; the ref is what keeps the seam current without remounting the build.
  const spawnRef = useRef(deps?.spawn);
  spawnRef.current = deps?.spawn;
  // "Try again" must bypass the cache ONCE. A plain `attempt > 0` test would keep
  // bypassing it for the rest of the component's life.
  const bypass = useRef(false);

  useEffect(() => {
    if (project == null || text == null) {
      setState((prev) => (prev.status === 'idle' ? prev : IDLE));
      return;
    }
    // Returning `prev` unchanged lets React bail out of the re-render the initial
    // state already paid for.
    setState((prev) => (prev.status === 'building' ? prev : BUILDING));

    const skipCache = bypass.current;
    bypass.current = false;
    const byQuality = cache.get(project) ?? new Map<Quality, Promise<BoardScene>>();
    cache.set(project, byQuality);

    let cancelled = false;
    let worker: Worker | null = null;
    let settled = true;
    let promise = skipCache ? undefined : byQuality.get(quality);
    if (promise == null) {
      settled = false;
      const fresh = runBuild({ text, stackup, quality }, spawnRef.current ?? defaultSpawn, (w) => {
        worker = w;
      });
      promise = fresh;
      byQuality.set(quality, fresh);
      const forget = () => {
        settled = true;
        if (byQuality.get(quality) === fresh) byQuality.delete(quality);
      };
      // A failed build is never cached: "Try again" would otherwise re-serve the
      // same rejection without re-running anything.
      fresh.then(() => {
        settled = true;
      }, forget);
    }
    promise.then(
      (scene) => {
        if (!cancelled) setState({ status: 'ready', scene, error: null });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: 'error', scene: null, error: messageOf(err) });
      },
    );

    return () => {
      cancelled = true;
      // Terminating mid-build leaves a promise that can never settle, so the
      // cache entry goes with it.
      if (!settled) {
        const pending = byQuality.get(quality);
        if (pending === promise) byQuality.delete(quality);
      }
      worker?.terminate();
    };
  }, [project, text, stackup, quality, attempt]);

  return {
    ...state,
    retry: () => {
      bypass.current = true;
      setAttempt((n) => n + 1);
    },
  };
}
