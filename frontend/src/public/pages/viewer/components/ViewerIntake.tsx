// The viewer's drop zone: a zip, a .kicad_pro, .kicad_sch files and a
// .kicad_pcb, several at once (a folder where the browser supports it). The
// example loads Glasgow revC3 (0BSD) through the SAME buildProject a drop uses.
import { useCallback, useState } from 'react';
import { useDropzone, type Accept, type FileRejection } from 'react-dropzone';
import { buildProject } from '@public/services/kicad/project';
import { KicadReadError, type KicadProject } from '@public/services/kicad/types';
import styles from '../ViewerPage.module.scss';

const ACCEPT: Accept = {
  'application/zip': ['.zip'],
  'application/octet-stream': ['.kicad_pro', '.kicad_sch', '.kicad_pcb', '.sch', '.pro'],
};

export const EXAMPLE_URL = '/samples/glasgow-revC3.zip';
export const EXAMPLE_CREDIT = 'Example: Glasgow Interface Explorer revC3, 0BSD';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function rejectionCopy(name: string): string {
  const ext = extensionOf(name);
  const what = ext === '' ? 'That file has no extension' : `That's a ${ext}`;
  return `${what} — drop the .kicad_pro, .kicad_sch and .kicad_pcb files, or a zip of the project folder.`;
}

interface ViewerIntakeProps {
  onProject: (project: KicadProject) => void;
}

export default function ViewerIntake({ onProject }: ViewerIntakeProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(
    async (files: File[]) => {
      setBusy(true);
      setError(null);
      try {
        onProject(await buildProject(files));
      } catch (err) {
        setError(err instanceof KicadReadError ? err.message : 'Those files could not be read. Drop the project folder as a zip and try again.');
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
      setError('The example project could not be loaded right now. Drop a project of your own instead.');
      setBusy(false);
    }
  }, [read]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: ACCEPT,
    multiple: true,
    noClick: true,
    noKeyboard: true,
    useFsAccessApi: false,
  });

  return (
    <div className={styles.intake}>
      <section
        {...getRootProps({ className: `${styles.drop} ${isDragActive ? styles.dropActive : ''}` })}
        aria-label="Open a KiCad project"
      >
        <input {...getInputProps()} />
        <span className={`${styles.crop} ${styles.cropTl}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropTr}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropBl}`} aria-hidden="true" />
        <span className={`${styles.crop} ${styles.cropBr}`} aria-hidden="true" />
        <p className={styles.dropLead}>
          {isDragActive ? 'Drop the project here' : 'Drop your KiCad project here, or'}
        </p>
        <div className={styles.btnRow}>
          <button type="button" className={styles.dropBtn} onClick={open} disabled={busy}>
            {busy ? 'Reading…' : 'Choose files'}
          </button>
          <button type="button" className={styles.exampleBtn} onClick={() => void loadExample()} disabled={busy}>
            Try the example project
          </button>
        </div>
        <p className={styles.formatLine}>
          .kicad_pro&ensp;.kicad_sch&ensp;.kicad_pcb&ensp;.zip&ensp;&middot;&ensp;KiCad 6 or newer
        </p>
        <p className={styles.credit}>{EXAMPLE_CREDIT}</p>
      </section>
      {error != null && (
        <p className={styles.intakeError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
