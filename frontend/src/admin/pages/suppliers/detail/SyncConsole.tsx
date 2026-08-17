// Live sync console — the feed panel that appears under the Quick Actions
// strip while `POST /api/suppliers/{id}/sync` is streaming.
//
// A sync takes minutes (the provider throttles itself under the free tier), so
// the point of this panel is that the operator watches the run happen instead
// of staring at a spinner and guessing. Purely presentational: the parent owns
// the stream, this renders whatever has arrived.
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
import { safeImageUrl } from '@shared/utils/url';
import { tallyCounts, terminalState, type SyncAction, type SyncEvent } from '@admin/services/syncStream';
import styles from './SyncConsole.module.scss';

interface Props {
  supplierName: string;
  /** True while the stream is open — drives the live dot and the placeholder. */
  running: boolean;
  /** Every event received so far, in arrival order. Append-only. */
  events: SyncEvent[];
  /** A transport-level failure (the run never started, or died). */
  error: string | null;
}

const ACTION_LABEL: Record<SyncAction, string> = {
  updated: 'updated',
  media_filled: 'image filled',
  not_found: 'not found',
  no_data: 'no data',
};

// `no_data` reads muted alongside `not_found` on purpose: the feed answered,
// but had nothing to add — nothing was written, so nothing should look written.
const ACTION_CLASS: Record<SyncAction, string> = {
  updated: styles.chipUpdated,
  media_filled: styles.chipMedia,
  not_found: styles.chipMuted,
  no_data: styles.chipMuted,
};

// How close to the bottom still counts as "following along". Anything above
// that and the operator is reading history — do not yank them back down.
const STICK_THRESHOLD_PX = 48;

/**
 * Part thumbnail with a glyph fallback.
 *
 * The broken-image swap is React state, not a mutation of the <img> element:
 * an `onError` handler that rewrites `src`/`style` in place fights the next
 * render and leaves the DOM disagreeing with the component.
 */
function EventThumb({ src }: { src?: string | null }) {
  const [broken, setBroken] = useState(false);
  const safe = safeImageUrl(src);
  if (!safe || broken) {
    return (
      <span className={styles.thumbFallback} aria-hidden="true">
        <Icon name="package" />
      </span>
    );
  }
  return (
    <img
      className={styles.thumb}
      src={safe}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

export default function SyncConsole({ supplierName, running, events, error }: Props) {
  const feedRef = useRef<HTMLDivElement>(null);
  // Starts true so the first rows scroll into view; flips off the moment the
  // operator scrolls up to re-read something.
  const stickRef = useRef(true);

  const handleScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    const el = feedRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const counts = tallyCounts(events);
  const terminal = terminalState(events);

  return (
    <section className={styles.console} aria-label={`Inventory sync — ${supplierName}`}>
      <div className={styles.head}>
        <div className={styles.headLeft}>
          <span
            className={`${styles.dot} ${running ? styles.dotLive : styles.dotIdle}`}
            aria-hidden="true"
          />
          <h3 className={styles.title}>
            Inventory sync <span className={styles.titleSep}>&mdash;</span>{' '}
            <span className={styles.titleName}>{supplierName}</span>
          </h3>
        </div>
        <div className={styles.counters}>
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

            const action = event.action ?? null;
            // The lookup, not the type, decides whether a chip renders: an
            // action the backend grows later would otherwise paint an empty
            // chip with `class="chip undefined"` rather than nothing.
            const label = action ? ACTION_LABEL[action] : null;
            return (
              <div key={key} className={styles.row}>
                <EventThumb src={event.image_url} />
                <span className={styles.rowBody}>
                  <span className={styles.rowTitle}>{event.title}</span>
                  {event.detail ? <span className={styles.rowMeta}>{event.detail}</span> : null}
                </span>
                {action && label ? (
                  <span className={`${styles.chip} ${ACTION_CLASS[action]}`}>{label}</span>
                ) : null}
              </div>
            );
          })}
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
