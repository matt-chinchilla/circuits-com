// "Notes on what it reads" — the rules, as the project sheet's numbered
// datasheet notes. Every number and file type is read from the reader's own
// constants (guideCopy.ts), and every sentence is true of the code as it is:
// the folder DRAG is deliberately not offered (a dragged folder can pull in
// KiCad's backup copies; a zip of the folder is read correctly).
import { Fragment, type ReactNode } from 'react';
import Icon from '@shared/components/Icon';
import { MODERN_KICAD_EXTENSIONS } from '@public/services/kicad/zip';
import { VIEW_LABEL, VIEW_ORDER, viewsFor } from '../../viewLabels';
import { CAPS, DROP_KINDS, REFUSALS } from './guideCopy';
import { noteId } from './guideContext';
import styles from './Guide.module.scss';

/** ".kicad_pro, .kicad_sch and .kicad_pcb" with each name set as code. */
function codeList(items: readonly string[]): ReactNode {
  return items.map((item, i) => (
    <Fragment key={item}>
      {i > 0 && (i === items.length - 1 ? ' and ' : ', ')}
      <code>{item}</code>
    </Fragment>
  ));
}

function Note({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className={styles.note} id={noteId(n)} tabIndex={-1}>
      <span className={styles.noteNum} aria-hidden="true">
        {n}
      </span>
      <h3 className={styles.noteTitle} id={`${noteId(n)}-title`}>
        <span className={styles.srOnly}>Note {n}: </span>
        {title}
      </h3>
      <div className={styles.noteBody}>{children}</div>
    </div>
  );
}

function TruthTable() {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.truth}>
        <caption className={styles.srOnly}>Which views open for each kind of drop</caption>
        <thead>
          <tr>
            <th scope="col">You drop</th>
            {VIEW_ORDER.map((id) => (
              <th scope="col" key={id}>
                {VIEW_LABEL[id]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DROP_KINDS.map((k) => {
            const open = viewsFor(k.schematic, k.board);
            return (
              <tr key={k.label}>
                <th scope="row">{k.label}</th>
                {VIEW_ORDER.map((id) => (
                  <td key={id} data-yes={open.includes(id) ? 'true' : undefined}>
                    {open.includes(id) ? (
                      <>
                        <Icon name="check" className={styles.yes} />
                        <span className={styles.srOnly}>Yes</span>
                      </>
                    ) : (
                      <>
                        <span aria-hidden="true">&ndash;</span>
                        <span className={styles.srOnly}>No</span>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function GuideNotes({ id, hidden }: { id: string; hidden: boolean }) {
  return (
    <section id={id} hidden={hidden} className={styles.notes} aria-labelledby="viewer-notes-title">
      <h2 className={styles.notesTitle} id="viewer-notes-title">
        Notes on what it reads
      </h2>

      <Note n={1} title="A zip of the folder, or the files together">
        <p>
          Zip the project folder and drop the zip, or use Choose files to pick its {codeList(MODERN_KICAD_EXTENSIONS)} files
          together. A zip works in every browser, and KiCad&rsquo;s backups inside it are skipped.
        </p>
      </Note>

      <Note n={2} title={`KiCad ${CAPS.minKicad} or newer`}>
        <p>
          A KiCad {CAPS.minKicad - 1} project (<code>.pro</code> and <code>.sch</code> files, or a board saved before KiCad{' '}
          {CAPS.minKicad}) is turned away with a note. Open it in KiCad {CAPS.minKicad} or newer, save it, and drop it again.
        </p>
      </Note>

      <Note n={3} title="Only KiCad files are read">
        <p>
          The viewer reads {codeList(MODERN_KICAD_EXTENSIONS)} files and nothing else. Local settings, library caches, 3D
          models and Gerbers are skipped: Gerbers are manufacturing outputs, which the viewer does not read. In a zip, only the
          KiCad files are unpacked. A drop with no KiCad files in it is turned away with a note.
        </p>
        <details className={styles.refusals}>
          <summary className={styles.refusalsSummary}>What a turned-away file looks like</summary>
          <ul className={styles.refusalList}>
            {REFUSALS.map((r) => (
              <li key={r.what}>
                <span className={styles.refusalWhat}>{r.what}</span>
                <span className={styles.refusalMsg}>{r.message}</span>
              </li>
            ))}
          </ul>
        </details>
      </Note>

      <Note n={4} title={`Up to ${CAPS.files} KiCad files, ${CAPS.perFileMb} MB each, ${CAPS.totalMb} MB together`}>
        <p>
          Only the files that are read count toward these. A zip itself can be up to {CAPS.archiveMb} MB.
        </p>
      </Note>

      <Note n={5} title="Half a project still opens">
        <TruthTable />
        <p>The drawings and the 3D view need a browser with WebGL2.</p>
      </Note>

      <Note n={6} title="The BOM is read from the schematic">
        <p>
          No CSV export and no account. Parts excluded from the BOM in KiCad are left out, and parts marked DNP stay out of
          the totals unless you include them.
        </p>
      </Note>
    </section>
  );
}
