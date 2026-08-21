/** NDJSON line-buffer parser — shared by the admin sync console and the
 * public BOM resolve stream. Blank lines are the server's 20s heartbeat:
 * traffic, not events. `rest` is the trailing partial line — feed it back in
 * with the next chunk. trim() also absorbs the CR of a CRLF proxy. */

/**
 * Split an NDJSON buffer into whole events plus the leftover partial line.
 *
 * Pure on purpose — the reader loop is untestable in a node vitest run, but
 * chunk-boundary handling is exactly where a stream client goes wrong, so the
 * boundary logic lives here where a unit test can reach it. Never throws: a
 * half-written or malformed line is skipped, because the alternative is one
 * bad byte killing a run whose per-part writes already committed.
 */
export function parseNdjson(buffer: string): { events: unknown[]; rest: string } {
  const lines = buffer.split('\n');
  // The tail after the last '\n' is by definition incomplete — it may be the
  // front half of an event still in flight. It goes back to the caller.
  const rest = lines.pop() ?? '';
  const events: unknown[] = [];
  for (const line of lines) {
    // trim() also absorbs the '\r' of a CRLF-normalizing proxy.
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // `null` is typeof 'object', and an array would sail through a bare
    // typeof check into the renderer as an event with no kind.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      events.push(parsed);
    }
  }
  return { events, rest };
}
