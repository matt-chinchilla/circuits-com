import { useCallback, useRef, useState } from 'react';
import { useDropzone, type Accept, type FileRejection } from 'react-dropzone';
import { parseBomText, parsePasteRows, type ParseResult } from '../lib/parseBom';
import { readSpreadsheet } from '../lib/xlsx';
import styles from '../BomPage.module.scss';

// Intake is a DUMB TRIGGER: it reads a file (or a pasted block), parses it and
// hands the ParseResult up. The file, the parse result and every phase after
// it live in the page (index.tsx) — the QuickActionsPanel ownership rule.
//
// The surface is the Upload artboard: a datasheet card (PCB grid + crop
// marks, the contact-page motif) with the lit primary and a glass toggle that
// REVEALS the paste panel, then the two info cards — what we detect, and the
// privacy promise.

const ACCEPT: Accept = {
  'text/csv': ['.csv'],
  'text/tab-separated-values': ['.tsv'],
  'text/plain': ['.txt'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

const SPREADSHEET_EXTENSIONS = ['.xls', '.xlsx'];

/** The columns the auto-mapper recognises without asking — shown as chips so
 *  the person can see their export will land before they drop it. */
const DETECTED_COLUMNS = [
  'Reference',
  'Value',
  'Footprint',
  'Qty',
  'MPN',
  'Manufacturer',
  'Description',
  'Datasheet',
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** Name the extension the person actually dropped — "unsupported file" tells
 *  them nothing they did not already know. */
function rejectionCopy(name: string): string {
  const ext = extensionOf(name);
  const what = ext === '' ? 'That file has no extension' : `That's a ${ext}`;
  return `${what} — export your BOM as CSV or XLSX and try again.`;
}

interface BomIntakeProps {
  /** `sourceName` is the file name, or "pasted lines" for the textarea.
   *  `text` is the raw source the page keeps so the mapper can re-materialize
   *  the same rows with different roles instead of re-reading the file. */
  onParsed: (result: ParseResult, sourceName: string, text: string) => void;
}

export default function BomIntake({ onParsed }: BomIntakeProps) {
  const [paste, setPaste] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pasteBoxRef = useRef<HTMLTextAreaElement>(null);

  const readFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const spreadsheet = SPREADSHEET_EXTENSIONS.includes(extensionOf(file.name));
        // SheetJS is only fetched when a workbook actually lands (spec 7.1).
        const text = spreadsheet ? await readSpreadsheet(file) : await file.text();
        onParsed(parseBomText(text), file.name, text);
      } catch {
        setError(
          `We could not read ${file.name}. If it is a spreadsheet, re-save it as CSV and drop that.`,
        );
      } finally {
        setBusy(false);
      }
    },
    [onParsed],
  );

  const onDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      const rejected = rejections[0];
      if (rejected) {
        setError(rejectionCopy(rejected.file.name));
        return;
      }
      const file = accepted[0];
      if (!file) return;
      void readFile(file);
    },
    [readFile],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: ACCEPT,
    multiple: false,
    maxFiles: 1,
    noClick: true,
    noKeyboard: true,
  });

  const submitPaste = () => {
    if (!paste.trim()) {
      setError('Paste one part per line first — part number, then quantity.');
      return;
    }
    setError(null);
    onParsed(parsePasteRows(paste), 'pasted lines', paste);
  };

  const revealPaste = () => {
    setPasteOpen(true);
    // Focus after the panel exists; preventScroll keeps the reveal calm.
    requestAnimationFrame(() => pasteBoxRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div className={styles.intake}>
      <div>
        <h2 className={styles.introTitle}>Price your bill of materials</h2>
        <p className={styles.introCopy}>
          Drop in a BOM and we will match every line against the catalog, apply your quantity
          breaks, and total it across 57 distributors. Anything we do not carry, we look up live
          while you watch.
        </p>
      </div>

      <section
        {...getRootProps({
          className: `${styles.drop} ${isDragActive ? styles.dropActive : ''}`,
        })}
        aria-label="Upload a bill of materials"
      >
        <input {...getInputProps()} />
        <span className={`${styles.crop} ${styles.cropTl}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropTr}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropBl}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropBr}`} aria-hidden="true" />

        <svg
          className={styles.dropIcon}
          width="42"
          height="42"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M12 18v-6" />
          <path d="m9 15 3-3 3 3" />
        </svg>

        <p className={styles.dropLead}>Drop your BOM here</p>

        <div className={styles.btnRow}>
          <button type="button" className={styles.dropBtn} onClick={open} disabled={busy}>
            {busy ? 'Reading…' : 'Choose a file'}
          </button>
          {!pasteOpen && (
            <button type="button" className={styles.pasteToggle} onClick={revealPaste}>
              Paste rows instead
            </button>
          )}
        </div>

        <p className={styles.formatLine}>CSV&ensp;XLSX&ensp;XLS&ensp;TSV&ensp;&middot;&ensp;up to 2,000 lines</p>
      </section>

      {pasteOpen && (
        <section className={styles.paste} aria-label="Paste part numbers">
          <label className={styles.pasteLabel} htmlFor="bom-paste">
            One part per line &mdash; part number, then quantity after a comma or a space
          </label>
          <textarea
            id="bom-paste"
            ref={pasteBoxRef}
            className={styles.pasteBox}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={'LM317T, 4\nSTM32F103C8T6 1\n0805 10k 1%, 40'}
          />
          <button type="button" className={styles.pasteBtn} onClick={submitPaste} disabled={busy}>
            Price these lines
          </button>
        </section>
      )}

      {error != null && (
        <p className={styles.intakeError} role="alert">
          {error}
        </p>
      )}

      <div className={styles.infoGrid}>
        <section className={styles.infoCard} aria-label="Columns we detect">
          <div className={styles.infoLabel}>Columns we detect</div>
          <div>
            {DETECTED_COLUMNS.map((col) => (
              <span key={col} className={styles.colChip}>
                {col}
              </span>
            ))}
          </div>
          <p className={styles.infoCopy}>
            KiCad, Altium and Eagle exports are recognised as-is. Anything unusual and you map the
            columns yourself.
          </p>
        </section>

        <section className={styles.infoCard} aria-label="Your file stays here">
          <div className={styles.infoLabel}>Your file stays here</div>
          <div className={styles.privacyRow}>
            <svg
              className={styles.privacyTick}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span>The file is read in your browser. Only part numbers are sent to us.</span>
          </div>
          <div className={styles.privacyRow}>
            <svg
              className={styles.privacyTick}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span>Quantities and designators never leave your machine unless you choose to share.</span>
          </div>
        </section>
      </div>
    </div>
  );
}
