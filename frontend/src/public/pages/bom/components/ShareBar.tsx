import { useState } from 'react';
import axios from 'axios';
import { bomApi } from '../lib/bomApi';
import { priceAt, recommend, tierRankFromOffers } from '../lib/priceBreaks';
import { buildSharePayload } from '../lib/share';
import type { TableRow } from '../lib/types';
import styles from './ShareBar.module.scss';

/**
 * The two ways a priced BOM leaves this page.
 *
 * EXPORT is pure client work: the table is already in memory, the prices were
 * computed here, and writing a CSV is a `join` — so it costs no request, no
 * dependency, and nothing about the BOM touches a server (D7). The writer
 * below is fifteen lines because RFC 4180 is fifteen lines; a CSV library
 * would be a bundle for a `replace`.
 *
 * SHARE is the opposite and is treated as such: it PUBLISHES the parts,
 * quantities and designators behind a guessable-only-by-brute-force slug.
 * That is a decision, not a button, so the disclosure appears BEFORE the
 * request and the request only leaves on a second, deliberate click.
 */

/** The recommendation is what the export publishes, not the reader's pinned
 *  what-if: the pin is a client-side override that lives with the table and is
 *  never persisted, and a column headed "Recommended Supplier" that sometimes
 *  holds something else would be the wrong kind of surprise in a spreadsheet
 *  somebody else opens. */
const CSV_HEADERS = [
  'Line',
  'MPN',
  'Manufacturer',
  'Description',
  'Designators',
  'Qty per board',
  'Build qty',
  'Line qty',
  'Match',
  'Recommended Supplier',
  'Tier',
  'Stock',
  'Unit price',
  'Extended price',
  'DNP',
  'Counted',
];

const DISCLOSURE =
  'Creates a public link containing your parts, quantities, and designators.';

/** JSX text mangles a bare ellipsis glyph (house gotcha) — it lives in a JS
 *  string instead. */
const CREATING_LABEL = 'Creating link\u2026';

const SHARE_FAILED = 'The share link could not be created. Try again in a moment.';
const SHARE_THROTTLED = 'That is a lot of share links in one minute. Try again shortly.';
const SHARE_TOO_BIG = 'This BOM is too large to share as a link. Export the CSV instead.';

type ShareState = 'idle' | 'arming' | 'creating' | 'done';

/**
 * One CSV cell.
 *
 * Every cell is quoted rather than only the ones that need it — the rule that
 * has no edge cases is the rule that cannot lose a designator list to a comma.
 * Internal quotes double, per RFC 4180.
 *
 * The leading-symbol guard is the spreadsheet half of the same job: a cell
 * that starts `=`, `+` or `@` is a FORMULA to Excel and Sheets, and BOM text
 * comes from a file we did not write. Prefixing an apostrophe makes it text
 * again, visibly, rather than executing in the reader's spreadsheet.
 */
function csvCell(value: string | number | null): string {
  if (typeof value === 'number') return `"${value}"`;
  const text = value == null ? '' : value;
  const guarded = /^[=+@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function toCsv(rows: (string | number | null)[][]): string {
  // A BOM export is opened in Excel more often than anywhere else, and Excel
  // reads a BOM-less UTF-8 file as latin-1 — which mangles every micro sign in
  // a capacitor value. The leading U+FEFF is what stops that.
  const body = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  return `\uFEFF${body}\r\n`;
}

/** What the Match column says in a file somebody reads next month, when the
 *  badge's colour and tooltip are long gone. */
function matchWord(row: TableRow): string {
  if (row.state === 'resolving') return 'PENDING';
  if (row.state === 'unavailable') return 'NO MATCH (lookups exhausted)';
  switch (row.server?.status) {
    case 'exact':
      return 'EXACT';
    case 'approx':
      return row.server.approx_reason != null ? `APPROX (${row.server.approx_reason})` : 'APPROX';
    case 'exact_live':
      return 'EXACT (live)';
    default:
      return 'NO MATCH';
  }
}

function csvRows(rows: TableRow[], buildQty: number, includeDnp: boolean) {
  const out: (string | number | null)[][] = [CSV_HEADERS];
  for (const row of rows) {
    const lineQty = Math.max(1, row.qty) * Math.max(1, buildQty);
    const offers = row.server?.offers ?? [];
    const recommendedId =
      offers.length > 0 ? recommend(offers, lineQty, tierRankFromOffers(offers)) : null;
    const chosen =
      recommendedId == null ? null : offers.find((o) => o.supplier_id === recommendedId) ?? null;
    const unit = chosen == null ? null : priceAt(chosen, lineQty);
    const part = row.server?.part ?? null;
    out.push([
      row.index,
      part?.sku ?? row.mpn ?? row.value ?? '',
      part?.manufacturer_name ?? row.manufacturer ?? '',
      part?.description ?? row.description ?? '',
      row.refs.join(', '),
      row.qty,
      buildQty,
      lineQty,
      matchWord(row),
      chosen?.supplier_name ?? '',
      chosen?.tier ?? '',
      chosen == null ? '' : chosen.stock_quantity,
      // Raw numbers, not the on-screen `$0.0042`: this file is arithmetic in
      // somebody else's spreadsheet, and a currency glyph makes it text.
      unit == null ? '' : unit.toFixed(4),
      unit == null ? '' : (unit * lineQty).toFixed(2),
      row.dnp ? 'yes' : 'no',
      row.dnp && !includeDnp ? 'no' : 'yes',
    ]);
  }
  return out;
}

function downloadCsv(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `circuitcenter-bom-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** A stored timestamp read by a human. An unparseable one degrades to the raw
 *  string rather than printing "Invalid Date" at somebody. */
export function formatShareDate(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? iso
    : when.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

interface ShareBarProps {
  rows: TableRow[];
  buildQty: number;
  includeDnp: boolean;
  /** "Change file" — hands the page back to the intake (the canvas toolbar's
   *  third control; it replaced the old Start-over text link). */
  onChangeFile: () => void;
}

export default function ShareBar({ rows, buildQty, includeDnp, onChangeFile }: ShareBarProps) {
  const [state, setState] = useState<ShareState>('idle');
  const [link, setLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createShare = () => {
    setState('creating');
    setError(null);
    bomApi
      .createShare(buildSharePayload(rows, buildQty, includeDnp))
      .then(async (created) => {
        const url = `${window.location.origin}/bom/s/${created.slug}`;
        setLink(url);
        setExpiresAt(created.expires_at);
        setState('done');
        // The clipboard is a convenience and it is allowed to fail — a denied
        // permission, a non-secure origin, an older browser. The link is on
        // screen and selectable either way; only the "Copied" claim is gated.
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      })
      .catch((err: unknown) => {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        setError(status === 429 ? SHARE_THROTTLED : status === 422 ? SHARE_TOO_BIG : SHARE_FAILED);
        setState('idle');
      });
  };

  return (
    <section className={styles.bar} aria-label="Export and share">
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.exportBtn}
          onClick={() => downloadCsv(toCsv(csvRows(rows, buildQty, includeDnp)))}
          title="The CSV is written here in your browser — the file never leaves it."
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="m7 10 5 5 5-5" />
            <path d="M12 15V3" />
          </svg>
          Export priced BOM
        </button>

        {state !== 'done' && (
          <button
            type="button"
            className={styles.shareBtn}
            disabled={state === 'creating'}
            onClick={() => (state === 'arming' ? createShare() : setState('arming'))}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5" />
            </svg>
            {state === 'creating'
              ? CREATING_LABEL
              : state === 'arming'
                ? 'Create the link'
                : 'Share a link'}
          </button>
        )}

        {state === 'arming' && (
          <button type="button" className={styles.cancelBtn} onClick={() => setState('idle')}>
            Cancel
          </button>
        )}

        <button type="button" className={styles.changeBtn} onClick={onChangeFile}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
          Change file
        </button>
      </div>

      {/* The disclosure is on screen BEFORE the request, and the request is the
          NEXT click. Nobody publishes their parts list by tapping once. */}
      {state === 'arming' && (
        <p className={styles.disclosure} role="status">
          {DISCLOSURE} The link expires on its own; anyone who has it can read the BOM until then.
        </p>
      )}

      {error != null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {state === 'done' && link != null && (
        <div className={styles.result}>
          <code className={styles.link}>{link}</code>
          <span className={styles.resultMeta}>
            {copied ? 'Copied to your clipboard. ' : 'Copy it from here. '}
            {expiresAt != null ? `Expires ${formatShareDate(expiresAt)}.` : ''}
          </span>
        </div>
      )}
    </section>
  );
}
