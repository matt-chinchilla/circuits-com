// frontend/src/admin/components/ImageUploadField.tsx
import { useId, useRef, useState, type ReactElement } from 'react';
import { LogoCropperModal } from '@shared/components/LogoCropperModal';
import { canvasToDataUrl } from '@shared/utils/image';
import { safeImageUrl } from '@shared/utils/url';
import styles from './ImageUploadField.module.scss';

interface ImageUploadFieldProps {
  id: string;
  label: string;
  value: string | null;
  onChange: (next: string) => void;
  hint?: string;
  // Fired with the freshly cropped canvas AFTER a successful onChange — lets a
  // host chain the brand-color modal off the same canvas without re-decoding
  // the data-URL. Skipped when the encode fails (onChange never ran).
  onCroppedCanvas?: (canvas: HTMLCanvasElement) => void;
}

// Dual-path image input: upload a file (downscaled to a data-URL) OR paste a
// hosted URL. Both write the same `value`. The preview uses safeImageUrl so a
// hostile pasted string never reaches an <img src> here either.
export default function ImageUploadField({
  id, label, value, onChange, hint, onCroppedCanvas,
}: ImageUploadFieldProps): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errId = useId();
  const safePreview = safeImageUrl(value);

  const resetFileInput = () => { if (fileRef.current) fileRef.current.value = ''; }; // allow re-picking the same file

  const onPick = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith('image/') || file.size === 0) {
      setError('Please choose an image file.');
      resetFileInput();
      return;
    }
    setPendingFile(file);
  };

  const applyCrop = (canvas: HTMLCanvasElement) => {
    setPendingFile(null);
    resetFileInput();
    const result = canvasToDataUrl(canvas);
    if (result.ok) {
      onChange(result.dataUrl);
      onCroppedCanvas?.(canvas);
    } else {
      setError(result.error);
    }
  };

  const cancelCrop = () => {
    setPendingFile(null);
    resetFileInput();
  };

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
              aria-describedby={error ? errId : undefined}
            >
              {value ? 'Replace image' : 'Upload image'}
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
      {!error && (
        <div className={styles.hint}>
          {hint ? `${hint} ` : ''}Logos are cropped to a circular frame.
        </div>
      )}
      {error && <div className={styles.error} id={errId} role="alert">{error}</div>}
      {pendingFile && (
        <LogoCropperModal file={pendingFile} onApply={applyCrop} onCancel={cancelCrop} />
      )}
    </div>
  );
}
