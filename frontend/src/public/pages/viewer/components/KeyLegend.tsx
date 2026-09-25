// The viewer's key legend (owner, 2026-09-24: "Users may want to use it"): a
// reference card behind a "Keys" summary in the workspace top bar, listing
// every single key the page and the 3D tab answer. It READS the maps —
// viewLabels.ts for the views, board3d/shortcuts.ts for the 3D controls,
// viewMode.ts for the mode names — and never spells a letter itself, so a
// rebound key renames here by construction.
//
// A <details> like the notes beside it, but CONTROLLED: the page owns `open`,
// because `?` toggles the card and Esc closes it from anywhere on the page.
import type { MouseEvent, ReactNode, SyntheticEvent } from 'react';
import Icon from '@shared/components/Icon';
import {
  BOARD_ACTION_LABEL, BOARD_KEYS, SPIN_AXES, SPIN_KEYS, SPIN_LABEL, VIEW_MODE_KEYS, type BoardAction,
} from '@public/components/kicad/board3d/shortcuts';
import { VIEW_MODES } from '@public/components/kicad/board3d/viewMode';
import { VIEW_KEY, type ViewId } from '../viewLabels';
import styles from './KeyLegend.module.scss';

/** The key that shows and hides the legend. A shifted character on most
 *  layouts, so the page guards it the way it guards `/`, not like a letter. */
export const LEGEND_KEY = '?';

const BOARD_ACTIONS = Object.keys(BOARD_KEYS) as BoardAction[];

// Written as escapes, so no edit tool can re-encode the glyphs on the way in.
const LEFT = '\u2190';
const UP = '\u2191';
const RIGHT = '\u2192';
const DOWN = '\u2193';

/** A key as its cap shows it: letters upper-case, as on the keyboard. */
const cap = (key: string) => key.toUpperCase();

/** "X, Y or Z", from the map: the spin keys the Shift note speaks of. */
const SPIN_CAPS = SPIN_AXES.map((a) => cap(SPIN_KEYS[a]));
const SPIN_KEY_LIST = `${SPIN_CAPS.slice(0, -1).join(', ')} or ${SPIN_CAPS[SPIN_CAPS.length - 1]}`;

interface Props {
  /** The views this project offers, in tab order — the page's own `tabs`. */
  views: readonly { id: ViewId; label: string }[];
  open: boolean;
  onToggle: (open: boolean) => void;
}

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <>
      {keys.map((k) => (
        <kbd key={k} className={styles.key}>
          {k}
        </kbd>
      ))}
    </>
  );
}

function Row({ keys, children }: { keys: readonly string[]; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <dt className={styles.keys}>
        <Keys keys={keys} />
      </dt>
      <dd className={styles.action}>{children}</dd>
    </div>
  );
}

export default function KeyLegend({ views, open, onToggle }: Props) {
  const has3d = views.some((v) => v.id === 'board3d');

  // The summary's click is the toggle, and the page's state decides: the
  // browser's own flip would race the `open` React writes back.
  const onSummaryClick = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    onToggle(!open);
  };
  // Anything else that opens a <details> (find-in-page does) is reported, so
  // the page's state never disagrees with what is on screen.
  const onDetailsToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open !== open) onToggle(e.currentTarget.open);
  };

  return (
    <details className={styles.legend} open={open} onToggle={onDetailsToggle}>
      <summary className={styles.summary} onClick={onSummaryClick}>
        <Icon name="keyboard" className={styles.glyph} />
        <span>Keys</span>
        <kbd className={styles.hint} aria-hidden="true">
          {LEGEND_KEY}
        </kbd>
      </summary>

      <div className={styles.card}>
        <div className={styles.cols}>
          <div className={styles.col}>
            <section className={styles.group}>
              <h3 className={styles.heading}>Views</h3>
              <dl className={styles.list}>
                {views.map((v) => (
                  <Row key={v.id} keys={[cap(VIEW_KEY[v.id])]}>
                    {v.label}
                  </Row>
                ))}
                <Row keys={[LEFT, RIGHT]}>Previous / next tab, on the strip</Row>
              </dl>
            </section>

            <section className={styles.group}>
              <h3 className={styles.heading}>Parts</h3>
              <dl className={styles.list}>
                <Row keys={['/']}>Find a part</Row>
                <Row keys={['Esc']}>Clear a highlight, then the selection</Row>
                <Row keys={[LEGEND_KEY]}>Show or hide these keys</Row>
              </dl>
            </section>
          </div>

          {has3d && (
            <div className={styles.col}>
              <section className={styles.group}>
                <h3 className={styles.heading}>On the 3D tab</h3>
                <dl className={styles.list}>
                  {BOARD_ACTIONS.map((a) => (
                    <Row key={a} keys={[cap(BOARD_KEYS[a])]}>
                      {BOARD_ACTION_LABEL[a]}
                    </Row>
                  ))}
                </dl>
                <dl className={`${styles.list} ${styles.listNext}`}>
                  {VIEW_MODES.map((m) => (
                    <Row key={m.id} keys={[cap(VIEW_MODE_KEYS[m.id])]}>
                      {m.label}
                    </Row>
                  ))}
                </dl>
                <dl className={`${styles.list} ${styles.listNext}`}>
                  {SPIN_AXES.map((a) => (
                    <Row key={a} keys={[cap(SPIN_KEYS[a])]}>
                      {SPIN_LABEL[a]}
                    </Row>
                  ))}
                </dl>
                <p className={styles.orbit}>
                  <span className={styles.keys}>
                    <Keys keys={['Shift']} />
                  </span>
                  <span className={styles.action}>
                    With {SPIN_KEY_LIST}: the other way. The same press again stops the spin.
                  </span>
                </p>
                <p className={styles.orbit}>
                  <span className={styles.keys}>
                    <Keys keys={[LEFT, UP, RIGHT, DOWN]} />
                  </span>
                  <span className={styles.action}>Orbit, with the board focused</span>
                </p>
              </section>
            </div>
          )}
        </div>

        <p className={styles.foot}>Plain presses only &mdash; not while typing in a field.</p>
      </div>
    </details>
  );
}
