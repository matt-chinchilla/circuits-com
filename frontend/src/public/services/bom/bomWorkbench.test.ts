import { describe, expect, it } from 'vitest';
import type { BomRow, ResolveEvent, TableRow } from './types';
import {
  applyResolveEvent,
  buildRows,
  foldSimilarPick,
  pickMisses,
  RESOLVE_CAP,
  settleStragglers,
} from './useBomWorkbench';

const server = (over: Partial<BomRow>): BomRow =>
  ({
    index: 0,
    status: 'none',
    part: null,
    offers: [],
    similar: [],
    approx_reason: null,
    package_warning: null,
    recommended_supplier_id: null,
    resolve_query: null,
    ...over,
  }) as BomRow;

const line = (index: number, over: Partial<TableRow> = {}): TableRow => ({
  index,
  mpn: null,
  value: '1k',
  footprint: null,
  description: null,
  manufacturer: null,
  distributorPn: null,
  qty: 1,
  refs: [`R${index}`],
  dnp: false,
  server: null,
  state: 'matched',
  viewerHref: null,
  ...over,
});

describe('buildRows', () => {
  it('joins server answers by index, marks unanswered lines not_found, and stamps the viewer route', () => {
    const rows = buildRows([line(0), line(1)], [server({ index: 1, status: 'exact' })], '/viewer');
    expect(rows.map((r) => [r.state, r.server?.status ?? null, r.viewerHref])).toEqual([
      ['not_found', null, '/viewer'],
      ['matched', 'exact', '/viewer'],
    ]);
  });
});

describe('applyResolveEvent', () => {
  const rows = [line(0, { state: 'resolving' }), line(1, { state: 'resolving' })];
  const ev = (over: Partial<ResolveEvent>): ResolveEvent => ({
    kind: 'resolved',
    index: 0,
    detail: null,
    row: null,
    ...over,
  });
  it('lands a resolved row as resolved_live, and a rowless resolved back on matched', () => {
    expect(
      applyResolveEvent(rows, ev({ row: server({ index: 0, status: 'exact_live' }) }))[0],
    ).toMatchObject({ state: 'resolved_live', server: { status: 'exact_live' } });
    expect(applyResolveEvent(rows, ev({}))[0]?.state).toBe('matched');
  });
  it('maps not_found and resolve_unavailable, touching only the named index', () => {
    const out = applyResolveEvent(rows, ev({ kind: 'not_found', index: 1 }));
    expect(out.map((r) => r.state)).toEqual(['resolving', 'not_found']);
    expect(applyResolveEvent(rows, ev({ kind: 'resolve_unavailable', index: 0 }))[0]?.state).toBe(
      'unavailable',
    );
  });
});

describe('settleStragglers', () => {
  it('returns every still-resolving row to matched', () => {
    expect(
      settleStragglers([line(0, { state: 'resolving' }), line(1, { state: 'not_found' })]).map(
        (r) => r.state,
      ),
    ).toEqual(['matched', 'not_found']);
  });
});

describe('pickMisses', () => {
  const miss = (index: number, over: Partial<TableRow> = {}) =>
    line(index, {
      server: server({ index, status: 'resolve', resolve_query: `q${index}` }),
      ...over,
    });
  it('takes resolve rows with a query, MPN-first, skips DNP unless included, caps at RESOLVE_CAP', () => {
    const rows = [
      miss(0),
      miss(1, { mpn: 'ABC' }),
      miss(2, { dnp: true }),
      line(3),
      miss(4, { server: server({ index: 4, status: 'resolve', resolve_query: '' }) }),
    ];
    expect(pickMisses(rows, false).misses.map((m) => m.index)).toEqual([1, 0]);
    expect(pickMisses(rows, true).misses.map((m) => m.index)).toEqual([1, 0, 2]);
    const many = Array.from({ length: RESOLVE_CAP + 5 }, (_, i) => miss(i));
    const capped = pickMisses(many, false);
    // `dropped` alone is computed from the input length, so it stays right even
    // if the slice is wrong. The SLICE is what the server 422s on (one over and
    // it rejects the whole stream), so assert its length directly.
    expect(capped.misses).toHaveLength(RESOLVE_CAP);
    expect(capped).toMatchObject({ dropped: 5 });
  });

  it('drops the guesses at the cap, never the MPN-identified certainties', () => {
    // More lines than the cap, with the MPN'd ones LAST in file order: the
    // ordering claim is that they still all survive and the value-only
    // queries are what gets left behind.
    const valueOnly = Array.from({ length: RESOLVE_CAP }, (_, i) => miss(i));
    const withMpn = Array.from({ length: 4 }, (_, i) =>
      miss(RESOLVE_CAP + i, { mpn: `MPN${i}` }),
    );
    const { misses, dropped } = pickMisses([...valueOnly, ...withMpn], false);
    expect(misses).toHaveLength(RESOLVE_CAP);
    expect(dropped).toBe(4);
    expect(misses.slice(0, 4).map((m) => m.mpn)).toEqual(['MPN0', 'MPN1', 'MPN2', 'MPN3']);
    expect(misses.every((m) => m.index !== RESOLVE_CAP - 1)).toBe(true); // a guess fell off
  });
});

describe('foldSimilarPick', () => {
  it('swaps in the fresh match as approx and folds the displaced part into the menu', () => {
    const displaced = {
      id: 'p1',
      sku: 'OLD',
      manufacturer_name: 'M',
      description: null,
      package: null,
      lifecycle_status: null,
      lifecycle_verified: false,
    };
    const rows = [
      line(0, {
        server: server({
          index: 0,
          status: 'exact',
          part: displaced as BomRow['part'],
          similar: [{ ...displaced, id: 'p2', sku: 'NEW' }],
        }),
      }),
    ];
    const out = foldSimilarPick(
      rows,
      0,
      'NEW',
      server({
        index: 0,
        status: 'exact',
        part: { ...displaced, id: 'p2', sku: 'NEW' } as BomRow['part'],
      }),
    );
    expect(out[0]?.server).toMatchObject({
      status: 'approx',
      approx_reason: 'your pick — similar part',
    });
    expect(out[0]?.server?.similar.map((s) => s.sku)).toEqual(['OLD']);
  });
  it('returns the SAME array when the fresh match has no part', () => {
    // Reference identity is the behaviour, not an implementation detail: it is
    // what lets `setRows((prev) => foldSimilarPick(...))` bail out of the
    // re-render, matching the old code's `if (fresh.part == null) return;`
    // early exit. `toEqual` would pass for a freshly mapped copy too.
    const rows = [line(0), line(1)];
    expect(foldSimilarPick(rows, 0, 'X', server({ index: 0, part: null }))).toBe(rows);
  });
});
