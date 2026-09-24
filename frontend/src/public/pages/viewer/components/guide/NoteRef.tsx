// A datasheet footnote marker: a circled number at the spot a rule governs,
// linking to that rule's note below the sheet.
//
// The link is handled here rather than left to the browser because /viewer
// reads its URL hash as a DESIGNATOR ("#U30" focuses that part once a project
// opens) — letting "#note-3" into the hash would make the next project say
// "note-3 is not in this schematic". So: no hash change, a scroll, focus moved
// to the note (it is tabIndex -1), and a brief highlight on it.
import type { MouseEvent } from 'react';
import { goToNote, noteId, useGuide } from './guideContext';
import styles from './Guide.module.scss';

export default function NoteRef({ n }: { n: number }) {
  const { open, setOpen } = useGuide();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (open) {
      goToNote(n);
      return;
    }
    // The notes are hidden with the guide: show it, then go once it has laid out.
    setOpen(true);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => goToNote(n)));
  };
  return (
    <a className={styles.ref} href={`#${noteId(n)}`} aria-label={`Note ${n}`} onClick={onClick}>
      {n}
    </a>
  );
}
