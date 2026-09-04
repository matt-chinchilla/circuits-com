// queryCache — a small module-level cache for admin GETs, so a page the
// operator has already seen renders from memory on the next visit instead of
// re-querying and replaying its loading state.
//
// Why not react-query: the console has ~10 cacheable reads and one rule
// (owner, 2026-09-03): "going back to the dashboard should not require a
// re-query every single time". Semantics here, in order:
//
//   1. FRESH hit (younger than maxAge) — served from memory, NO request.
//   2. STALE hit — served from memory immediately, refetched in the
//      background; the caller re-renders ONLY if the payload actually changed
//      (structural equality), so unchanged data never repaints or re-animates.
//   3. MISS — fetched; concurrent callers for the same key join one request.
//
// Every entry is dropped by `invalidateQueries()` — adminApi's response
// interceptor calls it after any mutating request, so an operator's own edit
// is never masked by a fresh hit. The cache lives in module scope: it dies on
// full reload and is never persisted (payloads are staff-only data).

import { useEffect, useRef, useState } from 'react';

interface Entry {
  data: unknown;
  at: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
// Bumped by every invalidation. A fetch that started before an invalidation
// must not store its (possibly pre-mutation) result afterwards.
let epoch = 0;

/** Default freshness window. Counts and trends, not live ops. */
export const DEFAULT_MAX_AGE = 5 * 60 * 1000;

export function peekQuery<T>(key: string): T | undefined {
  return entries.get(key)?.data as T | undefined;
}

export function isQueryFresh(key: string, maxAge = DEFAULT_MAX_AGE): boolean {
  const hit = entries.get(key);
  return hit !== undefined && Date.now() - hit.at < maxAge;
}

/**
 * Resolve `key` — from memory when fresh, otherwise via `fetcher` (deduped
 * across concurrent callers). Never throws on a cache path; a fetcher
 * rejection propagates to every joined caller and stores nothing.
 */
export function runQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  maxAge = DEFAULT_MAX_AGE,
): Promise<T> {
  if (isQueryFresh(key, maxAge)) return Promise.resolve(entries.get(key)!.data as T);
  const joined = inflight.get(key);
  if (joined) return joined as Promise<T>;
  const startedAt = epoch;
  const request = fetcher()
    .then((data) => {
      if (epoch === startedAt) entries.set(key, { data, at: Date.now() });
      return data;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** Drop every entry whose key starts with `prefix` ('' = everything). */
export function invalidateQueries(prefix = ''): void {
  epoch += 1;
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/** Test seam. */
export function _resetQueryCache(): void {
  entries.clear();
  inflight.clear();
  epoch = 0;
}

/**
 * Structural equality for JSON-shaped API payloads. Key order is irrelevant;
 * `undefined` and a missing key are the same. Used to decide whether a
 * background refresh changed anything worth re-rendering.
 */
export function payloadEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!payloadEqual(a[i], b[i])) return false;
    return true;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (!payloadEqual(ra[k], rb[k])) return false;
  return true;
}

export interface CachedQuery<T> {
  /** The payload — from memory on a revisit, so the first render is real. */
  data: T | undefined;
  /** True while there is no data at all (a genuine first load). */
  loading: boolean;
  /** True while a stale hit is being refreshed in the background. */
  refreshing: boolean;
  /** True when the CURRENT data was served from memory rather than fetched
   *  in this mount — charts use it to skip their entry animation. Flips to
   *  false the moment a refresh delivers a changed payload. */
  fromCache: boolean;
  /** The fetcher's rejection, if the LAST attempt for this key failed;
   *  `undefined` otherwise. Cleared by the next success or key change. */
  error: unknown;
}

export interface CachedQueryOptions {
  maxAge?: number;
  /** On a key change that MISSES the cache, keep showing the previous key's
   *  data until the new payload lands (a segment toggle should not blank the
   *  charts it is about to relabel). `loading` is still true meanwhile. */
  keepPrevious?: boolean;
}

interface State<T> {
  key: string | null;
  data: T | undefined;
  loading: boolean;
  refreshing: boolean;
  fromCache: boolean;
  error: unknown;
}

function initial<T>(key: string | null, placeholder?: T): State<T> {
  const hit = key === null ? undefined : peekQuery<T>(key);
  const data = hit ?? placeholder;
  return {
    key,
    data,
    loading: key !== null && hit === undefined,
    refreshing: false,
    fromCache: hit !== undefined,
    error: undefined,
  };
}

/**
 * The React face of the cache. `key === null` disables the query (nothing is
 * fetched, `data` is undefined). `fetcher` is read through a ref, so callers
 * may pass an inline arrow. A key change re-initialises synchronously from
 * whatever the cache holds for the new key.
 */
export function useCachedQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: CachedQueryOptions = {},
): CachedQuery<T> {
  const { maxAge = DEFAULT_MAX_AGE, keepPrevious = false } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [state, setState] = useState<State<T>>(() => initial<T>(key));

  // A key change (e.g. a range control) must not paint the previous key's
  // data for a frame unless asked to: re-derive the state during render, the
  // React-sanctioned way to reset state on a prop change.
  if (state.key !== key) setState(initial<T>(key, keepPrevious ? state.data : undefined));

  useEffect(() => {
    if (key === null) return undefined;
    if (isQueryFresh(key, maxAge) && peekQuery(key) !== undefined) return undefined;
    let cancelled = false;
    setState((prev) =>
      prev.key === key && prev.data !== undefined && !prev.loading
        ? { ...prev, refreshing: true }
        : prev,
    );
    runQuery(key, fetcherRef.current, maxAge)
      .then((next) => {
        if (cancelled) return;
        setState((prev) => {
          if (prev.key !== key) return prev;
          if (prev.data !== undefined && !prev.loading && payloadEqual(prev.data, next)) {
            return { ...prev, loading: false, refreshing: false, error: undefined };
          }
          return {
            key,
            data: next,
            loading: false,
            refreshing: false,
            fromCache: false,
            error: undefined,
          };
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((prev) =>
          prev.key === key ? { ...prev, loading: false, refreshing: false, error: err } : prev,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [key, maxAge]);

  return state;
}
