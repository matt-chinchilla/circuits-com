// frontend/src/admin/components/ImageUploadField.tsx
import { useId, useRef, useState, type ReactElement } from 'react';
import { fileToDataUrl } from '@shared/utils/image';
import { safeImageUrl } from '@shared/utils/url';
import styles from './ImageUploadField.module.scss';

interface ImageUploadFieldProps {
  id: string;
  label: string;
  value: string | null;
  onChange: (next: string) => void;
  hint?: string;
}

// Dual-path image input: upload a file (downscaled to a data-URL) OR paste a
// hosted URL. Both write the same `value`. The preview uses safeImageUrl so a
// hostile pasted string never reaches an <img src> here either.
export default function ImageUploadField({
  id, label, value, onChange, hint,
}: ImageUploadFieldProps): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errId = useId();
  const safePreview = safeImageUrl(value);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    const result = await fileToDataUrl(file);
    setBusy(false);
    if (result.ok) onChange(result.dataUrl);
    else setError(result.error);
    if (fileRef.current) fileRef.current.value = ''; // allow re-picking the same file
  }

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <div className={styles.row}>
        <div className={styles.previewBox} aria-hidden={!safePreview}>
          {safePreview ? (
            <img className={styles.preview} src={safePreview} alt={`${label} preview`} />
          ) : (
            <span className={styles.previewEmpty}>No image</span>
          )}
        </div>
        <div className={styles.controls}>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className={styles.fileInput}
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <div className={styles.btnRow}>
            <button
              type="button"
              className={styles.uploadBtn}
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              aria-describedby={error ? errId : undefined}
            >
              {busy ? 'Processing…' : value ? 'Replace image' : 'Upload image'}
            </button>
            {value && (
              <button
                type="button"
                className={styles.clearBtn}
                onClick={() => { setError(null); onChange(''); }}
              >
                Clear
              </button>
            )}
          </div>
          <input
            id={id}
            type="text"
            inputMode="url"
            className={styles.urlInput}
            value={(value ?? '').startsWith('data:') ? '' : (value ?? '')}
            onChange={(e) => { if (error) setError(null); onChange(e.target.value); }}
            placeholder="…or paste an image URL"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={error ? errId : undefined}
          />
        </div>
      </div>
      {hint && !error && <div className={styles.hint}>{hint}</div>}
      {error && <div className={styles.error} id={errId} role="alert">{error}</div>}
    </div>
  );
}
