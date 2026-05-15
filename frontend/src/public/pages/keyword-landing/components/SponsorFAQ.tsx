import { useState } from 'react';
import { SPONSOR_FAQS } from '../constants';
import styles from './SponsorFAQ.module.scss';

// SponsorFAQ — single-open accordion. First Q open by default (matches the
// design). Built on real <button>s w/ aria-expanded so screen readers get the
// state; the answer wrapper uses max-height + aria-hidden so collapsed text
// stays out of the AT tree without losing the smooth transition.

export default function SponsorFAQ() {
  const [open, setOpen] = useState(0);

  return (
    <div className={styles.sponsorFaqList}>
      {SPONSOR_FAQS.map((f, i) => {
        const isOpen = open === i;
        const num = String(i + 1).padStart(2, '0');
        return (
          <div
            key={f.q}
            className={`${styles.sponsorFaqItem} ${isOpen ? styles.open : ''}`}
          >
            <button
              className={styles.sponsorFaqQ}
              onClick={() => setOpen(isOpen ? -1 : i)}
              aria-expanded={isOpen}
              type="button"
            >
              <span className={styles.sponsorFaqNum}>Q.{num}</span>
              <span className={styles.sponsorFaqQText}>{f.q}</span>
              <span className={styles.sponsorFaqToggle} aria-hidden="true">
                {isOpen ? '−' : '+'}
              </span>
            </button>
            <div className={styles.sponsorFaqAWrap} aria-hidden={!isOpen}>
              <p className={styles.sponsorFaqA}>{f.a}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
