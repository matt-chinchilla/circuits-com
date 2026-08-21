import { useCallback, useState } from 'react';
import { useDropzone, type Accept, type FileRejection } from 'react-dropzone';
import { parseBomText, parsePasteRows, type ParseResult } from '../lib/parseBom';
import { readSpreadsheet } from '../lib/xlsx';
import styles from '../BomPage.module.scss';

// Intake is a DUMB TRIGGER: it reads a file (or a pasted block), parses it and
// hands the ParseResult up. The file, the parse result and every phase after
// it live in the page (index.tsx) — the QuickActionsPanel ownership rule.
//
// The only state kept here is the read itself: the textarea's draft, the
// "reading…" flag and the named error for a file we could not use. A wrong
// file type is answered with a sentence, never a spinner (spec §9).

const ACCEPT: Accept = {
  'text/csv': ['.csv'],
  'text/tab-separated-values': ['.tsv'],
  'text/plain': ['.txt'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

const SPREADSHEET_EXTENSIONS = ['.xls', '.xlsx'];

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className={styles.intake}>
      <section
        {...getRootProps({
          className: `${styles.drop} ${isDragActive ? styles.dropActive : ''}`,
        })}
        aria-label="Upload a bill of materials"
      >
        <input {...getInputProps()} />
        <p className={styles.dropLead}>Drop a BOM export from KiCad, Altium, or a spreadsheet</p>
        <p className={styles.dropHint}>
          CSV, TSV, TXT, XLS or XLSX &middot; up to 2,000 lines &middot; nothing is uploaded until
          you ask for prices
        </p>
        <button type="button" className={styles.dropBtn} onClick={open} disabled={busy}>
          {busy ? 'Reading…' : 'Choose a file'}
        </button>
      </section>

      <section className={styles.paste} aria-label="Paste part numbers">
        <label className={styles.pasteLabel} htmlFor="bom-paste">
          Or paste rows &mdash; one part per line, quantity after a comma or a space
        </label>
        <textarea
          id="bom-paste"
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

      {error != null && (
        <p className={styles.intakeError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
