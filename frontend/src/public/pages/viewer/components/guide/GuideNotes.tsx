// "Notes on what it reads" — the rules, drawn as the path a drop takes: one
// copper trace from "files" to "viewer", with each rule a numbered pad on it
// (the same numbers the markers on the sheet carry, and the targets they
// scroll to). Every number and file type is read from the reader's own
// constants (guideCopy.ts), and every sentence is true of the code as it is:
// a folder drag is deliberately not the advertised path (R2): a zip of the
// folder and the picked files work in every browser.
//
// The two long answers — which views each kind of drop opens, and what a
// turned-away file looks like — fold into disclosures under the trace, so the
// path itself stays one row on a desktop screen.
import { Fragment, type ReactNode } from 'react';
import Icon from '@shared/components/Icon';
import { MODERN_KICAD_EXTENSIONS } from '@public/services/kicad/zip';
import { VIEW_LABEL, VIEW_ORDER, viewsFor, type ViewId } from '../../viewLabels';
import { CAPS, DROP_KINDS, REFUSALS } from './guideCopy';
import { noteId } from './guideContext';
import guide from './Guide.module.scss';
import styles from './NotesFlow.module.scss';

/** "a, b and c" — each item rendered by `render`. */
function andList<T>(items: readonly T[], render: (item: T) => ReactNode, key: (item: T) => string): ReactNode {
  return items.map((item, i) => (
    <Fragment key={key(item)}>
      {i > 0 && (i === items.length - 1 ? ' and ' : ', ')}
      {render(item)}
    </Fragment>
  ));
}

/** ".kicad_pro, .kicad_sch and .kicad_pcb" with each name set as code. */
const codeList = (items: readonly string[]): ReactNode =>
  andList(items, (item) => <code>{item}</code>, (item) => item);

/** "Board, Stackup and 3D" — the workspace's own tab names. */
const viewList = (views: readonly ViewId[]): ReactNode =>
  andList(views, (id) => VIEW_LABEL[id], (id) => id);

function Station({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <li className={styles.station} id={noteId(n)} tabIndex={-1}>
      <span className={styles.pad} aria-hidden="true">
        {n}
      </span>
      <div className={styles.text}>
        <h3 className={styles.title} id={`${noteId(n)}-title`}>
          <span className={guide.srOnly}>Note {n}: </span>
          {title}
        </h3>
        <p className={styles.body}>{children}</p>
      </div>
    </li>
  );
}

/** A KiCad-style net label at one end of the trace (decoration: the heading
 *  and the list already say what the path is). */
function NetFlag({ side, label }: { side: 'in' | 'out'; label: string }) {
  return (
    <span className={styles.flag} data-side={side} aria-hidden="true">
      <svg width="64" height="20" viewBox="0 0 64 20">
        <polygon points="0.5,0.5 53.5,0.5 63.5,10 53.5,19.5 0.5,19.5" />
        <text x="28" y="14" textAnchor="middle">
          {label}
        </text>
      </svg>
    </span>
  );
}

function TruthTable() {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.truth}>
        <caption className={guide.srOnly}>Which views open for each kind of drop</caption>
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
                        <span className={guide.srOnly}>Yes</span>
                      </>
                    ) : (
                      <>
                        <span aria-hidden="true">&ndash;</span>
                        <span className={guide.srOnly}>No</span>
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

/** A fold under the trace, tagged with the pad it belongs to. */
function More({ n, summary, children }: { n: number; summary: string; children: ReactNode }) {
  return (
    <details className={styles.more}>
      <summary className={styles.moreSummary}>
        <span className={styles.moreTag} aria-hidden="true">
          {n}
        </span>
        {summary}
      </summary>
      <div className={styles.moreBody}>{children}</div>
    </details>
  );
}

export default function GuideNotes({ id, hidden }: { id: string; hidden: boolean }) {
  const [schematicOnly, boardOnly] = DROP_KINDS.map((k) => viewsFor(k.schematic, k.board));
  return (
    <section id={id} hidden={hidden} className={styles.notes} aria-labelledby="viewer-notes-title">
      <h2 className={styles.heading} id="viewer-notes-title">
        Notes on what it reads
      </h2>

      <div className={styles.flow}>
        <NetFlag side="in" label="files" />
        <ol className={styles.path}>
          <Station n={1} title="A zip of the folder, or the files together">
            Drop a zip of the project folder, or pick its KiCad files with Choose files. A zip works in every browser;
            the backups and autosaves in it are skipped.
          </Station>

          <Station n={2} title={`KiCad ${CAPS.minKicad} or newer`}>
            KiCad {CAPS.minKicad - 1} files (<code>.pro</code>, <code>.sch</code>, or a board saved before KiCad{' '}
            {CAPS.minKicad}) are turned away with a note. Open and save them in KiCad {CAPS.minKicad} or newer, then drop
            again.
          </Station>

          <Station n={3} title="Only KiCad files are read">
            {codeList(MODERN_KICAD_EXTENSIONS)} only: settings, caches, 3D models and Gerbers (manufacturing outputs)
            are skipped, even inside a zip. A drop with none is turned away.
          </Station>

          <Station n={4} title={`Up to ${CAPS.files} KiCad files`}>
            <span className={styles.figures}>
              {CAPS.perFileMb} MB each, {CAPS.totalMb} MB together.
            </span>{' '}
            Only the files that are read count toward these.
          </Station>

          <Station n={5} title="Half a project still opens">
            Sheets alone open {viewList(schematicOnly ?? [])}; a board alone opens {viewList(boardOnly ?? [])}. The
            drawings and 3D view need WebGL2.
          </Station>

          <Station n={6} title="The BOM is read from the schematic">
            No CSV export, no account. Parts excluded from the BOM in KiCad are left out; DNP parts stay out of the
            totals unless you include them.
          </Station>
        </ol>
        <NetFlag side="out" label="viewer" />
      </div>

      <div className={styles.folds}>
        <More n={3} summary="What a turned-away file looks like">
          <ul className={styles.refusalList}>
            {REFUSALS.map((r) => (
              <li key={r.what}>
                <span className={styles.refusalWhat}>{r.what}</span>
                <span className={styles.refusalMsg}>{r.message}</span>
              </li>
            ))}
          </ul>
        </More>
        <More n={5} summary="What each kind of drop opens">
          <TruthTable />
        </More>
      </div>
    </section>
  );
}
