// Admin Messages — inbound communications hub.
// Discriminated union over the message types that flow into the admin from
// the public site (contact / join / keyword forms) plus replies, and the two
// rows a verified customer registration writes (signup / welcome).

export type MessageType = 'contact' | 'join' | 'keyword' | 'reply' | 'signup' | 'welcome';
export type MessageStatus = 'new' | 'read' | 'archived' | 'responded';
export type AssignedTo = 'Daniel' | 'Anthony' | 'Ronald' | null;
export type Tier = 'silver' | 'gold' | 'platinum';
export type ContactReason = 'general' | 'list' | 'data' | 'press' | 'other';

export interface ContactPayload {
  name: string;
  email: string;
  subject: string;
  message: string;
  reason?: ContactReason;
}

export interface JoinPayload {
  company_name: string;
  contact_person: string;
  email: string;
  phone: string;
  website?: string;
  categories_of_interest: string[];
  tier?: Tier;
  message?: string;
}

export interface KeywordPayload {
  company_name: string;
  email: string;
  keyword: string;
  message?: string;
}

export interface ReplyPayload {
  to: string;
  subject: string;
  body: string;
  sent_by: 'Daniel' | 'Anthony' | 'Ronald';
}

/**
 * The staff row a verified registration writes. Keys mirror the dict in
 * POST /api/auth/verify exactly — `payload` is an untyped JSON column, so a
 * rename there silently blanks a field here (pinned by
 * components/messages/messagePayloadContract.test.ts).
 */
export interface SignupPayload {
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  /** Stamped from the signup IP via the GeoIP db — absent for a private IP. */
  country?: string | null;
}

/**
 * The customer's own welcome row. It carries NO email on purpose: it was
 * written TO them, not received FROM them, so there is nobody to reply to.
 */
export interface WelcomePayload {
  first_name: string;
  full_name: string;
}

interface MessageBase {
  id: string;
  seq: number; // sequential counter — drives the MSG-#### designator
  status: MessageStatus;
  created_at: string; // ISO
  read_at?: string;
  responded_at?: string;
  assigned_to?: AssignedTo;
  // 0-1, only surfaced if > 0.6. Type allows `null` because the backend
  // serializes Python `None` as JSON `null` — `?:` alone catches only
  // `undefined` and lets `null` slip through. Always guard with `!= null`
  // (loose-equality catches both `null` and `undefined`) before calling
  // numeric methods like `.toFixed()`.
  spam_score?: number | null;
  last_reply_body?: string; // hydrated by the inline reply UI
  /** NULL = the shared staff inbox. Populated = one customer's inbox. */
  user_id?: string | null;
}

export type Message =
  | (MessageBase & { type: 'contact'; payload: ContactPayload })
  | (MessageBase & { type: 'join'; payload: JoinPayload })
  | (MessageBase & { type: 'keyword'; payload: KeywordPayload })
  | (MessageBase & { type: 'reply'; payload: ReplyPayload })
  | (MessageBase & { type: 'signup'; payload: SignupPayload })
  | (MessageBase & { type: 'welcome'; payload: WelcomePayload });

/**
 * Response body of POST /api/admin/messages/bulk-delete.
 * `missing` = ids the server no longer held (already deleted elsewhere, or a
 * stale list) — reported separately so the UI never claims them as deleted.
 */
export interface BulkDeleteResult {
  deleted: number;
  missing: number;
}
