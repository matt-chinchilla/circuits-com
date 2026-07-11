import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampOffset, coverScale, MAX_ZOOM, MIN_ZOOM, OUTPUT_SIZE, sourceRect } from './geometry';
import styles from './LogoCropperModal.module.scss';

interface LogoCropperModalProps {
  file: File;
  title?: string;
  onApply: (canvas: HTMLCanvasElement) => void;
  onCancel: () => void;
}

const FRAME_MAX = 320; // upper bound; the RENDERED size (frameSize state) is the geometry authority

export function LogoCropperModal({ file, title = 'Position your logo', onApply, onCancel }: LogoCropperModalProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [frameSize, setFrameSize] = useState(FRAME_MAX);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [loadError, setLoadError] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{ id: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const scale = dims ? coverScale(dims.w, dims.h, frameSize) * zoom : 1;

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setDims(null);
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    setLoadError(false);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // The rendered frame is the geometry authority (CSS caps it on narrow screens)
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setFrameSize(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loadError]);

  // Re-clamp the pan whenever the constraint inputs change
  useEffect(() => {
    if (!dims) return;
    const s = coverScale(dims.w, dims.h, frameSize) * zoom;
    setOffset((o) => {
      const c = clampOffset(dims.w, dims.h, frameSize, s, o.x, o.y);
      return c.offsetX === o.x && c.offsetY === o.y ? o : { x: c.offsetX, y: c.offsetY };
    });
  }, [dims, frameSize, zoom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const nodes = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const applyZoom = useCallback((next: number) => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  }, []);

  // Wheel zoom: subscribe once (zoomRef avoids stale-closure step-dropping on fast wheels)
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyZoom(zoomRef.current * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, loadError]);

  const onImgLoad = () => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) { setLoadError(true); return; }
    setDims({ w: img.naturalWidth, h: img.naturalHeight });
    sliderRef.current?.focus();
  };

  const pan = (x: number, y: number) => {
    if (!dims) return;
    const c = clampOffset(dims.w, dims.h, frameSize, scale, x, y);
    setOffset({ x: c.offsetX, y: c.offsetY });
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dims) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    pan(d.baseX + (e.clientX - d.startX), d.baseY + (e.clientY - d.startY));
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  };

  const onArrows = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 20 : 5;
    if (e.key === 'ArrowLeft') { e.preventDefault(); pan(offset.x - step, offset.y); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pan(offset.x + step, offset.y); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pan(offset.x, offset.y - step); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); pan(offset.x, offset.y + step); }
  };

  const apply = () => {
    const img = imgRef.current;
    if (!img || !dims) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) { onCancel(); return; }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    const rect = sourceRect(dims.w, dims.h, frameSize, scale, offset.x, offset.y);
    ctx.drawImage(img, rect.sx, rect.sy, rect.size, rect.size, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    onApply(canvas);
  };

  return createPortal(
    <div className={styles.scrim} onClick={onCancel} role="presentation">
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className={styles.title}>{title}</h2>
        {loadError ? (
          <p className={styles.error}>Couldn&rsquo;t read that image. Try a PNG, JPEG or WebP file.</p>
        ) : (
          <div
            ref={frameRef}
            className={styles.frame}
            tabIndex={0}
            aria-label="Logo position. Use arrow keys to move, or drag."
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onArrows}
          >
            {imageUrl && (
              <img
                ref={imgRef}
                src={imageUrl}
                alt=""
                draggable={false}
                onLoad={onImgLoad}
                onError={() => setLoadError(true)}
                className={styles.image}
                style={dims
                  ? { width: dims.w * scale, height: dims.h * scale, transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)` }
                  : { visibility: 'hidden' }}
              />
            )}
            <div className={styles.mask} aria-hidden="true" />
          </div>
        )}
        <label className={styles.zoomRow}>
          <span>Zoom</span>
          <input
            ref={sliderRef}
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!dims}
            onChange={(e) => applyZoom(Number(e.target.value))}
            aria-label="Zoom"
          />
        </label>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>Cancel</button>
          <button type="button" className={styles.apply} onClick={apply} disabled={!dims || loadError}>Apply</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
