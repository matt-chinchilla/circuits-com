// frontend/src/admin/components/ImageUploadField.tsx
import { useId, useRef, useState, type ReactElement } from 'react';
import { LogoCropperModal } from '@shared/components/LogoCropperModal';
import { canvasToDataUrl, loadImage } from '@shared/utils/image';
import { safeImageUrl } from '@shared/utils/url';
import { adminApi } from '@admin/services/adminApi';
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
  const [fetchingUrl, setFetchingUrl] = useState(false);
  // Last URL auto-fetched on commit — blocks a blur/Enter loop after a cancel.
  const lastFetchedRef = useRef<string | null>(null);
  // Auto-fetch fires ONLY after the user actually edited the field — without
  // this, tab-through or blur of a PREFILLED stored URL popped the cropper
  // modal uninvited (review finding, 2026-07-31). The explicit button ignores it.
  const urlDirtyRef = useRef(false);
  const errId = useId();
  const safePreview = safeImageUrl(value);
  const urlValue = (value ?? '').startsWith('data:') ? '' : (value ?? '');
  const fetchableUrl = /^https?:\/\/\S+$/i.test(urlValue.trim());

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
    const original = pendingFile;
    setPendingFile(null);
    resetFileInput();
    const result = canvasToDataUrl(canvas);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChange(result.dataUrl);
    if (!onCroppedCanvas) return;
    // Brand colors read the FULL ORIGINAL logo, not the crop window: a wide
    // wordmark's accent often sits outside the cover-crop (the Avnet green
    // mark lived at the far left → the crop-fed extractor answered gray).
    if (original) {
      const url = URL.createObjectURL(original);
      loadImage(url)
        .then((img) => {
          // Cap the raster — extraction samples at 64px anyway, and an
          // uncapped 40MP photo would briefly hold a ~160MB backing store.
          const MAX_EDGE = 1024;
          const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
          const full = document.createElement('canvas');
          full.width = Math.max(1, Math.round(img.naturalWidth * scale));
          full.height = Math.max(1, Math.round(img.naturalHeight * scale));
          full.getContext('2d')?.drawImage(img, 0, 0, full.width, full.height);
          onCroppedCanvas(full);
        })
        .catch(() => onCroppedCanvas(canvas))
        .finally(() => URL.revokeObjectURL(url));
    } else {
      onCroppedCanvas(canvas);
    }
  };

  const cancelCrop = () => {
    setPendingFile(null);
    resetFileInput();
  };

  // Re-open the cropper on the CURRENTLY STORED image — the path for legacy
  // rectangular data-URL wordmarks that pre-date the cropper (and for
  // re-cropping any upload): zoom/pan/shape/background against the same modal.
  const recropStored = async () => {
    if (!safePreview || !(value ?? '').startsWith('data:')) return;
    setError(null);
    try {
      const blob = await (await fetch(value as string)).blob();
      setPendingFile(new File([blob], 'logo', { type: blob.type || 'image/png' }));
    } catch {
      setError('Could not reopen the stored image for cropping.');
    }
  };

  // Pull a pasted URL through the admin image-proxy (same-origin bytes), then
  // run the SAME cropper -> brand-color flow as a file upload. A direct
  // cross-origin <img> would taint the canvas, which is why the URL path
  // historically skipped the cropper. On failure the raw URL stays stored —
  // exactly the old behavior.
  const fetchAndCrop = async (force = false) => {
    const raw = urlValue.trim();
    if (!/^https?:\/\/\S+$/i.test(raw) || fetchingUrl) return;
    if (!force && (!urlDirtyRef.current || raw === lastFetchedRef.current)) return;
    urlDirtyRef.current = false;
    lastFetchedRef.current = raw;
    setFetchingUrl(true);
    setError(null);
    try {
      const blob = await adminApi.fetchImageForCrop(raw);
      setPendingFile(new File([blob], 'logo', { type: blob.type || 'image/png' }));
    } catch {
      setError(
        "Couldn't fetch that image for cropping (the host may block it) — the URL was kept as-is.",
      );
    } finally {
      setFetchingUrl(false);
    }
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
            {(value ?? '').startsWith('data:') && safePreview && (
              <button
                type="button"
                className={styles.uploadBtn}
                onClick={() => { void recropStored(); }}
              >
                Zoom &amp; crop
              </button>
            )}
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
            value={urlValue}
            onChange={(e) => { if (error) setError(null); urlDirtyRef.current = true; onChange(e.target.value); }}
            onBlur={() => { void fetchAndCrop(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void fetchAndCrop(); } }}
            placeholder="…or paste an image URL"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={error ? errId : undefined}
          />
          {fetchableUrl && (
            <button
              type="button"
              className={styles.uploadBtn}
              disabled={fetchingUrl}
              onClick={() => { void fetchAndCrop(true); }}
            >
              {fetchingUrl ? 'Fetching…' : 'Crop & extract colors'}
            </button>
          )}
        </div>
      </div>
      {!error && (
        <div className={styles.hint}>
          {hint ? `${hint} ` : ''}Logos crop to a circle or rounded square — pasted
          URLs are fetched so you can crop &amp; pick brand colors too.
        </div>
      )}
      {error && <div className={styles.error} id={errId} role="alert">{error}</div>}
      {pendingFile && (
        <LogoCropperModal file={pendingFile} onApply={applyCrop} onCancel={cancelCrop} />
      )}
    </div>
  );
}
