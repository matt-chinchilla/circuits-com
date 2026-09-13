// @vitest-environment happy-dom
// The async wiring the reducer tests cannot reach: how many times a BOM is
// matched, and what happens to an answer that lands after the workbench it was
// issued for has gone. Those paths are the ones with teeth — a surviving
// stream writes live prices onto row INDICES of a table that no longer exists,
// and a match landing after a clear used to repopulate it and spend resolve
// quota on a BOM the reader threw away.
//
// No JSX (vitest only discovers *.test.ts here) and no testing-library —
// createRoot + act, the harness DesignCanvas.test.ts established.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParseResult } from './parseBom';
import type { BomRow, MissIn, ResolveEvent } from './types';
import { useBomWorkbench, type BomWorkbench } from './useBomWorkbench';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── the stubbed API ────────────────────────────────────────────────────────
// `bomApi` is a plain exported const, so the module mock is enough — no
// network, no dependency added.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface StreamCall {
  misses: MissIn[];
  onEvent: (e: ResolveEvent) => void;
  signal: AbortSignal;
  done: Deferred<void>;
}

const calls: { match: Deferred<BomRow[]>[]; stream: StreamCall[] } = { match: [], stream: [] };

vi.mock('./bomApi', () => ({
  bomApi: {
    match: () => {
      const d = deferred<BomRow[]>();
      calls.match.push(d);
      return d.promise;
    },
    streamResolve: (misses: MissIn[], onEvent: (e: ResolveEvent) => void, signal: AbortSignal) => {
      const done = deferred<void>();
      calls.stream.push({ misses, onEvent, signal, done });
      return done.promise;
    },
  },
}));

// ─── fixtures ───────────────────────────────────────────────────────────────

/** A parse of `n` lines. A NEW object every call — identity is the contract. */
function parse(n = 2): ParseResult {
  return {
    lines: Array.from({ length: n }, (_, i) => ({
      index: i,
      mpn: `MPN${i}`,
      value: null,
      footprint: null,
      description: null,
      manufacturer: null,
      distributorPn: null,
      qty: 1,
      refs: [`R${i}`],
      dnp: false,
    })),
    headers: ['Ref', 'MPN'],
    headerSignature: 'ref|mpn',
    roleByColumn: ['refs', 'mpn'],
    unmappedColumns: [],
    warnings: [],
    error: null,
  };
}

/** A server answer. `resolve` is the status that makes phase 2 ask about it. */
const answer = (index: number, status: BomRow['status'] = 'exact'): BomRow => ({
  index,
  status,
  approx_reason: null,
  package_warning: null,
  resolve_query: status === 'resolve' ? `q${index}` : null,
  part: null,
  recommended_supplier_id: null,
  offers: [],
  similar: [],
});

// ─── harness ────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;
/** The latest render's workbench — the hook's whole surface, per commit. */
let wb: BomWorkbench;

function Probe({ parsed, viewerHref }: { parsed: ParseResult | null; viewerHref: string | null }) {
  wb = useBomWorkbench(parsed, viewerHref);
  return null as ReactNode;
}

async function render(parsed: ParseResult | null, viewerHref: string | null = null) {
  await act(async () => {
    root.render(createElement(Probe, { parsed, viewerHref }));
  });
}

/** Let a resolved promise's `.then` run. */
const flush = () => act(async () => {});

beforeEach(() => {
  calls.match = [];
  calls.stream = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

// ─── tests ──────────────────────────────────────────────────────────────────

describe('useBomWorkbench — phase 1 runs once per parse identity', () => {
  it('matches once, and a re-render with the SAME object does not match again', async () => {
    const parsed = parse();
    await render(parsed);
    expect(calls.match).toHaveLength(1);
    expect(wb.matching).toBe(true);

    await render(parsed); // same identity
    expect(calls.match).toHaveLength(1);

    await act(async () => calls.match[0].resolve([answer(0), answer(1)]));
    expect(wb.matching).toBe(false);
    expect(wb.rows.map((r) => r.state)).toEqual(['matched', 'matched']);
    // Every line was answered `exact`, so nothing is a miss and no stream opens.
    expect(calls.stream).toHaveLength(0);
  });

  it('matches again for a NEW parse object', async () => {
    await render(parse());
    await render(parse());
    expect(calls.match).toHaveLength(2);
  });
});

describe('useBomWorkbench — viewerHref', () => {
  it('re-stamps the rows already on screen without a second match or a stream abort', async () => {
    const parsed = parse();
    await render(parsed, null);
    await act(async () => calls.match[0].resolve([answer(0, 'resolve'), answer(1, 'resolve')]));
    expect(calls.stream).toHaveLength(1);
    expect(wb.rows.map((r) => r.viewerHref)).toEqual([null, null]);

    // The 3.4 shape: a viewer route appears mid-session, long after pricing.
    await render(parsed, '/viewer?doc=x');

    expect(wb.rows.map((r) => r.viewerHref)).toEqual(['/viewer?doc=x', '/viewer?doc=x']);
    expect(calls.match).toHaveLength(1); // NOT re-matched
    expect(calls.stream).toHaveLength(1); // NOT re-streamed
    expect(calls.stream[0].signal.aborted).toBe(false); // stream still live
    expect(wb.matching).toBe(false); // table never went back to "Pricing…"
  });

  it('keeps the row array identity when the href has not changed', async () => {
    const parsed = parse();
    await render(parsed, '/viewer');
    await act(async () => calls.match[0].resolve([answer(0), answer(1)]));
    const before = wb.rows;
    await render(parsed, '/viewer');
    expect(wb.rows).toBe(before);
  });
});

describe('useBomWorkbench — a stale answer never lands', () => {
  it('discards the in-flight match of a superseded parse: no rows, no stream', async () => {
    await render(parse());
    const stale = calls.match[0];

    await render(parse()); // BOM B; A's match is still on the wire
    expect(calls.match).toHaveLength(2);

    await act(async () => stale.resolve([answer(0, 'resolve'), answer(1, 'resolve')]));
    expect(wb.rows).toEqual([]); // A's answer did not repopulate B's table
    expect(calls.stream).toHaveLength(0); // and did not spend resolve quota
    expect(wb.matching).toBe(true); // still waiting on B

    await act(async () => calls.match[1].resolve([answer(0), answer(1)]));
    expect(wb.rows).toHaveLength(2);
  });

  it('aborts the previous BOM stream and never lets its events touch the next one', async () => {
    await render(parse());
    await act(async () => calls.match[0].resolve([answer(0, 'resolve'), answer(1, 'resolve')]));
    const stream = calls.stream[0];
    expect(wb.rows.map((r) => r.state)).toEqual(['resolving', 'resolving']);

    // BOM B arrives and prices cleanly. It must be POPULATED before the stale
    // event fires, or there is nothing for a missing guard to corrupt and this
    // test passes for the wrong reason.
    await render(parse());
    expect(stream.signal.aborted).toBe(true);
    await act(async () => calls.match[1].resolve([answer(0), answer(1)]));
    expect(wb.rows.map((r) => r.state)).toEqual(['matched', 'matched']);
    expect(calls.stream).toHaveLength(1); // B had no misses; no second stream

    // A's buffered event names row index 0 — an index that now belongs to B.
    await act(async () => {
      stream.onEvent({ kind: 'resolved', index: 0, detail: null, row: answer(0, 'exact_live') });
    });
    expect(wb.rows.map((r) => r.state)).toEqual(['matched', 'matched']);
    expect(wb.rows[0]?.server?.status).toBe('exact'); // not A's live answer

    // And A dying must not raise a banner over B's perfectly healthy table.
    await act(async () => stream.done.reject(new Error('stream died')));
    expect(wb.resolveError).toBeNull();
  });
});

describe('useBomWorkbench — reset()', () => {
  it('abandons an in-flight match: the table stays empty and no stream opens', async () => {
    const parsed = parse();
    await render(parsed);
    expect(calls.match).toHaveLength(1);

    await act(async () => wb.reset());
    // `parsed` deliberately UNCHANGED — the /viewer "Clear" shape, where the
    // effect does not re-run and used to leave `cancelled` false.
    await act(async () => calls.match[0].resolve([answer(0, 'resolve'), answer(1, 'resolve')]));
    await flush();

    expect(wb.rows).toEqual([]);
    expect(calls.stream).toHaveLength(0);
    expect(wb.matching).toBe(false);
  });

  it('clears the settings and drops a live stream', async () => {
    const parsed = parse();
    await render(parsed);
    await act(async () => calls.match[0].resolve([answer(0, 'resolve'), answer(1, 'resolve')]));
    await act(async () => {
      wb.setBuildQty(25);
      wb.setIncludeDnp(true);
    });
    expect(wb.buildQty).toBe(25);

    await act(async () => wb.reset());
    expect(calls.stream[0].signal.aborted).toBe(true);
    expect(wb.rows).toEqual([]);
    expect(wb.buildQty).toBe(1);
    expect(wb.includeDnp).toBe(false);
  });
});

describe('useBomWorkbench — pickSimilar', () => {
  /** Price a BOM whose rows are all `exact`, so no stream is in the way. */
  async function priced() {
    await render(parse());
    await act(async () => calls.match[0].resolve([answer(0), answer(1)]));
  }

  const picked = (sku: string): BomRow => ({ ...answer(0), part: { sku } as BomRow['part'] });

  it('applies the pick', async () => {
    await priced();
    await act(async () => wb.pickSimilar(0, 'NEW'));
    await act(async () => calls.match[1].resolve([picked('NEW')]));
    expect(wb.rows[0]?.server).toMatchObject({ status: 'approx' });
  });

  it('drops a pick that lands after the BOM was replaced', async () => {
    await priced();
    await act(async () => wb.pickSimilar(0, 'FROM-BOM-A'));
    const stale = calls.match[1];

    await render(parse()); // BOM B
    await act(async () => calls.match[2].resolve([answer(0), answer(1)]));

    await act(async () => stale.resolve([picked('FROM-BOM-A')]));
    // Without the generation guard this writes A's chosen part onto B's row 0
    // and labels it "your pick — similar part".
    expect(wb.rows[0]?.server?.status).toBe('exact');
  });

  it('drops a pick that lands after reset(), even on a fresh pick of the same row', async () => {
    await priced();
    await act(async () => wb.pickSimilar(0, 'OLD'));
    const stale = calls.match[1];
    await act(async () => wb.reset());

    // reset() clears the per-row sequence, so this fresh pick restarts at 1 —
    // the same number the stale one holds. Only the generation separates them.
    await render(parse());
    await act(async () => calls.match[2].resolve([answer(0), answer(1)]));
    await act(async () => wb.pickSimilar(0, 'NEW'));
    await act(async () => stale.resolve([picked('OLD')]));

    expect(wb.rows[0]?.server?.status).toBe('exact');
  });

  it('lets the last click win when two picks on one row overlap', async () => {
    await priced();
    await act(async () => wb.pickSimilar(0, 'FIRST'));
    await act(async () => wb.pickSimilar(0, 'SECOND'));
    const [, first, second] = calls.match;

    // Settle them out of click order: the older answer arrives last.
    await act(async () => second.resolve([picked('SECOND')]));
    await act(async () => first.resolve([picked('FIRST')]));

    expect(wb.rows[0]?.server?.part?.sku).toBe('SECOND');
  });
});

describe('useBomWorkbench — handed null', () => {
  it('clears the priced result but keeps the reader settings', async () => {
    const parsed = parse();
    await render(parsed);
    await act(async () => calls.match[0].resolve([answer(0, 'resolve'), answer(1, 'resolve')]));
    await act(async () => wb.setBuildQty(10));
    expect(wb.rows).toHaveLength(2);

    await render(null);

    expect(wb.rows).toEqual([]);
    expect(wb.resolveNote).toBeNull();
    expect(wb.resolveError).toBeNull();
    expect(wb.matching).toBe(false);
    expect(calls.stream[0].signal.aborted).toBe(true);
    // A quantity somebody typed is not the null-arming consumer's to discard.
    expect(wb.buildQty).toBe(10);
  });

  it('never matches, and re-renders without churning the empty row array', async () => {
    await render(null);
    const before = wb.rows;
    await render(null);
    expect(calls.match).toHaveLength(0);
    expect(wb.rows).toBe(before);
  });
});
