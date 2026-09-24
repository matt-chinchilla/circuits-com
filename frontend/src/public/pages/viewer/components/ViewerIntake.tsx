// The viewer's intake, which is also its guide: "the project sheet".
//
// The whole sheet is the drop zone (a zip of the project folder, or its
// .kicad_pro / .kicad_sch / .kicad_pcb files). On it: an illustrative,
// generically named KiCad project folder (guideCopy's EXAMPLE_FILES — not the
// example the button loads), with what is read and what is left out, traced to
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
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
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
import StickyActions from './guide/StickyActions';
import { CAPS, KICAD_FILES_PROSE, PRIVACY_SENTENCE, type Net } from './guide/guideCopy';
import { GuideContext } from './guide/guideContext';
import { readGuideOpen, writeGuideOpen } from './guide/guideState';
import pageStyles from '../ViewerPage.module.scss';
import styles from './guide/Guide.module.scss';
import stickyStyles from './guide/StickyActions.module.scss';

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
  /** `focusRef`: the part to land on (the tour's "See U30 on the example"). */
  onProject: (project: KicadProject, focusRef?: string) => void;
}

export default function ViewerIntake({ onProject }: ViewerIntakeProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpenState] = useState(() => readGuideOpen());
  const [hot, setHot] = useState<Net | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // A refusal sits under the buttons; on a short screen it can still start at
  // the fold, so bring it fully into view (nearest: no jump when it already is).
  useEffect(() => {
    if (error != null) errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);

  // The toggle's choice is remembered; a note marker that opens the guide just
  // to show one note is not a choice, so it passes remember: false.
  const setOpen = useCallback((next: boolean, opts?: { remember?: boolean }) => {
    if (opts?.remember !== false) writeGuideOpen(next);
    setOpenState(next);
  }, []);

  // `focusRef` lands the opened project on one part. It travels WITH the
  // project, handed over only after the read succeeds: the page (which owns the
  // URL) focuses it once the canvas is ready and mirrors it into the hash, so a
  // refused drop never leaves a stray `#U30` behind, and the ref works on every
  // visit — a hash write that repeats the hash already there fires nothing.
  const read = useCallback(
    async (files: File[], focusRef?: string) => {
      setBusy(true);
      setError(null);
      try {
        const project = await buildProject(files);
        onProject(project, focusRef);
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

  const loadExample = useCallback(
    async (focusRef?: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(EXAMPLE_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        await read([new File([blob], 'glasgow-revC3.zip', { type: 'application/zip' })], focusRef);
      } catch {
        setError(EXAMPLE_FAILED_COPY);
        setBusy(false);
      }
    },
    [read],
  );

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

            {/* The ONE pair of buttons: on the card while their place is in
                view, docked to the bottom of the screen while it is not. */}
            <StickyActions
              className={styles.actions}
              busy={busy}
              dragActive={isDragActive}
              onChoose={openPicker}
              onExample={() => void loadExample()}
            />
            {/* Beside the buttons that caused it, in both states: below the
                whole sheet it landed a screen or more away from the click. */}
            {error != null && (
              <p
                ref={errorRef}
                className={`${pageStyles.intakeError} ${styles.dropError} ${stickyStyles.clearOfBar}`}
                role="alert"
              >
                {error}
              </p>
            )}
            {/* The sheet's ratings: the caps, the binding sentence, the credit.
                One block, so the compact card can stand it beside the buttons. */}
            <div className={styles.specs}>
              <p className={styles.caps}>
                <span>
                  KiCad {CAPS.minKicad} or newer <NoteRef n={2} />
                </span>
                <span>
                  Up to {CAPS.files} KiCad files, {CAPS.totalMb} MB <NoteRef n={4} />
                </span>
              </p>
              <p className={styles.privacyLine}>
                <Icon name="shield-check" className={styles.privacyLineGlyph} />
                {PRIVACY_SENTENCE}
              </p>
              <p className={styles.credit}>{EXAMPLE_CREDIT}</p>
            </div>
          </div>

          <OutputList id={GUIDE_IDS.outputs} hidden={!open} hot={hot} />
        </section>

        <GuideNotes id={GUIDE_IDS.notes} hidden={!open} />
        <PrivacyBlock />
        {/* The tour's own way in: the example, opened on the part it followed. */}
        <PartTour id={GUIDE_IDS.tour} hidden={!open} busy={busy} onSeeRef={(ref) => void loadExample(ref)} />
      </div>
    </GuideContext.Provider>
  );
}
