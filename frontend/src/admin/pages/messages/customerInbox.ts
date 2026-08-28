/**
 * The customer inbox's pure helpers, shared by its list and its detail page.
 *
 * `AccountMessage.type` is a plain string and `payload` is untyped JSON on
 * purpose (see @admin/types/account): this inbox is specified to carry
 * receipts and payment confirmations that do not exist yet, so nothing here
 * may assume the staff `Message` union. Every reader below narrows at the
 * point of use and falls back to something honest for a kind of message this
 * build has never seen — a row that renders as its own name is recoverable, a
 * row that renders as `undefined` is not.
 */

import { TYPE_META } from '@admin/components/messages/messageHelpers';
import type { AccountMessage } from '@admin/types/account';
import type { MessageType } from '@admin/types/messages';

/** True for a type the shared chips already carry a label and colour for. */
export function isStyledType(type: string): type is MessageType {
  return type in TYPE_META;
}

/** One payload field, but only when it arrived as a non-empty string. */
export function payloadText(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A wire identifier printed for a human — a type, or a payload key:
 * `payment_receipt` reads Payment receipt.
 */
export function humanLabel(identifier: string): string {
  const words = identifier.replace(/[_-]+/g, ' ').trim();
  if (words === '') return 'Message';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The line that stands for a message in the list and titles its page.
 *
 * `welcome` is spelled out rather than read from the payload: that row carries
 * only a name (routes/auth.py), so there is no subject field to read.
 */
export function inboxSubject(m: AccountMessage): string {
  if (m.type === 'welcome') return 'Welcome to Circuit Center';
  return (
    payloadText(m.payload, 'subject') ??
    payloadText(m.payload, 'title') ??
    humanLabel(m.type)
  );
}

export function unreadCount(messages: AccountMessage[]): number {
  return messages.reduce((n, m) => (m.read ? n : n + 1), 0);
}

/**
 * The HTTP status of a failed request, without dragging axios into a page —
 * the same shape the staff list reads its delete failures through.
 */
export function httpStatusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}
