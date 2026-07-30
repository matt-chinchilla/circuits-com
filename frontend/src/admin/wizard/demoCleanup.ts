import { adminApi } from '@admin/services/adminApi';
import { isDemoPartSku, isDemoSupplierName } from './demoMarkers';
import type { WizardCreatedEntity, WizardCreatedListing } from './types';

const KEYS = {
  supplier: 'wiz-demo-supplier',
  part: 'wiz-demo-part',
  listing: 'wiz-demo-listing',
} as const;

type EntityKind = keyof typeof KEYS;

// A tracked demo entity. Suppliers and parts are addressable by a single id;
// a distributor listing needs BOTH ids because the delete endpoint is nested
// (DELETE /parts/{partId}/listings/{listingId}).
export type DemoEntityRef =
  | { kind: 'supplier'; id: string }
  | { kind: 'part'; id: string }
  | { kind: 'listing'; partId: string; listingId: string };

type DemoListingRef = Extract<DemoEntityRef, { kind: 'listing' }>;

// ─── Create-detection gates ────────────────────────────────────────────────
// Two pure predicates that decide whether a route transition is ALLOWED to be
// read as "the user just created an entity". They live next to the tracker
// (rather than inside WizardApp) because they are the only thing standing
// between a route observation and a hard delete — and because being pure makes
// them unit-testable. See demoCleanup.test.ts.

// ⚠ DATA SAFETY. A browser Back/Forward is a POP, and a POP can REPLAY the
// exact '<x>/new' → '<x>/<id>' shape on an entity this session never created
// (history: [suppliers/new, suppliers/<realId>] — Back then Forward reproduces
// it verbatim). A genuine creation is always a forward PUSH, so a POP is
// categorically non-tracking, no matter what the route shape looks like. This
// is the architectural close on the whole class of Back-button mis-tracking.
export function isForwardNavigation(navType: string): boolean {
  return navType !== 'POP';
}

// Did this transition leave a '.../new' create form for the thing it creates?
// Deliberately FLOW-AGNOSTIC: it feeds `mutatedThisPass`, which vetoes Back
// re-entry into a create form after a pass has already committed a row. A
// per-flow version leaves that veto silently INERT for every tour the tracker
// has no branch for (the 'add-part-general' bug), so the user could rewind into
// the form and submit a SECOND untrackable demo row onto real data.
//
// Two recognized shapes:
//   suppliers/new           → suppliers/<id>   (sibling detail — top-level form)
//   parts/<id>/listings/new → parts/<id>       (parent detail — nested form)
// A cancel back to the LIST ('parts/new' → 'parts') is not one of them.
export function mayHaveCommittedCreate(prevRoute: string, nextRoute: string): boolean {
  if (!prevRoute.endsWith('/new')) return false;
  const base = prevRoute.slice(0, -'/new'.length);
  if (!base) return false;
  // Sibling: the form's own collection gained a member.
  if (nextRoute.startsWith(`${base}/`)) {
    const tail = nextRoute.slice(base.length + 1);
    return tail.length > 0 && tail !== 'new' && !tail.includes('/');
  }
  // Parent: a nested form returning to the entity it hangs off. Only a nested
  // base has a parent — 'parts'.lastIndexOf('/') is -1, so a top-level form
  // can't reach this branch and a hop to the dashboard stays un-flagged.
  const cut = base.lastIndexOf('/');
  return cut > 0 && nextRoute === base.slice(0, cut);
}

// Has THIS flow pass already committed a create? Two INDEPENDENT witnesses:
//   - `observed`: a forward create-transition was actually seen this pass
//     (mayHaveCommittedCreate → mutatedThisPass);
//   - a tracked demo id: something was recorded, whether or not the transition
//     was observed.
//
// The second witness is the point. The '/new' re-entry veto used to key on the
// observation alone, so a MISSED transition (browser Back during the attach
// form's post-submit navigation delay) DISARMED the veto — the user could rewind
// into the create form and submit a SECOND demo row, and the single-key tracker
// can only own one, orphaning the FIRST on real data. Now that the listing is
// tracked straight off the POST response, the veto sees it even when the
// transition was never observed.
//
// `kind` is the entity kind the active flow creates, or null for a tour that
// creates nothing addressable by a single id (the attach tour creates a
// LISTING, covered by the listing key).
export function hasCommittedCreate(
  observed: boolean,
  kind: 'supplier' | 'part' | null,
): boolean {
  if (observed) return true;
  if (kind != null && getTrackedDemoEntity(kind) != null) return true;
  return getTrackedDemoListing() != null;
}

// ─── Id-from-response bridge ───────────────────────────────────────────────
// AttachListingPage owns the POST response and publishes the created listing's
// id on `window.__wizardCreatedListing`; the wizard adopts it here. See the
// WizardCreatedListing doc-comment in types.ts for why this replaced route/DOM
// inference outright.

// Validated defensively — the value comes off `window` (any script, any tab,
// the dev console) and whatever it names is handed to a hard DELETE.
export function readCreatedListingBridge(): WizardCreatedListing | null {
  const raw: unknown = window.__wizardCreatedListing;
  if (typeof raw !== 'object' || raw === null) return null;
  const { partId, listingId, supplierId } = raw as {
    partId?: unknown;
    listingId?: unknown;
    supplierId?: unknown;
  };
  if (typeof partId !== 'string' || !partId) return null;
  if (typeof listingId !== 'string' || !listingId) return null;
  return {
    partId,
    listingId,
    supplierId: typeof supplierId === 'string' ? supplierId : '',
  };
}

export function clearCreatedListingBridge(): void {
  delete window.__wizardCreatedListing;
}

// The same bridge for the two ENTITY creates. The supplier/part forms publish
// the id straight off the POST response, so tracking no longer depends on the
// wizard OBSERVING the 'suppliers/new' → 'suppliers/<id>' transition — a
// browser Back during the form's 900ms post-submit toast delay used to eat that
// transition outright, leaving an untracked demo row (and a DEMO- part is
// visible on the PUBLIC catalog) that nothing would ever clean up.
//
// Validated the same way as the listing bridge: the value comes off `window`
// and whatever it names is handed to a cascading DELETE.
export function readCreatedEntityBridge(): WizardCreatedEntity | null {
  const raw: unknown = window.__wizardCreatedEntity;
  if (typeof raw !== 'object' || raw === null) return null;
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  if (kind !== 'supplier' && kind !== 'part') return null;
  if (typeof id !== 'string' || !id) return null;
  return { kind, id };
}

export function clearCreatedEntityBridge(): void {
  delete window.__wizardCreatedEntity;
}

// Each kind holds exactly ONE id, so tracking a second demo entity in the
// same flow pass would silently orphan the first (its key is overwritten and
// nothing ever cleans it up — a Back-then-resubmit leaves a synthetic row on
// real data forever). Displacing a tracked id therefore DELETES it — through
// the same marker guard as cleanup, so a displaced id that turns out not to be
// tour data is dropped rather than deleted.
//
// The delete is fired AFTER the key is repointed and is deliberately not
// awaited — awaiting inside a tracker would let a late resolve clear the key
// that now belongs to the NEW entity.
export function trackDemoEntity(kind: 'supplier' | 'part', id: string): void {
  const displaced = getTrackedDemoEntity(kind);
  localStorage.setItem(KEYS[kind], id);
  if (displaced != null && displaced !== id) {
    void deleteDemoEntityById(kind, displaced);
  }
}

// The 'listing' kind is the one cleanup that must NEVER cascade to its
// parent: the attach-a-part tour hangs a demo listing off a REAL catalog
// SKU, so cleanup deletes the listing and leaves the part alone.
//
// The displaced-id delete here is the reason the listing marker guard exists.
// Every attach submission publishes a bridge, so an admin who attaches a SECOND
// (real) distributor to the ARMED part mid-tour displaces the tracked id — and
// the displaced row used to be detached unconditionally. It now goes through
// readListingMarker like everything else, so only a listing still bearing the
// tour's own DEMO- order code is ever removed.
export function trackDemoListing(partId: string, listingId: string): void {
  const displaced = getTrackedDemoListing();
  const ref: DemoListingRef = { kind: 'listing', partId, listingId };
  localStorage.setItem(KEYS.listing, JSON.stringify(ref));
  if (displaced != null && displaced.listingId !== listingId) {
    void deleteDemoListingById(displaced.partId, displaced.listingId);
  }
}

// ─── The marker guard (PRIMARY DATA-SAFETY INVARIANT) ──────────────────────
// Does the row this id points at STILL look like tour data? Every delete below
// goes through here first, so the wizard cannot destroy a real supplier, part
// or distributor listing no matter how the id was recorded — a stale
// localStorage key, a Back-button replay of the create-transition shape, a
// hand-edited value, a UUID that got reassigned in a reseed. Tracking bugs
// degrade to "a demo row survives", never to data loss.
//
// The verdict is FOUR-valued, not a boolean, because two different callers need
// two different things out of it: the delete needs "may I touch this row?"
// (only `demo` says yes) and the tracking key needs "is this settled?" (only
// `unknown` says no — see DeleteOutcome).
//   - demo      → the row is still ours; delete it.
//   - not-demo  → PROVEN not ours. Hands off, and stop re-checking it.
//   - gone      → 404 / no longer present. Nothing left to delete.
//   - unknown   → 401, 5xx, network, timeout. We cannot PROVE anything, and
//                 unprovable means hands off — but also means "try again".
type MarkerVerdict = 'demo' | 'not-demo' | 'gone' | 'unknown';

// What actually happened to a row we tried to remove. Only `unknown` is
// UNSETTLED: the other three all mean the row is not sitting there waiting to
// be cleaned up, so the tracking key may be dropped. Dropping it on `unknown`
// (the pre-2026-07-29 behaviour, which swallowed every error and cleared
// regardless) orphans the row on a transient network blip or a 5xx — nothing
// ever retries it, and a DEMO- row is publicly visible.
type DeleteOutcome = MarkerVerdict | 'deleted';

function isSettled(outcome: DeleteOutcome): boolean {
  return outcome !== 'unknown';
}

// Status off an axios-shaped rejection. Deliberately duck-typed rather than
// `axios.isAxiosError`: the only thing the tracker needs to know is whether a
// failure was a DEFINITIVE 404 ("already gone", settled) or anything else
// ("couldn't tell", retry), and keeping that decision free of the HTTP client
// keeps this data-safety module unit-testable without one.
function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { status, response } = err as { status?: unknown; response?: unknown };
  if (status === 404) return true;
  if (typeof response !== 'object' || response === null) return false;
  return (response as { status?: unknown }).status === 404;
}

/** Verdict for a whole supplier / part row, re-fetched by id. */
async function readEntityMarker(kind: 'supplier' | 'part', id: string): Promise<MarkerVerdict> {
  try {
    if (kind === 'supplier') {
      const supplier = await adminApi.getSupplier(id);
      return isDemoSupplierName(supplier?.name) ? 'demo' : 'not-demo';
    }
    const part = await adminApi.getPart(id);
    return isDemoPartSku(part?.sku) ? 'demo' : 'not-demo';
  } catch (err) {
    return isNotFound(err) ? 'gone' : 'unknown';
  }
}

// Verdict for ONE distributor listing, read back off the part it hangs off
// (there is no GET for a single listing). This closes the last unguarded delete
// in the wizard: the attach tour borrows a REAL catalog SKU, and the tracked
// listing id is only ever as good as the bridge that published it — so before
// detaching anything we re-read the row and require the tour's own DEMO- marker
// on its `sku` (the tour autofills `listing_sku` with one; see flows.tsx).
//
// `isDemoPartSku` is the shared prefix predicate — a PartListing.sku carries
// the same DEMO- marker as a Part.sku, by design (see demoMarkers.ts).
// A listing with NO sku, or one the tour never marked, reads as `not-demo`:
// unprovable is hands-off, exactly as for entities.
async function readListingMarker(partId: string, listingId: string): Promise<MarkerVerdict> {
  try {
    const part = await adminApi.getPart(partId);
    const listing = (part?.listings ?? []).find((l) => l.id === listingId);
    // Not on the part any more — the user already detached it during the tour's
    // own cleanup step, or the part was reseeded. Settled, nothing to delete.
    if (listing == null) return 'gone';
    return isDemoPartSku(listing.sku) ? 'demo' : 'not-demo';
  } catch (err) {
    return isNotFound(err) ? 'gone' : 'unknown';
  }
}

// Best-effort delete of ONE demo row by id, without touching the tracking
// keys. Used by the trackers above when an id is displaced mid-pass, and by
// cleanupDemoEntity. Marker-gated: a non-demo (or unverifiable) row is never
// passed to deleteSupplier/deletePart at all.
async function deleteDemoEntityById(
  kind: 'supplier' | 'part',
  id: string,
): Promise<DeleteOutcome> {
  const verdict = await readEntityMarker(kind, id);
  if (verdict !== 'demo') return verdict;
  try {
    if (kind === 'supplier') await adminApi.deleteSupplier(id);
    else await adminApi.deletePart(id);
    return 'deleted';
  } catch (err) {
    // 404 = someone got there first (settled). 401 / 5xx / offline = we don't
    // know whether the row is still there, so the key must survive to retry.
    return isNotFound(err) ? 'gone' : 'unknown';
  }
}

// The listing twin. Marker-gated the same way, and it NEVER touches the part
// the listing hangs off — that is real catalog data the tour merely borrowed.
async function deleteDemoListingById(partId: string, listingId: string): Promise<DeleteOutcome> {
  const verdict = await readListingMarker(partId, listingId);
  if (verdict !== 'demo') return verdict;
  try {
    await adminApi.deletePartListing(partId, listingId);
    return 'deleted';
  } catch (err) {
    return isNotFound(err) ? 'gone' : 'unknown';
  }
}

export function clearDemoEntity(kind: EntityKind): void {
  localStorage.removeItem(KEYS[kind]);
}

export function getTrackedDemoEntity(kind: 'supplier' | 'part'): string | null {
  return localStorage.getItem(KEYS[kind]);
}

// The listing key holds a JSON ref, not a bare id — parse defensively so a
// hand-edited / half-written value can't throw during flow startup.
export function getTrackedDemoListing(): DemoListingRef | null {
  const raw = localStorage.getItem(KEYS.listing);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { kind, partId, listingId } = parsed as {
      kind?: unknown;
      partId?: unknown;
      listingId?: unknown;
    };
    if (kind !== 'listing') return null;
    if (typeof partId !== 'string' || !partId) return null;
    if (typeof listingId !== 'string' || !listingId) return null;
    return { kind: 'listing', partId, listingId };
  } catch {
    return null;
  }
}

// Every cleanup goes through the SAME two marker-gated deletes the trackers
// use, so there is exactly one code path that can issue a DELETE per kind.
//
// The tracking key is dropped only on a SETTLED outcome (deleted / already gone
// / proven not ours). An `unknown` failure — 401, 5xx, offline, timeout — keeps
// it, so the next flow start sweeps the row again instead of orphaning it.
export async function cleanupDemoEntity(kind: EntityKind): Promise<void> {
  if (kind === 'listing') {
    const ref = getTrackedDemoListing();
    if (!ref) return;
    // Listing only — the part it hangs off is real catalog data the tour merely
    // borrowed. Deleting the part here would be data loss.
    if (isSettled(await deleteDemoListingById(ref.partId, ref.listingId))) {
      clearDemoEntity('listing');
    }
    return;
  }
  const id = getTrackedDemoEntity(kind);
  if (!id) return;
  if (isSettled(await deleteDemoEntityById(kind, id))) clearDemoEntity(kind);
}

export async function cleanupAllDemoEntities(): Promise<void> {
  await Promise.allSettled([
    cleanupDemoEntity('supplier'),
    cleanupDemoEntity('part'),
    cleanupDemoEntity('listing'),
  ]);
}
