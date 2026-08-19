// Pure selection + phrasing logic for the Messages inbox multi-select.
//
// Kept out of the component (and out of the DOM) so the rules that actually
// matter — what "select all" means when a filter is active, how many rows a
// delete really touched, how the confirm names the damage — are unit-testable
// with no React and no browser.

import { designatorLabel } from '@admin/components/messages/messageHelpers';
import type { BulkDeleteResult } from '@admin/types/messages';

/** Body cap on POST /api/admin/messages/bulk-delete (server 422s past this). */
export const BULK_DELETE_MAX = 200;

/** Header-checkbox tri-state over the CURRENTLY VISIBLE rows. */
export type HeaderSelectionState = 'none' | 'some' | 'all';

/** Flip one row's membership. Always returns a new Set (React state must change). */
export function toggleSelected(
  selected: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * The ids a bulk action would actually touch: the selection INTERSECTED with
 * what the active filter/search is showing. Selecting rows, then filtering them
 * out of view, must never delete something the operator can no longer see.
 * Order follows the visible list so the confirm count matches the screen.
 */
export function visibleSelectedIds(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): string[] {
  return visibleIds.filter((id) => selected.has(id));
}

/**
 * Drop ids that are no longer visible (filter changed, rows deleted).
 * Returns the SAME Set instance when nothing changed, so a caller doing
 * `setSelected((prev) => pruneSelection(prev, ids))` inside an effect bails out
 * of the re-render instead of looping.
 */
export function pruneSelection(
  selected: Set<string>,
  visibleIds: readonly string[],
): Set<string> {
  const visible = new Set(visibleIds);
  const kept = [...selected].filter((id) => visible.has(id));
  if (kept.length === selected.size) return selected;
  return new Set(kept);
}

/** 'all' only when every visible row is selected AND there is at least one. */
export function headerSelectionState(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): HeaderSelectionState {
  if (visibleIds.length === 0) return 'none';
  const hits = visibleSelectedIds(selected, visibleIds).length;
  if (hits === 0) return 'none';
  return hits === visibleIds.length ? 'all' : 'some';
}

/**
 * Header-checkbox click: partial or empty selects every visible row, a full
 * one clears them. Rows hidden by the filter keep whatever state they had.
 */
export function toggleAllVisible(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): Set<string> {
  const next = new Set(selected);
  if (headerSelectionState(selected, visibleIds) === 'all') {
    for (const id of visibleIds) next.delete(id);
  } else {
    for (const id of visibleIds) next.add(id);
  }
  return next;
}

/** Split a delete into request-sized batches so a big selection can't 422. */
export function chunkIds(
  ids: readonly string[],
  size: number = BULK_DELETE_MAX,
): string[][] {
  const step = Math.max(1, Math.floor(size));
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += step) out.push(ids.slice(i, i + step));
  return out;
}

/** "3 selected" — the action bar's count. */
export function selectionLabel(count: number): string {
  return `${count} selected`;
}

/** aria-label for a row checkbox: "Select message MSG-0007". */
export function selectRowLabel(seq: number): string {
  return `Select message ${designatorLabel(seq)}`;
}

/**
 * Confirm copy. Names the count and says outright that it is irreversible —
 * this endpoint hard-deletes; there is no trash to recover from.
 */
export function confirmDeleteCopy(count: number): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  const noun = count === 1 ? 'message' : 'messages';
  return {
    title: `Delete ${count} ${noun}?`,
    message:
      `${count} ${noun} will be permanently removed from the inbox, ` +
      `along with the original enquiry. This cannot be undone.`,
    confirmLabel: count === 1 ? 'Delete message' : `Delete ${count} messages`,
  };
}

// Punctuation used by the sentences below, hoisted so every phrase separates
// the same way (and so a mangled glyph shows up in ONE place, not five).
const SEP = ' · ';
const DASH = '—';

/** The ONLY sentence that may tell the operator nothing happened. */
export const DELETE_NOTHING_REMOVED = `Could not delete. Nothing was removed ${DASH} try again.`;

/** Coerce a server body into a result even if a field is missing or junk. */
export function normalizeBulkResult(raw: unknown): BulkDeleteResult {
  const body = (raw ?? {}) as { deleted?: unknown; missing?: unknown };
  return { deleted: countOf(body.deleted), missing: countOf(body.missing) };
}

function countOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * What the operator is told afterwards. `missing` rows were already gone on the
 * server (someone else deleted them, or a stale list) — saying "Deleted 4" when
 * only 3 existed would be a lie, so the sentence reports both halves.
 */
export function deleteOutcomeMessage(result: BulkDeleteResult): string {
  const { deleted, missing } = normalizeBulkResult(result);
  const head =
    deleted === 0
      ? 'Nothing deleted'
      : `Deleted ${deleted} ${deleted === 1 ? 'message' : 'messages'}`;
  if (missing === 0) return head;
  const tail = missing === 1 ? '1 was already gone' : `${missing} were already gone`;
  return `${head}${SEP}${tail}`;
}

/** Drop specific ids from the selection — used after a delete so rows that went
 *  away stop counting, WITHOUT wiping a selection the operator still holds
 *  elsewhere (deleting one row from its own menu must not clear the other five). */
export function deselectIds(
  selected: Set<string>,
  ids: readonly string[],
): Set<string> {
  const gone = new Set(ids);
  const kept = [...selected].filter((id) => !gone.has(id));
  if (kept.length === selected.size) return selected;
  return new Set(kept);
}

/**
 * What the operator is told when a delete THREW.
 *
 * A batched delete can fail halfway: the first 200 ids are already gone — and
 * unrecoverable — when the next request dies. Reporting "Nothing was removed"
 * there would understate irreversible damage, so whatever DID happen is stated
 * first and the failure is appended. The nothing-happened sentence is reserved
 * for a tally that really is empty.
 */
export function deleteFailureMessage(
  result: BulkDeleteResult,
  reason?: string | null,
): string {
  const tally = normalizeBulkResult(result);
  const detail = reason?.trim() ? reason.trim() : null;
  if (tally.deleted + tally.missing === 0) {
    return detail ?? DELETE_NOTHING_REMOVED;
  }
  const head = `${deleteOutcomeMessage(tally)} ${DASH} the rest could not be deleted.`;
  return detail ? `${head} (${detail})` : head;
}
