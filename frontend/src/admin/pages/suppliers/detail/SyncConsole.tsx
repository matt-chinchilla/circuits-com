// Live feed console — the panel that appears under the Quick Actions strip
// while `POST /api/suppliers/{id}/sync` or `.../import` is streaming.
//
// ONE panel for both runs: the two routes speak the same NDJSON envelope and
// the operator is watching the same thing happen, so the only difference is
// which run the header names (`mode`). A run takes minutes (the provider
// throttles itself under the free tier), so the point of this panel is that
// the operator watches it happen instead of staring at a spinner and guessing.
// Purely presentational: the parent owns the stream, this renders whatever has
// arrived.
//
// Two honesty rules, both load-bearing:
//   1. The FOOTER prints the server's own `sync_finished` detail verbatim. The
//      run's totals are the server's arithmetic; recomputing them client-side
//      could only ever produce a second, disagreeing number.
//   2. A `sync_error` row says progress is saved, because it is — the importer
//      commits per part, so a quota wall mid-run keeps everything it already
//      reported.

import { useEffect, useRef, useState } from 'react';
import Icon from '@shared/components/Icon';
import PartThumb from '@admin/components/PartThumb';
import { tallyCounts, terminalState, type SyncAction, type SyncEvent } from '@admin/services/syncStream';
import styles from './SyncConsole.module.scss';

interface Props {
  supplierName: string;
  /**
   * Which run is on screen. Names the header only — the counters, chips and
   * footer are identical, because the server reports the same five counters
   * on both routes (a sync creates nothing, an import looks nothing up).
   */
  mode?: 'sync' | 'import';
  /** True while the stream is open — drives the live dot and the placeholder. */
  running: boolean;
  /** Every event received so far, in arrival order. Append-only. */
  events: SyncEvent[];
  /** A transport-level failure (the run never started, or died). */
  error: string | null;
}

// `no_data` reads muted alongside `not_found` on purpose: the feed answered,
// but had nothing to add — nothing was written, so nothing should look written.
// `created` gets its own hue: it is the one action that added a page to the
// public site, and reading it as an update would undersell an import's whole
// point.
const ACTION_CHIP: Record<SyncAction, { label: string; cls: string }> = {
  created: { label: 'created', cls: styles.chipCreated },
  updated: { label: 'updated', cls: styles.chipUpdated },
  media_filled: { label: 'image filled', cls: styles.chipMedia },
  not_found: { label: 'not found', cls: styles.chipMuted },
  no_data: { label: 'no data', cls: styles.chipMuted },
};

// How close to the bottom still counts as "following along". Anything above
// that and the operator is reading history — do not yank them back down.
const STICK_THRESHOLD_PX = 48;

export default function SyncConsole({
  supplierName,
  mode = 'sync',
  running,
  events,
  error,
}: Props) {
  const runLabel = mode === 'import' ? 'Inventory import' : 'Inventory sync';
  const feedRef = useRef<HTMLDivElement>(null);
  // Starts true so the first rows scroll into view; flips off the moment the
  // operator scrolls up to re-read something.
  const stickRef = useRef(true);
  // How many rows arrived while following was paused — drives the resume pill.
  const seenRef = useRef(0);
  const [behind, setBehind] = useState(0);

  // A NEW run must always follow: without this reset, scrolling up once in
  // run 1 left every later run un-followed (review-caught — the ref outlives
  // the events array the page resets between runs).
  useEffect(() => {
    if (!running) return;
    stickRef.current = true;
    seenRef.current = 0;
    setBehind(0);
  }, [running]);

  const followToBottom = () => {
    const el = feedRef.current;
    if (!el) return;
    // Instant for the same reason as the follow effect: a smooth glide's own
    // scroll events would read as the operator scrolling and cancel the
    // following this button exists to resume.
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    seenRef.current = events.length;
    setBehind(0);
  };

  const handleScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
    stickRef.current = atBottom;
    if (atBottom) {
      seenRef.current = events.length;
      setBehind(0); // same-value updates bail out — no render loop
    }
  };

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (stickRef.current) {
      // INSTANT, not smooth — a smooth glide fires scroll events on the way
      // down, the handler below reads them as the operator scrolling, and
      // following switches itself off mid-animation (owner-reported).
      el.scrollTop = el.scrollHeight;
      seenRef.current = events.length;
      if (behind !== 0) setBehind(0);
    } else {
      setBehind(events.length - seenRef.current);
    }
    // `behind` is output, not input, of this effect — deliberately absent
    // from the deps, or the scroll would re-run on every pill update.
  }, [events.length]);

  const counts = tallyCounts(events);
  const terminal = terminalState(events);

  return (
    <section className={styles.console} aria-label={`${runLabel} — ${supplierName}`}>
      <div className={styles.head}>
        <div className={styles.headLeft}>
          <span
            className={`${styles.dot} ${running ? styles.dotLive : styles.dotIdle}`}
            aria-hidden="true"
          />
          <h3 className={styles.title}>
            {runLabel} <span className={styles.titleSep}>&mdash;</span>{' '}
            <span className={styles.titleName}>{supplierName}</span>
          </h3>
        </div>
        {/* All five counters, on both runs. The server reports the same five
            keys either way, so a zero here is a zero — never a counter this
            panel decided not to show. */}
        <div className={styles.counters}>
          <span className={styles.counter}>
            <b>{counts.created}</b> created
          </span>
          <span className={styles.counter}>
            <b>{counts.synced}</b> synced
          </span>
          <span className={styles.counter}>
            <b>{counts.media_filled}</b> images
          </span>
          <span className={styles.counter}>
            <b>{counts.not_found}</b> not found
          </span>
          <span className={styles.counter}>
            <b>{counts.no_data}</b> no data
          </span>
        </div>
      </div>

      {events.length > 0 && (
        <div className={styles.feed} ref={feedRef} onScroll={handleScroll}>
          {events.map((event, index) => {
            // Index keys are correct here and only here: the list is strictly
            // append-only — nothing is reordered, filtered out, or removed.
            const key = `${index}-${event.kind}`;
            if (event.kind === 'sync_finished') return null;

            if (event.kind === 'sync_started') {
              return (
                <div key={key} className={`${styles.row} ${styles.rowSystem}`}>
                  <span className={styles.rowIcon} aria-hidden="true">
                    <Icon name="play-circle" />
                  </span>
                  <span className={styles.systemText}>{event.detail ?? 'Sync started'}</span>
                </div>
              );
            }

            if (event.kind === 'sync_error') {
              return (
                <div key={key} className={`${styles.row} ${styles.rowError}`}>
                  <span className={styles.rowIcon} aria-hidden="true">
                    <Icon name="warning-circle" />
                  </span>
                  <span className={styles.errorText}>
                    <b>{event.title}</b>
                    {event.detail ? <span className={styles.errorDetail}>{event.detail}</span> : null}
                    <span className={styles.errorReassure}>
                      Progress up to this point is saved.
                    </span>
                  </span>
                </div>
              );
            }

            // The lookup, not the type, decides whether a chip renders: an
            // action the backend grows later would otherwise paint an empty
            // chip with `class="chip undefined"` rather than nothing.
            const chip = event.action ? ACTION_CHIP[event.action] : null;
            return (
              <div key={key} className={styles.row}>
                <PartThumb src={event.image_url} />
                <span className={styles.rowBody}>
                  <span className={styles.rowTitle}>{event.title}</span>
                  {event.detail ? <span className={styles.rowMeta}>{event.detail}</span> : null}
                </span>
                {chip ? <span className={`${styles.chip} ${chip.cls}`}>{chip.label}</span> : null}
              </div>
            );
          })}
          {behind > 0 && (
            /* Sticky inside the scroll area, so it floats over the last rows
               while the operator reads history above. */
            <button type="button" className={styles.followPill} onClick={followToBottom}>
              {'↓'} {behind} new {behind === 1 ? 'row' : 'rows'} &mdash; resume following
            </button>
          )}
        </div>
      )}

      {/* The live region has to EXIST before its content changes or a screen
          reader announces nothing, so this wrapper is unconditional and only
          its children come and go. Per-part rows are deliberately outside it:
          announcing every SKU of a 25-part run would be unusable. */}
      <div aria-live="polite">
        {running && events.length === 0 && !error && (
          <p className={styles.waiting}>Contacting the feed&hellip;</p>
        )}

        {error && <p className={styles.hint}>{error}</p>}

        {terminal &&
          (terminal.outcome === 'done' ? (
            <div className={styles.footer}>
              <Icon name="check-circle" className={styles.footerIcon} />
              {/* Verbatim from the server — it already reads
                  "X synced · Y images filled · Z not found" and appends
                  " · W no data" only when there is any. */}
              <span>Done &mdash; {terminal.detail}</span>
            </div>
          ) : (
            // A run the feed cut short still ends with sync_finished, but it did
            // not complete: no green check and no "Done", or the footer would
            // contradict the error row directly above it.
            <div className={`${styles.footer} ${styles.footerAborted}`}>
              <Icon name="warning-circle" className={styles.footerIcon} />
              <span>{terminal.detail}</span>
            </div>
          ))}
      </div>
    </section>
  );
}
