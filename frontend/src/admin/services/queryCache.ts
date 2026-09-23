// queryCache — the admin console's read cache: memory first, the browser's
// storage underneath it, and a change check before any refetch.
//
// Why not react-query: the console has ~15 cacheable reads and two owner
// rules. 2026-09-03: "going back to the dashboard should not require a
// re-query every single time". 2026-09-11: "a check that gets ran to see if
// the data has changed since last being viewed" — the module-only cache died
// on every full page load (a bookmark, a refresh, a new tab), and every visit
// after that paid the dashboard's aggregations again to be shown the same
// numbers. Semantics, in order:
//
//   1. FRESH hit (younger than maxAge) — served from memory, NO request.
//   2. STALE hit — served immediately (from memory, or from localStorage on
//      a fresh document), then RE-VALIDATED: one tiny GET /api/data-versions
//      says whether any table behind the entry's `scopes` was written since
//      the payload was fetched. Unchanged → the entry is fresh again and no
//      query runs. Changed (or no scopes declared) → refetched in the
//      background; the caller re-renders ONLY if the payload actually
//      changed (structural equality), so unchanged data never repaints.
//   3. MISS — fetched; concurrent callers for the same key join one request.
//
// Persistence is per PERSON: entries live under a namespace keyed by the
// JWT's subject, so a shared browser never shows one account another's
// numbers, and `clearPersistedQueries()` (sign-out) wipes every namespace.
// Every entry is dropped by `invalidateQueries()` — adminApi's response
// interceptor calls it after any mutating request, so an operator's own edit
// is never masked by a fresh hit, whatever the server's counters say.

import { useEffect, useRef, useState } from 'react';
import { tokenClaims } from '@admin/services/sessionToken';

/** The families of tables a cached read can depend on. Mirrors `SCOPES` in
 *  api/app/services/data_versions.py — test_data_versions.py holds the two
 *  together. A read that declares none is refetched whenever it is stale. */
export type DataScope =
  | 'catalog'
  | 'traffic'
  | 'money'
  | 'sponsors'
  | 'activity'
  | 'people'
  | 'messages'
  | 'leads'
  | 'badges'
  | 'sales';

export type ScopeVersions = Partial<Record<DataScope, string>>;

interface Entry {
  data: unknown;
  at: number;
  /** The scope versions the payload was fetched under (see `versionFor`);
   *  absent when the read declared no scopes or the probe was unavailable. */
  version?: string;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
// Bumped by every invalidation. A fetch that started before an invalidation
// must not store its (possibly pre-mutation) result afterwards.
let epoch = 0;

/** Default freshness window. Counts and trends, not live ops. */
export const DEFAULT_MAX_AGE = 5 * 60 * 1000;

// ── Persistence ────────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'admin.qc.v1.';
/** Entries above this (the supplier list with its base64 logos) stay in
 *  memory only — localStorage is a ~5 MB budget shared with everything. */
export const MAX_PERSIST_BYTES = 512_000;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function namespace(): string | null {
  const sub = tokenClaims()?.sub;
  return sub ? `${STORAGE_PREFIX}${sub}.` : null;
}

// The memory cache is NOT namespaced, so it must belong to one person at a
// time: the moment the token's subject changes (sign-out then sign-in as
// someone else in the same tab) everything in memory is theirs, not ours.
let memoryOwner: string | null = null;

function ensureOwner(): string | null {
  const ns = namespace();
  if (ns !== memoryOwner) {
    entries.clear();
    memoryOwner = ns;
  }
  return ns;
}

function readPersisted(ns: string, key: string): Entry | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(ns + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<Entry> | null;
    if (!parsed || typeof parsed.at !== 'number' || !('data' in parsed)) return undefined;
    return {
      data: parsed.data,
      at: parsed.at,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
    };
  } catch {
    return undefined;
  }
}

function writePersisted(ns: string, key: string, entry: Entry): void {
  const store = storage();
  if (!store) return;
  try {
    const raw = JSON.stringify(entry);
    if (raw.length > MAX_PERSIST_BYTES) {
      store.removeItem(ns + key);
      return;
    }
    store.setItem(ns + key, raw);
  } catch {
    // Quota, or a store that throws (private window): persistence is a
    // convenience and memory still holds the entry. Start over so the next
    // write has room.
    clearPersistedQueries();
  }
}

function persistedKeys(startsWith: string): string[] {
  const store = storage();
  if (!store) return [];
  const found: string[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k && k.startsWith(startsWith)) found.push(k);
    }
  } catch {
    return [];
  }
  return found;
}

/** Forget every persisted entry, for every person, and the memory with it.
 *  Sign-out calls this so a shared browser keeps nothing of the session. */
export function clearPersistedQueries(): void {
  const store = storage();
  if (store) {
    for (const k of persistedKeys(STORAGE_PREFIX)) {
      try {
        store.removeItem(k);
      } catch {
        /* nothing left to do */
      }
    }
  }
  invalidateQueries();
}

function lookup(key: string): Entry | undefined {
  const ns = ensureOwner();
  const hit = entries.get(key);
  if (hit) return hit;
  if (!ns) return undefined;
  const persisted = readPersisted(ns, key);
  if (persisted) entries.set(key, persisted);
  return persisted;
}

function store(key: string, entry: Entry): void {
  const ns = ensureOwner();
  entries.set(key, entry);
  if (ns) writePersisted(ns, key, entry);
}

// ── The change check ───────────────────────────────────────────────────────

type VersionSource = () => Promise<ScopeVersions>;
let versionSource: VersionSource | null = null;
/** One probe per page mount, not one per hook: hooks that go stale together
 *  (the dashboard's three) share the answer for this long. */
export const VERSIONS_MAX_AGE = 10_000;
let versionsCache: { at: number; scopes: ScopeVersions } | null = null;
let versionsInflight: Promise<ScopeVersions | null> | null = null;

/** Installed by adminApi (the cache cannot import the client that imports
 *  it). `null` disables the check — every stale entry is then refetched. */
export function setVersionSource(source: VersionSource | null): void {
  versionSource = source;
  versionsCache = null;
  versionsInflight = null;
}

function currentVersions(): Promise<ScopeVersions | null> {
  if (!versionSource) return Promise.resolve(null);
  if (versionsCache && Date.now() - versionsCache.at < VERSIONS_MAX_AGE) {
    return Promise.resolve(versionsCache.scopes);
  }
  if (!versionsInflight) {
    const startedAt = epoch;
    const request: Promise<ScopeVersions | null> = versionSource()
      .then((scopes) => {
        if (epoch === startedAt) versionsCache = { at: Date.now(), scopes };
        return scopes;
      })
      .catch(() => null)
      .finally(() => {
        if (versionsInflight === request) versionsInflight = null;
      });
    versionsInflight = request;
  }
  return versionsInflight;
}

/** The composite version of a read over `scopes`, or undefined when the
 *  server did not report one of them — unknown must read as "changed", never
 *  as a match that would pin a stale payload forever. */
export function versionFor(
  scopes: readonly DataScope[],
  versions: ScopeVersions,
): string | undefined {
  const parts: string[] = [];
  for (const scope of scopes) {
    const v = versions[scope];
    if (typeof v !== 'string' || v === '') return undefined;
    parts.push(`${scope}=${v}`);
  }
  return parts.join(',');
}

// ── Reads ──────────────────────────────────────────────────────────────────

export interface RunQueryOptions {
  maxAge?: number;
  /** The table families the payload aggregates. With them, a stale entry is
   *  re-validated by the change check before any refetch. */
  scopes?: readonly DataScope[];
}

function normalise(options: number | RunQueryOptions | undefined): Required<
  Pick<RunQueryOptions, 'maxAge'>
> &
  Pick<RunQueryOptions, 'scopes'> {
  if (typeof options === 'number') return { maxAge: options };
  return { maxAge: options?.maxAge ?? DEFAULT_MAX_AGE, scopes: options?.scopes };
}

export function peekQuery<T>(key: string): T | undefined {
  return lookup(key)?.data as T | undefined;
}

export function isQueryFresh(key: string, maxAge = DEFAULT_MAX_AGE): boolean {
  const hit = lookup(key);
  return hit !== undefined && Date.now() - hit.at < maxAge;
}

async function revalidate<T>(
  key: string,
  fetcher: () => Promise<T>,
  scopes: readonly DataScope[] | undefined,
  stale: Entry | undefined,
  startedAt: number,
): Promise<T> {
  let version: string | undefined;
  if (scopes && scopes.length > 0) {
    // Asked BEFORE the fetch, deliberately: a write that lands between the
    // probe and the fetch is in the payload but not in the stored version,
    // so the next visit refetches once more — the harmless direction. The
    // other order could pin a pre-write payload under a post-write version.
    const versions = await currentVersions();
    version = versions ? versionFor(scopes, versions) : undefined;
    if (stale !== undefined && version !== undefined && stale.version === version) {
      if (epoch === startedAt) store(key, { ...stale, at: Date.now() });
      return stale.data as T;
    }
  }
  const data = await fetcher();
  if (epoch === startedAt) store(key, { data, at: Date.now(), version });
  return data;
}

/**
 * Resolve `key` — from memory when fresh, otherwise re-validated or fetched
 * via `fetcher` (deduped across concurrent callers). Never throws on a cache
 * path; a fetcher rejection propagates to every joined caller and stores
 * nothing. `options` may be a bare maxAge for the older call sites.
 */
export function runQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: number | RunQueryOptions,
): Promise<T> {
  const { maxAge, scopes } = normalise(options);
  if (isQueryFresh(key, maxAge)) return Promise.resolve(lookup(key)!.data as T);
  const joined = inflight.get(key);
  if (joined) return joined as Promise<T>;
  const startedAt = epoch;
  const request = revalidate(key, fetcher, scopes, lookup(key), startedAt).finally(() => {
    if (inflight.get(key) === request) inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}

/** Drop every entry whose key starts with `prefix` ('' = everything) — from
 *  memory AND storage — and forget the last change-check answer. */
export function invalidateQueries(prefix = ''): void {
  epoch += 1;
  versionsCache = null;
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
  const ns = namespace();
  const store = storage();
  if (ns && store) {
    for (const k of persistedKeys(ns + prefix)) {
      try {
        store.removeItem(k);
      } catch {
        /* the memory copy is already gone */
      }
    }
  }
}

/** Test seam: memory and probe state only, never storage. */
export function _resetQueryCache(): void {
  entries.clear();
  inflight.clear();
  epoch = 0;
  memoryOwner = null;
  versionsCache = null;
  versionsInflight = null;
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

// ── The React face ─────────────────────────────────────────────────────────

export interface CachedQuery<T> {
  /** The payload — from memory or storage on a revisit, so the first render
   *  is real. */
  data: T | undefined;
  /** True while there is no data at all (a genuine first load). */
  loading: boolean;
  /** True while a stale hit is being re-validated or refreshed. */
  refreshing: boolean;
  /** True when the CURRENT data was served from the cache rather than fetched
   *  in this mount — charts use it to skip their entry animation. Flips to
   *  false the moment a refresh delivers a changed payload. */
  fromCache: boolean;
  /** The fetcher's rejection, if the LAST attempt for this key failed;
   *  `undefined` otherwise. Cleared by the next success or key change. */
  error: unknown;
}

export interface CachedQueryOptions extends RunQueryOptions {
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
 * fetched, `data` is undefined). `fetcher` and `scopes` are read through
 * refs, so callers may pass inline arrows and array literals. A key change
 * re-initialises synchronously from whatever the cache holds for the new key.
 */
export function useCachedQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: CachedQueryOptions = {},
): CachedQuery<T> {
  const { maxAge = DEFAULT_MAX_AGE, keepPrevious = false, scopes } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;
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
    runQuery(key, fetcherRef.current, { maxAge, scopes: scopesRef.current })
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
