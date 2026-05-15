import type { Message, MessageStatus, AssignedTo } from '@admin/types/messages';
import { adminApi } from '@admin/services/adminApi';

// API-backed store for the admin Messages UI. The pre-Phase-4 implementation
// was localStorage-backed with a 15-row seed; Phase 4 moved persistence to the
// backend (`/api/admin/messages/...`).
//
// Pattern: module-level CACHE keeps SYNC read APIs that consumer pages relied
// on (loadMessages / unreadCount / findMessage / recentUnread). Consumer pages
// call refreshMessages() in a useEffect on mount to pull fresh state from the
// API; mutations apply optimistically to the local cache and fire-and-forget
// the matching PATCH so the UI stays snappy.

let CACHE: Message[] = [];
let CACHE_LOADED = false;

/**
 * Pull fresh messages from the API into the module cache. Consumer pages call
 * this from a useEffect on mount (and after route param changes / pathname
 * transitions) so SYNC reads below see current server state.
 */
export async function refreshMessages(): Promise<void> {
  try {
    CACHE = await adminApi.getMessages();
    CACHE_LOADED = true;
  } catch (err) {
    console.error('[messageStore] refresh failed', err);
  }
}

/** Has the cache ever been populated from the API? Useful for skeleton states. */
export function isLoaded(): boolean {
  return CACHE_LOADED;
}

export function loadMessages(): Message[] {
  return CACHE;
}

export function findMessage(id: string): Message | undefined {
  return CACHE.find((m) => m.id === id);
}

function patchCache(id: string, fn: (m: Message) => Message): void {
  CACHE = CACHE.map((m) => (m.id === id ? fn(m) : m));
}

function fireUpdate(id: string, update: Partial<{
  status: MessageStatus;
  assigned_to: AssignedTo;
  last_reply_body: string;
}>): void {
  adminApi.updateMessage(id, update).catch((err) => {
    console.error('[messageStore] update failed', id, update, err);
  });
}

export function markRead(id: string): void {
  const target = CACHE.find((m) => m.id === id);
  if (!target || target.status !== 'new') return;
  patchCache(id, (m) => ({
    ...m,
    status: 'read',
    read_at: new Date().toISOString(),
  }));
  fireUpdate(id, { status: 'read' });
}

export function toggleRead(id: string): void {
  const target = CACHE.find((m) => m.id === id);
  if (!target) return;
  if (target.status === 'new') {
    patchCache(id, (m) => ({
      ...m,
      status: 'read',
      read_at: new Date().toISOString(),
    }));
    fireUpdate(id, { status: 'read' });
    return;
  }
  if (target.status === 'read' || target.status === 'responded') {
    patchCache(id, (m) => ({ ...m, status: 'new', read_at: undefined }));
    fireUpdate(id, { status: 'new' });
  }
}

export function archive(id: string): void {
  patchCache(id, (m) => ({ ...m, status: 'archived' }));
  fireUpdate(id, { status: 'archived' });
}

export function markSpam(id: string): void {
  // spam_score is a server-derived field; we don't try to clamp it client-side
  // here, the optimistic update just flips status. Backend can recompute on
  // its own if it wants.
  patchCache(id, (m) => ({
    ...m,
    status: 'archived',
    spam_score: Math.max(m.spam_score ?? 0, 0.85),
  }));
  fireUpdate(id, { status: 'archived' });
}

export function assignTo(id: string, who: AssignedTo): void {
  patchCache(id, (m) => ({ ...m, assigned_to: who }));
  fireUpdate(id, { assigned_to: who });
}

export function recordReply(id: string, body: string): void {
  patchCache(id, (m) => ({
    ...m,
    status: 'responded' satisfies MessageStatus,
    responded_at: new Date().toISOString(),
    last_reply_body: body,
  }));
  fireUpdate(id, { status: 'responded', last_reply_body: body });
}

export function unreadCount(): number {
  return CACHE.filter((m) => m.status === 'new').length;
}

export function recentUnread(limit = 5): Message[] {
  return CACHE.filter((m) => m.status === 'new')
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
    .slice(0, limit);
}
