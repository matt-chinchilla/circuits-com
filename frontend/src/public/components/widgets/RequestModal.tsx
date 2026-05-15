import type { FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import GlowButton from '@public/components/widgets/GlowButton';
import styles from './RequestModal.module.scss';

// RequestModal — shared keyword-request dialog.
// Extracted from keyword/index.tsx so the new /keyword/ landing page and the
// existing /keyword/:keyword detail page share the same modal contract. The
// hosting page owns all state (form fields, submitting/submitted/error) and
// passes it down so both surfaces can keep their own analytics + submit
// pipelines without diverging copy. AnimatePresence stays inside the modal
// (presence-driven enter/exit on `open`) — gating at the parent on `open`
// would re-mount the component every time and lose the exit transition.

export interface RequestModalProps {
  open: boolean;
  keyword: string;
  companyName: string;
  email: string;
  message: string;
  submitting: boolean;
  submitted: boolean;
  formError: string | null;
  onCompanyNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onMessageChange: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
}

export default function RequestModal({
  open,
  keyword,
  companyName,
  email,
  message,
  submitting,
  submitted,
  formError,
  onCompanyNameChange,
  onEmailChange,
  onMessageChange,
  onSubmit,
  onClose,
}: RequestModalProps) {
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
          >
            <div className={styles.modalHeader}>
              <h2 className={styles.modalTitle}>
                Request Keyword: &ldquo;{keyword}&rdquo;
              </h2>
              <button
                className={styles.modalClose}
                onClick={onClose}
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            {submitted ? (
              <motion.div
                className={styles.success}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 200, damping: 15 }}
              >
                <motion.span
                  className={styles.successIcon}
                  initial={{ scale: 0, rotate: -45 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 12, delay: 0.15 }}
                  aria-hidden="true"
                >
                  &#9989;
                </motion.span>
                <h3 className={styles.successTitle}>Request Submitted!</h3>
                <p className={styles.successSubtitle}>
                  We&rsquo;ll review your request and get back to you soon.
                </p>
              </motion.div>
            ) : (
              <form onSubmit={onSubmit}>
                {formError && (
                  <div className={styles.formError}>{formError}</div>
                )}

                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="kr-company">
                    Company Name<span className={styles.required}>*</span>
                  </label>
                  <input
                    id="kr-company"
                    className={styles.input}
                    type="text"
                    value={companyName}
                    onChange={(e) => onCompanyNameChange(e.target.value)}
                    placeholder="Your company name"
                    required
                  />
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
                    placeholder="you@company.com"
                    required
                  />
                </div>

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
                  <button
                    type="button"
                    className={styles.cancelBtn}
                    onClick={onClose}
                  >
                    Cancel
                  </button>
                  <GlowButton type="submit" variant="gold" disabled={submitting}>
                    {submitting ? 'Submitting...' : 'Submit Request'}
                  </GlowButton>
                </div>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
