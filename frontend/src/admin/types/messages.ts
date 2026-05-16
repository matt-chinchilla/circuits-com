// Admin Messages — inbound communications hub.
// Discriminated union over the 4 message types that flow into the admin from
// the public site (contact / join / keyword forms) plus future replies.

export type MessageType = 'contact' | 'join' | 'keyword' | 'reply';
export type MessageStatus = 'new' | 'read' | 'archived' | 'responded';
export type AssignedTo = 'john' | 'mike' | null;
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
  sent_by: 'john' | 'mike';
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
}

export type Message =
  | (MessageBase & { type: 'contact'; payload: ContactPayload })
  | (MessageBase & { type: 'join'; payload: JoinPayload })
  | (MessageBase & { type: 'keyword'; payload: KeywordPayload })
  | (MessageBase & { type: 'reply'; payload: ReplyPayload });
