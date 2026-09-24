// The viewer's intake, which is also its guide: "the project sheet".
//
// The whole sheet is the drop zone (a zip of the project folder, or its
// .kicad_pro / .kicad_sch / .kicad_pcb files). On it: a real KiCad project
// folder — the example's — with what is read and what is left out, traced to
// what each file becomes in the viewer, footnoted with the rules. Below it: the
// notes, what happens to the files, and a short tour of the one feature worth
// knowing first.
//
// The guide COLLAPSES (owner: "huge"): "Hide the guide" folds the sheet to a
// compact drop card — heading, both buttons, the caps, the privacy sentence,
// the credit — plus the privacy block, and the choice is remembered per
// browser. The folded parts are `hidden`, never unmounted, so the toggle's
// aria-controls always names elements that exist. The drop zone and both
// buttons behave identically in both states.
//
// The example loads Glasgow revC3 (0BSD) through the SAME buildProject a drop
// uses.
import { useCallback, useState, type PointerEvent } from 'react';
import { useDropzone, type Accept, type FileRejection } from 'react-dropzone';
import Icon from '@shared/components/Icon';
import { buildProject } from '@public/services/kicad/project';
import { KicadReadError, type KicadProject } from '@public/services/kicad/types';
import { KICAD_EXTENSIONS } from '@public/services/kicad/zip';
import { EXAMPLE_CREDIT, EXAMPLE_FAILED_COPY, EXAMPLE_URL, UNREADABLE_COPY, rejectionCopy } from '../intakeCopy';
import BlueprintTraces from './guide/BlueprintTraces';
import FolderListing from './guide/FolderListing';
import GuideNotes from './guide/GuideNotes';
import NoteRef from './guide/NoteRef';
import OutputList from './guide/OutputList';
import PartTour from './guide/PartTour';
import PrivacyBlock from './guide/PrivacyBlock';
import { CAPS, KICAD_FILES_PROSE, PRIVACY_SENTENCE, type Net } from './guide/guideCopy';
import { GuideContext } from './guide/guideContext';
import { readGuideOpen, writeGuideOpen } from './guide/guideState';
import pageStyles from '../ViewerPage.module.scss';
import styles from './guide/Guide.module.scss';

// .sch and .pro are admitted ONLY so an old-format project is refused by name.
const ACCEPT: Accept = {
  'application/zip': ['.zip'],
  'application/octet-stream': [...KICAD_EXTENSIONS],
};

/** The regions "Hide the guide" folds away — the toggle's aria-controls. */
const GUIDE_IDS = {
  folder: 'viewer-guide-folder',
  outputs: 'viewer-guide-outputs',
  notes: 'viewer-guide-notes',
  tour: 'viewer-guide-tour',
} as const;

interface ViewerIntakeProps {
  onProject: (project: KicadProject) => void;
}

export default function ViewerIntake({ onProject }: ViewerIntakeProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpenState] = useState(() => readGuideOpen());
  const [hot, setHot] = useState<Net | null>(null);

  const setOpen = useCallback((next: boolean) => {
    writeGuideOpen(next);
    setOpenState(next);
  }, []);

  const read = useCallback(
    async (files: File[]) => {
      setBusy(true);
      setError(null);
      try {
        onProject(await buildProject(files));
      } catch (err) {
        setError(err instanceof KicadReadError ? err.message : UNREADABLE_COPY);
      } finally {
        setBusy(false);
      }
    },
    [onProject],
  );

  const onDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      const rejected = rejections[0];
      if (rejected && accepted.length === 0) {
        setError(rejectionCopy(rejected.file.name));
        return;
      }
      if (accepted.length === 0) return;
      void read(accepted);
    },
    [read],
  );

  const loadExample = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(EXAMPLE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await read([new File([blob], 'glasgow-revC3.zip', { type: 'application/zip' })]);
    } catch {
      setError(EXAMPLE_FAILED_COPY);
      setBusy(false);
    }
  }, [read]);

  const { getRootProps, getInputProps, isDragActive, open: openPicker } = useDropzone({
    onDrop,
    accept: ACCEPT,
    multiple: true,
    noClick: true,
    noKeyboard: true,
    useFsAccessApi: false,
  });

  // Hover lights one net end to end: the file rows, the trace, the cards.
  const onPointerOver = (e: PointerEvent<HTMLElement>) => {
    const el = (e.target as Element | null)?.closest?.('[data-net]');
    const net = (el?.getAttribute('data-net') ?? null) as Net | null;
    if (net !== hot) setHot(net);
  };

  const rootProps = getRootProps({
    className: styles.sheet,
    // react-dropzone defaults the root to role="presentation", which would
    // strip the section's name; it is the page's landmark for opening a project.
    role: 'region',
    onPointerOver,
    onPointerLeave: () => setHot(null),
  });

  return (
    <GuideContext.Provider value={{ open, setOpen }}>
      <div className={styles.intake}>
        <div className={styles.toggleRow}>
          <button
            type="button"
            className={open ? styles.toggle : `${styles.toggle} ${styles.toggleClosed}`}
            aria-expanded={open}
            aria-controls={Object.values(GUIDE_IDS).join(' ')}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? 'eye-slash' : 'book-open-text'} className={styles.toggleGlyph} />
            {open ? 'Hide the guide' : 'How it works'}
          </button>
        </div>

        <section
          {...rootProps}
          aria-label="Open a KiCad project"
          data-guide={open ? 'open' : 'closed'}
          data-drag={isDragActive ? 'true' : undefined}
        >
          <input {...getInputProps()} />
          <span className={`${styles.crop} ${styles.cropTl}`} aria-hidden="true" />
          <span className={`${styles.crop} ${styles.cropTr}`} aria-hidden="true" />
          <span className={`${styles.crop} ${styles.cropBl}`} aria-hidden="true" />
          <span className={`${styles.crop} ${styles.cropBr}`} aria-hidden="true" />
          <BlueprintTraces active={open} hot={isDragActive ? null : hot} />

          <div className={styles.folderCol}>
            <h2 className={styles.dropTitle}>
              {isDragActive ? (
                'Drop the project here'
              ) : (
                <>
                  <span className={styles.wide}>Drop your KiCad project here</span>
                  <span className={styles.narrow}>Open your KiCad project</span>
                </>
              )}
            </h2>
            <p className={styles.dropSub}>
              <span className={styles.wide}>
                A zip of the project folder, or its {KICAD_FILES_PROSE} files together.
              </span>
              <span className={styles.narrow}>
                Choose a zip of the project folder, or its {KICAD_FILES_PROSE} files together.
              </span>{' '}
              <NoteRef n={1} />
            </p>

            <FolderListing id={GUIDE_IDS.folder} hidden={!open} hot={hot} />

            <div className={`${pageStyles.btnRow} ${styles.actions}`}>
              <button type="button" className={pageStyles.dropBtn} onClick={openPicker} disabled={busy}>
                {busy ? 'Reading…' : 'Choose files'}
              </button>
              <button type="button" className={pageStyles.exampleBtn} onClick={() => void loadExample()} disabled={busy}>
                Try the example project
              </button>
            </div>
            <p className={styles.caps}>
              <span>
                KiCad {CAPS.minKicad} or newer <NoteRef n={2} />
              </span>
              <span>
                Up to {CAPS.files} files, {CAPS.totalMb} MB <NoteRef n={4} />
              </span>
            </p>
            <p className={styles.privacyLine}>
              <Icon name="shield-check" className={styles.privacyLineGlyph} />
              {PRIVACY_SENTENCE}
            </p>
            <p className={styles.credit}>{EXAMPLE_CREDIT}</p>
          </div>

          <OutputList id={GUIDE_IDS.outputs} hidden={!open} hot={hot} />
        </section>

        {error != null && (
          <p className={pageStyles.intakeError} role="alert">
            {error}
          </p>
        )}

        <GuideNotes id={GUIDE_IDS.notes} hidden={!open} />
        <PrivacyBlock />
        <PartTour id={GUIDE_IDS.tour} hidden={!open} busy={busy} onTryExample={() => void loadExample()} />
      </div>
    </GuideContext.Provider>
  );
}
