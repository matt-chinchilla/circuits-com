// The left of the project sheet: a KiCad project folder — the example's own
// files, then what else a folder usually holds, none of which is read.
import { useState } from 'react';
import { EXAMPLE_FILES, EXAMPLE_FOLDER, LEFT_OUT, type Net } from './guideCopy';
import { FileGlyph, FolderGlyph } from './FileGlyph';
import NoteRef from './NoteRef';
import styles from './Guide.module.scss';

/** Phones start with the "left out" group folded: the listing already sits
 *  below the buttons there, and six greyed rows would push the outputs away. */
function startsOpen(): boolean {
  try {
    return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 768px)').matches;
  } catch {
    return true;
  }
}

export default function FolderListing({ id, hidden, hot }: { id: string; hidden: boolean; hot: Net | null }) {
  const [leftOutOpen] = useState(startsOpen);
  return (
    <ul id={id} hidden={hidden} className={styles.tree} aria-label="A KiCad project folder: the example project’s files" data-trace-left="">
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
        <details className={styles.leftOut} open={leftOutOpen}>
          <summary className={styles.leftOutSummary}>
            <span>Left out, never read</span> <NoteRef n={3} />
          </summary>
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
