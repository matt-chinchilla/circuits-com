import { useEffect, useState } from 'react';
import styles from './Wizard.module.scss';
import { WI } from './icons';
import type { Flow, PreviewStep } from './types';
import { adminApi } from '@admin/services/adminApi';
import { getRoute } from './helpers';
import { PREVIEW_CATEGORY_SLUG } from './flows';

interface LivePreviewModalProps {
  step: PreviewStep;
  flow: Flow;
  onClose: () => void;
  onNext: () => void;
}

// macOS-style window framing an iframe of the public site. For the
// add-supplier flow we auto-feature the just-created supplier into the
// preview category BEFORE loading the iframe — that way the user sees
// their demo supplier in the Featured slot and the propagation story
// is visceral. The cleanup step (supplier delete) cascades the
// CategorySupplier row away naturally.
export default function LivePreviewModal({
  step,
  flow,
  onClose,
  onNext,
}: LivePreviewModalProps) {
  const [loading, setLoading] = useState(true);
  const [iframeKey, setIframeKey] = useState(0);

  useEffect(() => {
    // Best-effort: feature the demo supplier on the preview category.
    // We derive the supplier ID from the current admin route — by the
    // time the preview step fires we should be at /admin/suppliers/<id>.
    const supplierId = supplierIdFromRoute();
    const categorySlug = step.preview.arg ?? PREVIEW_CATEGORY_SLUG;
    const shouldFeature = flow.id === 'add-supplier' && !!supplierId;

    if (!shouldFeature) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    adminApi
      .featureSupplierInCategory(supplierId, categorySlug)
      .catch(() => {
        // Featured-toggle is best-effort. Fall through to iframe anyway —
        // the user sees the public site even without their supplier in
        // the Featured slot, and the coachmark text still describes the
        // intended propagation behavior.
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        // Force iframe reload so it picks up the freshly-featured supplier
        // (some browsers cache identical srcs across re-renders).
        setIframeKey((k) => k + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [step, flow.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const iframeSrc = previewUrl(step);
  const previewLabel = previewLabelFor(step);
  const body = typeof step.body === 'function' ? step.body() : step.body;

  return (
    <div className={styles.previewBackdrop} onClick={onClose}>
      <div className={styles.previewFrame} onClick={(e) => e.stopPropagation()}>
        <div className={styles.previewBar}>
          <div className={styles.previewTraffic}>
            <span />
            <span />
            <span />
          </div>
          <div className={styles.previewUrl}>
            <i className="ph-light ph-lock" aria-hidden="true" />
            <span>{previewLabel}</span>
          </div>
          <button type="button" className={styles.previewClose} onClick={onClose}>
            <WI.ArrowRight /> Back to admin
          </button>
        </div>
        {loading ? (
          <div className={styles.previewLoading}>
            <div>Featuring your demo supplier on the live site&hellip;</div>
          </div>
        ) : (
          <iframe
            key={iframeKey}
            src={iframeSrc}
            title={`Live site preview: ${previewLabel}`}
            className={styles.previewIframe}
          />
        )}
      </div>
      {/* The tip sits OUTSIDE .previewFrame (positioned absolutely below it).
          Without stopPropagation, clicks on the "Got it" button bubble up
          to the .previewBackdrop which fires onClose — and since both
          onClose and onNext are bound to advance() in WizardApp, the
          wizard would advance twice and skip the next step. Matches the
          guard on .previewFrame above. */}
      <div className={styles.previewTip} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{step.title}</div>
        <div>{body}</div>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={onNext}
        >
          Got it <WI.ArrowRight />
        </button>
      </div>
    </div>
  );
}

function supplierIdFromRoute(): string | null {
  const m = getRoute().match(/^suppliers\/([^/]+)$/);
  return m ? m[1] : null;
}

function previewUrl(step: PreviewStep): string {
  const { page, arg } = step.preview;
  if (page === 'category' && arg) return `/category/${arg}`;
  if (page === 'home') return '/';
  return arg ? `/${page}/${arg}` : `/${page}`;
}

function previewLabelFor(step: PreviewStep): string {
  const { page, arg } = step.preview;
  if (page === 'category' && arg) return `circuitcenter.ai/category/${arg}`;
  if (page === 'home') return 'circuitcenter.ai/';
  return arg ? `circuitcenter.ai/${page}/${arg}` : `circuitcenter.ai/${page}`;
}
