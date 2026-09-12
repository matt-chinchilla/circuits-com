import axios from 'axios';
import { API_BASE_URL } from '@shared/services/constants';
import { parseNdjson } from '@shared/utils/ndjson';
import type {
  BomRow,
  MatchLineIn,
  MissIn,
  ResolveEvent,
  ShareCreated,
  SharePayloadEnvelope,
} from './types';

const client = axios.create({ baseURL: API_BASE_URL });

export const bomApi = {
  match: (lines: MatchLineIn[]) =>
    client.post<{ rows: BomRow[] }>('/bom/match', { lines }).then((r) => r.data.rows),

  createShare: (payload: unknown) =>
    client.post<ShareCreated>('/bom/share', { payload }).then((r) => r.data),

  getShare: (slug: string) =>
    client.get<SharePayloadEnvelope>(`/bom/share/${slug}`).then((r) => r.data),

  /** Streams resolve events; resolves when the stream ends. AbortSignal
   * detaches the reader (server keeps nothing running — each miss is one
   * bounded call, unlike the admin feed runs). */
  async streamResolve(
    misses: MissIn[],
    onEvent: (e: ResolveEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/bom/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ misses }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`resolve failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseNdjson(buffer);
      buffer = rest;
      for (const e of events) onEvent(e as ResolveEvent);
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const e of parseNdjson(`${buffer}\n`).events) onEvent(e as ResolveEvent);
    }
  },
};
