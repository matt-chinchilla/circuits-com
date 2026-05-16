import { useState, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import GlowButton from '@public/components/widgets/GlowButton';
import styles from './RequestModal.module.scss';

// RequestModal — shared keyword-request dialog.
// V2 design parity (2026-05-16): the modal now carries the full datasheet
// motif from Claude Design's mock — REQ tag, two-col Name/Company row,
// in-modal Tier-preference picker, and a mono receipt block in the success
// state (REQ-ID / KEYWORD / TIER / STATUS). Hosting page owns all field state
// + submit pipeline; tier props are optional so the same modal can render on
// surfaces without a tier picker (e.g., /keyword/:slug coming from a "no
// preference" call site).

// Mirrors the SPONSOR_TIERS shape from keyword-landing/constants without
// importing it (avoids a page→widget circular dep). Both call sites pass the
// constants array in as a prop.
export type RequestModalTier = {
  id: 'silver' | 'gold' | 'platinum';
  name: string;
  price: string;
};

export interface RequestModalProps {
  open: boolean;
  keyword: string;
  name: string;
  companyName: string;
  email: string;
  message: string;
  submitting: boolean;
  submitted: boolean;
  formError: string | null;
  // Tier picker is optional so the same modal can render on surfaces without
  // a tier picker (e.g., a "no preference" call site).
  tiers?: readonly RequestModalTier[];
  selectedTier?: RequestModalTier['id'] | null;
  onTierChange?: (id: RequestModalTier['id']) => void;
  onNameChange: (v: string) => void;
  onCompanyNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onMessageChange: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
}

export default function RequestModal({
  open,
  keyword,
  name,
  companyName,
  email,
  message,
  submitting,
  submitted,
  formError,
  tiers,
  selectedTier,
  onTierChange,
  onNameChange,
  onCompanyNameChange,
  onEmailChange,
  onMessageChange,
  onSubmit,
  onClose,
}: RequestModalProps) {
  // Fake REQ-ID for the success-state receipt. Generated once per modal mount
  // (= per open session) via lazy init so the value is stable across renders
  // but freshens whenever the modal reopens. Matches the design's
  // `Date.now().toString(36).toUpperCase().slice(-6)` flourish.
  const [reqId] = useState(() => Date.now().toString(36).toUpperCase().slice(-6));

  const showTierPicker = tiers && tiers.length > 0 && onTierChange;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={styles.modalOverlay}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          <motion.div
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ duration: 0.25, ease: 'easeOut' as const }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="kr-title"
          >
            <button
              className={styles.modalClose}
              onClick={onClose}
              aria-label="Close"
              type="button"
            >
              &times;
            </button>

            {submitted ? (
              <motion.div
                className={styles.success}
                initial={{ scale: 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 200, damping: 18 }}
              >
                <motion.span
                  className={styles.successMark}
                  initial={{ scale: 0, rotate: -45 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 12, delay: 0.15 }}
                  aria-hidden="true"
                >
                  &#10003;
                </motion.span>
                <h3 className={styles.successTitle} id="kr-title">
                  Request received.
                </h3>
                <p className={styles.successCopy}>
                  We&rsquo;ll confirm availability of{' '}
                  <code className={styles.codeChip}>{keyword}</code> and reach out at{' '}
                  <code className={styles.codeChip}>{email || 'your email'}</code> within one
                  business day.
                </p>
                <div className={styles.receipt} aria-label="Submission receipt">
                  <div>
                    <span>REQ-ID</span>
                    <span>KW-{reqId}</span>
                  </div>
                  <div>
                    <span>KEYWORD</span>
                    <span>{keyword}</span>
                  </div>
                  {selectedTier && (
                    <div>
                      <span>TIER</span>
                      <span>{selectedTier.toUpperCase()}</span>
                    </div>
                  )}
                  <div>
                    <span>STATUS</span>
                    <span className={styles.receiptOk}>QUEUED</span>
                  </div>
                </div>
                <GlowButton variant="primary" onClick={onClose}>
                  Close
                </GlowButton>
              </motion.div>
            ) : (
              <>
                <header className={styles.modalHeader}>
                  <span className={styles.modalTag}>REQ &middot; KEYWORD-SPONSORSHIP</span>
                  <h3 className={styles.modalTitle} id="kr-title">
                    Request <code className={styles.codeChip}>{keyword}</code>
                  </h3>
                  <p className={styles.modalIntro}>
                    Three lines and we&rsquo;ll take it from here. A founder reviews every request
                    personally.
                  </p>
                </header>

                <form onSubmit={onSubmit} noValidate>
                  {formError && <div className={styles.formError}>{formError}</div>}

                  <div className={styles.fieldRow}>
                    <div className={styles.fieldGroup}>
                      <label className={styles.label} htmlFor="kr-name">
                        Your name<span className={styles.required}>*</span>
                      </label>
                      <input
                        id="kr-name"
                        className={styles.input}
                        type="text"
                        value={name}
                        onChange={(e) => onNameChange(e.target.value)}
                        placeholder="Jane Doe"
                        autoComplete="name"
                        required
                      />
                    </div>
                    <div className={styles.fieldGroup}>
                      <label className={styles.label} htmlFor="kr-company">
                        Company<span className={styles.required}>*</span>
                      </label>
                      <input
                        id="kr-company"
                        className={styles.input}
                        type="text"
                        value={companyName}
                        onChange={(e) => onCompanyNameChange(e.target.value)}
                        placeholder="Acme Electronics"
                        autoComplete="organization"
                        required
                      />
                    </div>
                  </div>

                  <div className={styles.fieldGroup}>
                    <label className={styles.label} htmlFor="kr-email">
                      Email<span className={styles.required}>*</span>
                    </label>
                    <input
                      id="kr-email"
                      className={styles.input}
                      type="email"
                      value={email}
                      onChange={(e) => onEmailChange(e.target.value)}
                      placeholder="sales@acme.com"
                      autoComplete="email"
                      required
                    />
                  </div>

                  {showTierPicker && (
                    <div className={styles.fieldGroup}>
                      <span className={styles.label} id="kr-tier-label">
                        Tier preference
                      </span>
                      <div
                        className={styles.tierPicker}
                        role="radiogroup"
                        aria-labelledby="kr-tier-label"
                      >
                        {tiers.map((t) => {
                          const isOn = selectedTier === t.id;
                          return (
                            <button
                              key={t.id}
                              type="button"
                              className={`${styles.tierPick} ${isOn ? styles.tierPickOn : ''}`}
                              onClick={() => onTierChange(t.id)}
                              aria-pressed={isOn}
                            >
                              <span className={styles.tierPickName}>{t.name}</span>
                              <span className={styles.tierPickPrice}>{t.price}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className={styles.fieldGroup}>
                    <label className={styles.label} htmlFor="kr-message">
                      Message
                    </label>
                    <textarea
                      id="kr-message"
                      className={styles.textarea}
                      value={message}
                      onChange={(e) => onMessageChange(e.target.value)}
                      placeholder="Tell us about your interest in this keyword..."
                    />
                  </div>

                  <div className={styles.actions}>
                    <button type="button" className={styles.cancelBtn} onClick={onClose}>
                      Cancel
                    </button>
                    <GlowButton type="submit" variant="primary" disabled={submitting}>
                      {submitting ? 'Submitting...' : 'Submit Request →'}
                    </GlowButton>
                  </div>
                </form>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
