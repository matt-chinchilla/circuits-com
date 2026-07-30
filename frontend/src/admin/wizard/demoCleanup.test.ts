// @vitest-environment happy-dom
//
// Data-safety guard for the wizard's demo-entity tracker.
//
// Each kind holds ONE id in localStorage. Before 2026-07-29 a second track in
// the same flow pass silently overwrote the first, so a Back-then-resubmit
// left a synthetic demo row (a $1.25 listing on a REAL catalog SKU, a duplicate
// demo supplier) that nothing would ever clean up. The tracker now deletes the
// displaced id as it repoints the key.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteSupplier = vi.fn(() => Promise.resolve());
const deletePart = vi.fn(() => Promise.resolve());
const deletePartListing = vi.fn(() => Promise.resolve());
// The marker guard re-FETCHES before every delete, so both readers have to
// exist. Default responses carry the demo markers (the happy path); individual
// tests override them to model a real row, a 404, or a network failure.
//
// getPart doubles as the LISTING reader: there is no GET for a single listing,
// so the listing marker is read off its part's `listings` array.
const DEMO_LISTINGS = [
  { id: 'listing-1', sku: 'DEMO-LST-A1B2' },
  { id: 'listing-2', sku: 'DEMO-LST-C3D4' },
  { id: 'real-listing', sku: 'AVN-LM7805CT' },
  { id: 'unmarked-listing', sku: null },
];
const getSupplier = vi.fn((id: string) =>
  Promise.resolve({ id, name: 'Demo Components Inc.' }),
);
const getPart = vi.fn((id: string) =>
  Promise.resolve({ id, sku: 'DEMO-100', listings: DEMO_LISTINGS }),
);

/** An axios-shaped rejection — what the tracker classifies as SETTLED. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

vi.mock('@admin/services/adminApi', () => ({
  adminApi: {
    getSupplier: (id: string) => getSupplier(id),
    getPart: (id: string) => getPart(id),
    deleteSupplier: (id: string) => deleteSupplier(id),
    deletePart: (id: string) => deletePart(id),
    deletePartListing: (partId: string, listingId: string) =>
      deletePartListing(partId, listingId),
  },
}));

const {
  cleanupDemoEntity,
  clearCreatedEntityBridge,
  clearCreatedListingBridge,
  clearDemoEntity,
  getTrackedDemoEntity,
  getTrackedDemoListing,
  hasCommittedCreate,
  isForwardNavigation,
  mayHaveCommittedCreate,
  readCreatedEntityBridge,
  readCreatedListingBridge,
  trackDemoEntity,
  trackDemoListing,
} = await import('./demoCleanup');

beforeEach(() => {
  localStorage.clear();
  delete window.__wizardCreatedListing;
  delete window.__wizardCreatedEntity;
  deleteSupplier.mockClear();
  deletePart.mockClear();
  deletePartListing.mockClear();
  getSupplier.mockClear();
  getPart.mockClear();
  // Per-test overrides model a real row / 404 / offline; reset so they can't
  // leak into the next test (they used to be undone by hand at each call site).
  resetApiMocks();
});

/** Let the tracker's un-awaited marker fetch + delete settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Restore the module-default (marker-bearing) API responses. */
function resetApiMocks(): void {
  getSupplier.mockImplementation((id: string) =>
    Promise.resolve({ id, name: 'Demo Components Inc.' }),
  );
  getPart.mockImplementation((id: string) =>
    Promise.resolve({ id, sku: 'DEMO-100', listings: DEMO_LISTINGS }),
  );
}

describe('trackDemoEntity', () => {
  it('records the id and deletes nothing on a first track', async () => {
    trackDemoEntity('supplier', 'sup-1');
    expect(getTrackedDemoEntity('supplier')).toBe('sup-1');
    await settle();
    expect(deleteSupplier).not.toHaveBeenCalled();
  });

  it('deletes the displaced id when a second entity is tracked in one pass', async () => {
    trackDemoEntity('part', 'part-1');
    trackDemoEntity('part', 'part-2');
    // The key must point at the NEW id — the old one is gone for good, so
    // leaving it tracked would make cleanup delete the wrong row.
    expect(getTrackedDemoEntity('part')).toBe('part-2');
    await settle();
    expect(deletePart).toHaveBeenCalledTimes(1);
    expect(deletePart).toHaveBeenCalledWith('part-1');
  });

  it('does not delete when the same id is re-tracked', async () => {
    trackDemoEntity('supplier', 'sup-1');
    trackDemoEntity('supplier', 'sup-1');
    await settle();
    expect(deleteSupplier).not.toHaveBeenCalled();
    expect(getTrackedDemoEntity('supplier')).toBe('sup-1');
  });

  it('keeps kinds independent', async () => {
    trackDemoEntity('supplier', 'sup-1');
    trackDemoEntity('part', 'part-1');
    await settle();
    expect(deleteSupplier).not.toHaveBeenCalled();
    expect(deletePart).not.toHaveBeenCalled();
    clearDemoEntity('supplier');
    expect(getTrackedDemoEntity('supplier')).toBeNull();
    expect(getTrackedDemoEntity('part')).toBe('part-1');
  });

  it('will not delete a DISPLACED id that no longer bears the demo marker', async () => {
    // Same guard as cleanup: the displaced-id delete is a cascading delete too.
    getPart.mockImplementationOnce((id: string) =>
      Promise.resolve({ id, sku: 'LM7805CT' }),
    );
    trackDemoEntity('part', 'real-part');
    trackDemoEntity('part', 'part-2');
    await settle();
    expect(deletePart).not.toHaveBeenCalled();
    expect(getTrackedDemoEntity('part')).toBe('part-2');
  });
});

// ── The marker guard: THE data-safety invariant ────────────────────────────
// Cleanup deletes by id, and an id is only ever as trustworthy as the
// bookkeeping that recorded it. So before every cascading delete the row is
// re-fetched and must still look like tour data. A mis-tracked id can then cost
// at most an un-cleaned demo row — never a customer's supplier or part.

describe('cleanupDemoEntity marker guard', () => {
  it('deletes a supplier that still bears the demo name', async () => {
    trackDemoEntity('supplier', 'sup-1');
    await cleanupDemoEntity('supplier');
    expect(deleteSupplier).toHaveBeenCalledWith('sup-1');
    expect(getTrackedDemoEntity('supplier')).toBeNull();
  });

  it('deletes a part that still bears the DEMO- SKU prefix', async () => {
    trackDemoEntity('part', 'part-1');
    await cleanupDemoEntity('part');
    expect(deletePart).toHaveBeenCalledWith('part-1');
    expect(getTrackedDemoEntity('part')).toBeNull();
  });

  it('tolerates a user-typed "Demo …" name', async () => {
    getSupplier.mockImplementation((id: string) =>
      Promise.resolve({ id, name: 'Demo Widgets LLC' }),
    );
    trackDemoEntity('supplier', 'sup-1');
    await cleanupDemoEntity('supplier');
    expect(deleteSupplier).toHaveBeenCalledWith('sup-1');
  });

  it('REFUSES to delete a mis-tracked real supplier, and stops retrying it', async () => {
    getSupplier.mockImplementation((id: string) => Promise.resolve({ id, name: 'Mouser' }));
    trackDemoEntity('supplier', 'real-supplier');
    await cleanupDemoEntity('supplier');
    expect(deleteSupplier).not.toHaveBeenCalled();
    // Key cleared: a row PROVEN not to be ours must not be re-attempted on
    // every later flow start.
    expect(getTrackedDemoEntity('supplier')).toBeNull();
  });

  it('REFUSES to delete a mis-tracked real part', async () => {
    getPart.mockImplementation((id: string) => Promise.resolve({ id, sku: 'LM7805CT' }));
    trackDemoEntity('part', 'real-part');
    await cleanupDemoEntity('part');
    expect(deletePart).not.toHaveBeenCalled();
    expect(getTrackedDemoEntity('part')).toBeNull();
  });

  it('never deletes on a 404 fetch, and drops the key — the row is already gone', async () => {
    getPart.mockImplementation(() => Promise.reject(httpError(404)));
    trackDemoEntity('part', 'gone-part');
    await cleanupDemoEntity('part');
    expect(deletePart).not.toHaveBeenCalled();
    expect(getTrackedDemoEntity('part')).toBeNull();
  });
});

// ── Settled vs UNKNOWN outcomes ───────────────────────────────────────────
// The guard never deletes what it can't prove — but "can't prove" is not the
// same as "done with". Cleanup used to swallow every error and clear the key
// regardless, so one 5xx / offline moment ORPHANED the row: nothing retried it,
// and a DEMO- part is visible on the PUBLIC catalog the whole time. The key now
// survives an unknown failure and dies only on a settled one.

describe('cleanup keeps the tracking key on an UNKNOWN failure', () => {
  it('keeps it when the marker fetch fails for a non-404 reason', async () => {
    getPart.mockImplementation(() => Promise.reject(new Error('Network Error')));
    trackDemoEntity('part', 'part-1');
    await cleanupDemoEntity('part');
    expect(deletePart).not.toHaveBeenCalled();
    expect(getTrackedDemoEntity('part')).toBe('part-1');

    // …and the next flow start retries it, which is the whole point.
    resetApiMocks();
    await cleanupDemoEntity('part');
    expect(deletePart).toHaveBeenCalledWith('part-1');
    expect(getTrackedDemoEntity('part')).toBeNull();
  });

  it('keeps it when the marker proves demo but the DELETE 5xxs', async () => {
    deleteSupplier.mockImplementationOnce(() => Promise.reject(httpError(500)));
    trackDemoEntity('supplier', 'sup-1');
    await cleanupDemoEntity('supplier');
    expect(deleteSupplier).toHaveBeenCalledWith('sup-1');
    expect(getTrackedDemoEntity('supplier')).toBe('sup-1');
  });

  it('drops it when the DELETE 404s — someone got there first', async () => {
    deleteSupplier.mockImplementationOnce(() => Promise.reject(httpError(404)));
    trackDemoEntity('supplier', 'sup-1');
    await cleanupDemoEntity('supplier');
    expect(getTrackedDemoEntity('supplier')).toBeNull();
  });

  it('keeps a LISTING key when its part fetch fails for a non-404 reason', async () => {
    getPart.mockImplementation(() => Promise.reject(new Error('Network Error')));
    trackDemoListing('part-9', 'listing-1');
    await settle();
    await cleanupDemoEntity('listing');
    expect(deletePartListing).not.toHaveBeenCalled();
    expect(getTrackedDemoListing()?.listingId).toBe('listing-1');
  });
});

// ── The LISTING marker guard ──────────────────────────────────────────────
// The last unguarded delete in the wizard until 2026-07-29. The attach tour
// hangs its demo listing off a REAL catalog part, and EVERY attach submission
// (tour or ordinary admin work) publishes the same id bridge — so a tracked
// listing id is not on its own proof of ownership. The tour therefore stamps a
// DEMO- order code into `listing_sku`, and every delete re-reads the row off its
// part and requires that marker.

describe('deleteDemoListing marker guard', () => {
  it('detaches a tracked listing that still bears the DEMO- sku', async () => {
    trackDemoListing('part-9', 'listing-1');
    await cleanupDemoEntity('listing');
    expect(deletePartListing).toHaveBeenCalledWith('part-9', 'listing-1');
    // NEVER the part it hangs off — that's real catalog data the tour borrowed.
    expect(deletePart).not.toHaveBeenCalled();
    expect(getTrackedDemoListing()).toBeNull();
  });

  it('REFUSES to detach a REAL distributor listing, and stops retrying it', async () => {
    // The failure this closes: a mis-adopted bridge (real admin work on the
    // armed part mid-tour) pointing the tracker at a customer's listing.
    trackDemoListing('part-9', 'real-listing');
    await cleanupDemoEntity('listing');
    expect(deletePartListing).not.toHaveBeenCalled();
    expect(getTrackedDemoListing()).toBeNull();
  });

  it('REFUSES to detach a listing with no sku at all', async () => {
    // Unprovable is hands-off: an attach submitted with the order-code field
    // left blank carries no marker, so it stays attached (fail-closed).
    trackDemoListing('part-9', 'unmarked-listing');
    await cleanupDemoEntity('listing');
    expect(deletePartListing).not.toHaveBeenCalled();
    expect(getTrackedDemoListing()).toBeNull();
  });

  it('skips a listing that is no longer on the part, and drops the key', async () => {
    // The user already removed it during the tour's own detach step.
    trackDemoListing('part-9', 'listing-gone');
    await cleanupDemoEntity('listing');
    expect(deletePartListing).not.toHaveBeenCalled();
    expect(getTrackedDemoListing()).toBeNull();
  });

  it('marker-gates the DISPLACED listing too, never its part', async () => {
    // trackDemoListing repoints the single key and deletes what it displaced.
    // A second attach on the armed part could be REAL work, so the displaced
    // id goes through the same guard.
    trackDemoListing('part-9', 'real-listing');
    trackDemoListing('part-9', 'listing-2');
    await settle();
    expect(deletePartListing).not.toHaveBeenCalled();
    expect(deletePart).not.toHaveBeenCalled();
    expect(getTrackedDemoListing()?.listingId).toBe('listing-2');
  });

  it('never fetches or deletes anything when nothing is tracked', async () => {
    await cleanupDemoEntity('supplier');
    await cleanupDemoEntity('part');
    await cleanupDemoEntity('listing');
    expect(getSupplier).not.toHaveBeenCalled();
    expect(getPart).not.toHaveBeenCalled();
    expect(deleteSupplier).not.toHaveBeenCalled();
    expect(deletePart).not.toHaveBeenCalled();
    expect(deletePartListing).not.toHaveBeenCalled();
  });
});

describe('trackDemoListing', () => {
  it('round-trips the nested ref', () => {
    trackDemoListing('part-9', 'listing-1');
    expect(getTrackedDemoListing()).toEqual({
      kind: 'listing',
      partId: 'part-9',
      listingId: 'listing-1',
    });
    expect(deletePartListing).not.toHaveBeenCalled();
  });

  it('detaches the displaced listing, never its part', async () => {
    trackDemoListing('part-9', 'listing-1');
    trackDemoListing('part-9', 'listing-2');
    // The key repoints SYNCHRONOUSLY; the displaced row's marker check and
    // delete are un-awaited (awaiting inside a tracker would let a late resolve
    // clear the key that now belongs to the NEW listing).
    expect(getTrackedDemoListing()?.listingId).toBe('listing-2');
    await settle();
    expect(deletePartListing).toHaveBeenCalledTimes(1);
    expect(deletePartListing).toHaveBeenCalledWith('part-9', 'listing-1');
    // The borrowed catalog part is never ours to delete.
    expect(deletePart).not.toHaveBeenCalled();
  });

  it('ignores a malformed stored ref instead of throwing', () => {
    localStorage.setItem('wiz-demo-listing', '{not json');
    expect(getTrackedDemoListing()).toBeNull();
    trackDemoListing('part-9', 'listing-1');
    expect(getTrackedDemoListing()?.listingId).toBe('listing-1');
    expect(deletePartListing).not.toHaveBeenCalled();
  });
});

// ── Create-detection gates ────────────────────────────────────────────────
// The two predicates standing between a route observation and a hard delete.

describe('isForwardNavigation', () => {
  it('refuses a POP — the browser Back button can never look like a creation', () => {
    // History [suppliers/new, suppliers/<realId>] replays the exact
    // create-transition shape on Back-then-Forward. Both legs are POPs, so the
    // detector never even inspects the route.
    expect(isForwardNavigation('POP')).toBe(false);
  });

  it('accepts the forward navigations a real create produces', () => {
    expect(isForwardNavigation('PUSH')).toBe(true);
    expect(isForwardNavigation('REPLACE')).toBe(true);
  });
});

describe('mayHaveCommittedCreate', () => {
  it('recognizes a top-level create form landing on its new detail page', () => {
    expect(mayHaveCommittedCreate('suppliers/new', 'suppliers/sup-1')).toBe(true);
    expect(mayHaveCommittedCreate('parts/new', 'part-x')).toBe(false);
    expect(mayHaveCommittedCreate('parts/new', 'parts/part-1')).toBe(true);
  });

  it('is flow-AGNOSTIC — an entity the tracker has no branch for still counts', () => {
    // This is the whole point: a per-flow flag left the '/new'-re-entry veto
    // silently inert for tours the tracker doesn't branch on, so Back could
    // re-enter the form and stack a second untrackable row onto real data.
    expect(mayHaveCommittedCreate('sponsors/new', 'sponsors/spo-1')).toBe(true);
    expect(mayHaveCommittedCreate('anything/new', 'anything/id-1')).toBe(true);
  });

  it('recognizes a nested form returning to the entity it hangs off', () => {
    expect(mayHaveCommittedCreate('parts/p-1/listings/new', 'parts/p-1')).toBe(true);
    // A different part is not the parent of that form.
    expect(mayHaveCommittedCreate('parts/p-1/listings/new', 'parts/p-2')).toBe(false);
  });

  it('ignores a cancel back to the list and everything that is not a create form', () => {
    expect(mayHaveCommittedCreate('suppliers/new', 'suppliers')).toBe(false);
    expect(mayHaveCommittedCreate('parts/new', 'parts')).toBe(false);
    // A top-level form has no parent route, so a hop to the dashboard ('') must
    // not be read as a commit.
    expect(mayHaveCommittedCreate('parts/new', '')).toBe(false);
    expect(mayHaveCommittedCreate('parts/new', 'parts/new')).toBe(false);
    expect(mayHaveCommittedCreate('parts/new', 'parts/part-1/edit')).toBe(false);
    expect(mayHaveCommittedCreate('parts/part-1', 'parts/part-2')).toBe(false);
    expect(mayHaveCommittedCreate('new', 'part-1')).toBe(false);
    expect(mayHaveCommittedCreate('', 'parts/part-1')).toBe(false);
  });
});

// ── Id-from-response bridge ───────────────────────────────────────────────
// AttachListingPage publishes the created listing's id straight off the POST
// response. This replaced a set-difference inference that ran off the
// submit-navigation, so a browser Back during the form's post-submit toast
// delay MISSED the create entirely — leaving a synthetic $X listing on a REAL
// catalog SKU that nothing ever cleaned up.

describe('readCreatedListingBridge', () => {
  it('captures the ids the attach form published', () => {
    window.__wizardCreatedListing = {
      partId: 'part-9',
      listingId: 'listing-1',
      supplierId: 'sup-3',
    };
    expect(readCreatedListingBridge()).toEqual({
      partId: 'part-9',
      listingId: 'listing-1',
      supplierId: 'sup-3',
    });
  });

  it('reads null when nothing was published — the fail-closed default', () => {
    // No bridge ⇒ track NOTHING. There is deliberately no fallback to "the
    // newest listing on the part": that guess is what put real rows at risk.
    expect(readCreatedListingBridge()).toBeNull();
  });

  it('is one-shot — clearing it makes the next read null', () => {
    window.__wizardCreatedListing = {
      partId: 'part-9',
      listingId: 'listing-1',
      supplierId: 'sup-3',
    };
    clearCreatedListingBridge();
    expect(readCreatedListingBridge()).toBeNull();
  });

  it('rejects anything that is not a pair of non-empty id strings', () => {
    // The value comes off `window`, and whatever it names is handed to a hard
    // DELETE — so a half-written or hostile object must read as "nothing".
    const bad: unknown[] = [
      null,
      42,
      'listing-1',
      {},
      { partId: 'part-9' },
      { listingId: 'listing-1' },
      { partId: 'part-9', listingId: '' },
      { partId: '', listingId: 'listing-1' },
      { partId: 'part-9', listingId: 7 },
    ];
    for (const value of bad) {
      window.__wizardCreatedListing = value as typeof window.__wizardCreatedListing;
      expect(readCreatedListingBridge()).toBeNull();
    }
  });

  it('tolerates a missing supplierId — the DELETE keys on partId + listingId', () => {
    window.__wizardCreatedListing = { partId: 'part-9', listingId: 'listing-1' } as
      typeof window.__wizardCreatedListing;
    expect(readCreatedListingBridge()).toEqual({
      partId: 'part-9',
      listingId: 'listing-1',
      supplierId: '',
    });
  });
});

// ── Entity id bridge (supplier / part creates) ─────────────────────────────
// Same contract, for the two entity forms. Route inference was the ONLY signal
// before, and it misses the create whenever the transition isn't observed (a
// browser Back during the form's 900ms post-submit toast delay) — leaving an
// untracked demo supplier, or a DEMO- part on the PUBLIC catalog.

describe('readCreatedEntityBridge', () => {
  it('captures what the supplier / part form published', () => {
    window.__wizardCreatedEntity = { kind: 'supplier', id: 'sup-1' };
    expect(readCreatedEntityBridge()).toEqual({ kind: 'supplier', id: 'sup-1' });
    window.__wizardCreatedEntity = { kind: 'part', id: 'part-1' };
    expect(readCreatedEntityBridge()).toEqual({ kind: 'part', id: 'part-1' });
  });

  it('reads null when nothing was published — the fail-closed default', () => {
    expect(readCreatedEntityBridge()).toBeNull();
  });

  it('is one-shot — clearing it makes the next read null', () => {
    window.__wizardCreatedEntity = { kind: 'part', id: 'part-1' };
    clearCreatedEntityBridge();
    expect(readCreatedEntityBridge()).toBeNull();
  });

  it('rejects anything that is not a known kind plus a non-empty id string', () => {
    // Comes off `window`, and whatever it names is handed to a CASCADING
    // delete — so a half-written or hostile object must read as "nothing".
    const bad: unknown[] = [
      null,
      42,
      'sup-1',
      {},
      { kind: 'supplier' },
      { id: 'sup-1' },
      { kind: 'sponsor', id: 'spo-1' },
      { kind: 'supplier', id: '' },
      { kind: 'part', id: 7 },
    ];
    for (const value of bad) {
      window.__wizardCreatedEntity = value as typeof window.__wizardCreatedEntity;
      expect(readCreatedEntityBridge()).toBeNull();
    }
  });
});

// ── The '/new' re-entry veto ───────────────────────────────────────────────

describe('hasCommittedCreate', () => {
  it('honours an observed forward transition on its own', () => {
    expect(hasCommittedCreate(true, null)).toBe(true);
    expect(hasCommittedCreate(true, 'part')).toBe(true);
  });

  it('is false when this pass has neither observed nor recorded a create', () => {
    expect(hasCommittedCreate(false, null)).toBe(false);
    expect(hasCommittedCreate(false, 'supplier')).toBe(false);
    expect(hasCommittedCreate(false, 'part')).toBe(false);
  });

  it('sees a tracked demo entity even when the transition was MISSED', () => {
    // The whole point: mutatedThisPass is only ever set from an observed
    // transition, so keying the veto on it alone let a missed one disarm the
    // veto — Back-then-resubmit then orphaned the FIRST row.
    trackDemoEntity('supplier', 'sup-1');
    expect(hasCommittedCreate(false, 'supplier')).toBe(true);
    expect(hasCommittedCreate(false, 'part')).toBe(false);
  });

  it('sees a tracked demo LISTING for any flow, kind or no kind', () => {
    // Captured from the POST response, so it exists the instant the row does —
    // this is what re-arms the veto for the attach tour after a Back that ate
    // the create transition.
    const bridge = { partId: 'part-9', listingId: 'listing-1', supplierId: 'sup-3' };
    window.__wizardCreatedListing = bridge;
    const created = readCreatedListingBridge();
    expect(created).not.toBeNull();
    clearCreatedListingBridge();
    trackDemoListing(created!.partId, created!.listingId);

    expect(getTrackedDemoListing()?.listingId).toBe('listing-1');
    // `observed` false AND no entity kind — the veto still fires.
    expect(hasCommittedCreate(false, null)).toBe(true);
  });
});

// ── Bridge-drain ORDERING at every pass-termination site ───────────────────
// cleanupAllDemoEntities sweeps the TRACKING KEYS, so an id still sitting
// unread on a bridge — a POST that resolved inside the last 200ms poll
// interval, or during the form's post-submit toast delay — is invisible to it.
// Sweep-then-discard therefore ORPHANS that row: a synthetic listing left on a
// REAL catalog SKU, or a DEMO- part left on the PUBLIC catalog, with no key for
// any later pass to find. startFlow always drained first; exitFlow and advance's
// completion branch did not (fixed 2026-07-29).
//
// Source-level because the ordering is a property of three sibling callbacks in
// a React component, and this harness is unit-logic only (no renderer). The
// assertion is deliberately brittle: a refactor that moves these calls has to
// come back here and re-state why the new order is safe.

describe('WizardApp drains the id bridges BEFORE sweeping (source guard)', () => {
  // fileURLToPath on the STRING import.meta.url, not `new URL(...)`: this file
  // runs under happy-dom, whose URL class is not the one node:fs accepts.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'WizardApp.tsx'),
    'utf-8',
  );

  /** Body text of a `const <name> = useCallback(() => { … }` declaration. */
  function callbackBody(name: string): string {
    const start = src.indexOf(`const ${name} = useCallback(`);
    expect(start, `${name} must be a useCallback in WizardApp.tsx`).toBeGreaterThan(-1);
    // Generously sized (these bodies carry long data-safety comments) and safe
    // to overshoot: indexOf finds THIS callback's own calls first, and the
    // callbacks in between contain neither.
    return src.slice(start, start + 2500);
  }

  for (const name of ['startFlow', 'exitFlow', 'advance']) {
    it(`${name} calls retirePassBridges() before cleanupAllDemoEntities()`, () => {
      const body = callbackBody(name);
      const drain = body.indexOf('retirePassBridges()');
      const sweep = body.indexOf('cleanupAllDemoEntities()');
      expect(drain, `${name} must call retirePassBridges()`).toBeGreaterThan(-1);
      expect(sweep, `${name} must call cleanupAllDemoEntities()`).toBeGreaterThan(-1);
      expect(
        drain,
        `${name} sweeps before draining — a create still on the bridge would be orphaned`,
      ).toBeLessThan(sweep);
    });
  }
});
