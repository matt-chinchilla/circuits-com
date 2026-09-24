// The left of the project sheet: a KiCad project folder — a generic project's
// files, then what else a folder usually holds, none of which is read.
import { useState } from 'react';
import { EXAMPLE_FILES, EXAMPLE_FOLDER, LEFT_OUT, type Net } from './guideCopy';
import { FileGlyph, FolderGlyph } from './FileGlyph';
import NoteRef from './NoteRef';
import styles from './Guide.module.scss';

/** Phones start with the "left out" group folded: the listing already sits
 *  below the buttons there, and six greyed rows would push the outputs away.
 *  So does any screen up to 900px tall — a laptop — where those rows pushed
 *  "Choose files" below the fold. */
export const LEFT_OUT_FOLDED_QUERY = '(max-width: 768px), (max-height: 900px)';

function startsOpen(): boolean {
  try {
    return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || !window.matchMedia(LEFT_OUT_FOLDED_QUERY).matches;
  } catch {
    return true;
  }
}

export default function FolderListing({ id, hidden, hot }: { id: string; hidden: boolean; hot: Net | null }) {
  const [leftOutOpen] = useState(startsOpen);
  return (
    <ul id={id} hidden={hidden} className={styles.tree} aria-label="A KiCad project folder: the files that are read, then the ones left out" data-trace-left="">
      <li className={styles.dir}>
        <FolderGlyph />
        <span className={styles.name}>{EXAMPLE_FOLDER}</span>
      </li>
      {EXAMPLE_FILES.map((f) => (
        <li key={f.name} className={styles.file} data-net={f.net} data-net-src="" data-hot={hot === f.net ? 'true' : undefined}>
          <FileGlyph kind={f.net} />
          <span className={styles.name}>{f.name}</span>
          <span className={styles.role}>{f.role}</span>
        </li>
      ))}
      <li className={styles.leftOutRow}>
        {/* The marker is a link, so it sits BESIDE the summary, never inside
            it: a summary is the disclosure's button, and a link inside a
            button is nested-interactive. */}
        <span className={styles.leftOutRef}>
          <NoteRef n={3} />
        </span>
        <details className={styles.leftOut} open={leftOutOpen}>
          <summary className={styles.leftOutSummary}>Left out, never read</summary>
          <ul className={styles.leftOutList}>
            {LEFT_OUT.map((f) => (
              <li key={f.name} className={styles.out}>
                {f.folder ? <FolderGlyph muted /> : <FileGlyph kind="out" />}
                <span className={styles.name}>{f.name}</span>
                <span className={styles.role}>{f.role}</span>
              </li>
            ))}
          </ul>
        </details>
      </li>
    </ul>
  );
}
