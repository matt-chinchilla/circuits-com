import { useEffect, useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import Navbar from '../components/layout/Navbar';
import Footer from '../components/layout/Footer';
import GlowButton from '../components/shared/GlowButton';
import { api } from '../services/api';
import type { Sponsor } from '../types/sponsor';
import CircuitTraces from '../components/shared/CircuitTraces';
import styles from './KeywordSponsorPage.module.scss';

export default function KeywordSponsorPage() {
  const { keyword } = useParams<{ keyword: string }>();
  const [sponsor, setSponsor] = useState<Sponsor | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!keyword) return;
    setLoading(true);
    setError(null);
    setNotFound(false);

    api.getSponsorByKeyword(keyword)
      .then((data) => setSponsor(data))
      .catch((err) => {
        if (err?.response?.status === 404) {
          setNotFound(true);
        } else {
          setError('Failed to load sponsor data. Please try again later.');
        }
      })
      .finally(() => setLoading(false));
  }, [keyword]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!companyName.trim() || !email.trim()) {
      setFormError('Company name and email are required.');
      return;
    }

    setSubmitting(true);
    try {
      await api.submitKeywordRequest({
        company_name: companyName.trim(),
        email: email.trim(),
        keyword: keyword || '',
        message: message.trim(),
      });
      setSubmitted(true);
    } catch {
      setFormError('Something went wrong. Please try again later.');
    } finally {
      setSubmitting(false);
    }
  }

  function closeModal() {
    setModalOpen(false);
    // Reset form after close animation
    setTimeout(() => {
      setCompanyName('');
      setEmail('');
      setMessage('');
      setFormError(null);
      setSubmitted(false);
    }, 200);
  }

  // ─── Loading state ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        transition={{ duration: 0.15, ease: 'easeInOut' }}
      >
        <Navbar />
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <p className={styles.loadingText}>Loading sponsor...</p>
        </div>
        <Footer />
      </motion.div>
    );
  }

  // ─── Error state ─────────────────────────────────────────────────────────

  if (error) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        transition={{ duration: 0.15, ease: 'easeInOut' }}
      >
        <Navbar />
        <div className={styles.errorState}>
          <h1 className={styles.errorTitle}>Something went wrong</h1>
          <p className={styles.errorText}>{error}</p>
          <Link to="/">
            <GlowButton variant="primary">Back to Home</GlowButton>
          </Link>
        </div>
        <Footer />
      </motion.div>
    );
  }

  // ─── Not-found / unclaimed keyword ───────────────────────────────────────

  if (notFound || !sponsor) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        transition={{ duration: 0.15, ease: 'easeInOut' }}
      >
        <Navbar />

        <div className={styles.notFound}>
          <motion.span
            className={styles.notFoundIcon}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 12 }}
            aria-hidden="true"
          >
            &#128273;
          </motion.span>
          <h1 className={styles.notFoundTitle}>
            Keyword &ldquo;{keyword}&rdquo; is Available
          </h1>
          <p className={styles.notFoundText}>
            No sponsor has claimed this keyword yet. Want your company to appear
            here? Request this keyword and reach buyers searching for{' '}
            <strong>{keyword}</strong>.
          </p>
          <GlowButton variant="gold" onClick={() => setModalOpen(true)}>
            Request This Keyword
          </GlowButton>
        </div>

        {/* Request modal (shared) */}
        <RequestModal
          open={modalOpen}
          keyword={keyword || ''}
          companyName={companyName}
          email={email}
          message={message}
          submitting={submitting}
          submitted={submitted}
          formError={formError}
          onCompanyNameChange={setCompanyName}
          onEmailChange={setEmail}
          onMessageChange={setMessage}
          onSubmit={handleSubmit}
          onClose={closeModal}
        />

        <Footer />
      </motion.div>
    );
  }

  // ─── Main sponsor page ──────────────────────────────────────────────────

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' }}
    >
      <Navbar />

      {/* Gold hero */}
      <section className={styles.hero}>
        <CircuitTraces />
        <div className={styles.heroInner}>
          <motion.span
            className={styles.badge}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            &#9733; KEYWORD SPONSOR
          </motion.span>

          {sponsor.image_url && (
            <motion.div
              className={styles.logoWrap}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, ease: 'easeOut', delay: 0.05 }}
            >
              <img
                src={sponsor.image_url}
                alt={`${sponsor.supplier_name} logo`}
                className={styles.logo}
              />
            </motion.div>
          )}

          <motion.h1
            className={styles.heroTitle}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
          >
            {sponsor.supplier_name}
          </motion.h1>

          {sponsor.description && (
            <motion.p
              className={styles.heroDescription}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.18, ease: 'easeOut' }}
            >
              {sponsor.description}
            </motion.p>
          )}

          <motion.div
            className={styles.heroContact}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.25 }}
          >
            {sponsor.phone && (
              <a href={`tel:${sponsor.phone}`} className={styles.heroLink}>
                &#128222; {sponsor.phone}
              </a>
            )}
            {sponsor.website && (
              <a
                href={sponsor.website}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.heroLink}
              >
                &#127760; Visit Website
              </a>
            )}
          </motion.div>
        </div>
      </section>

      {/* CTA section */}
      <section className={styles.ctaSection}>
        <div className={styles.ctaInner}>
          <motion.h2
            className={styles.ctaTitle}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4 }}
          >
            Want to Sponsor a Keyword?
          </motion.h2>
          <motion.p
            className={styles.ctaSubtitle}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: 0.08 }}
          >
            Get your company in front of buyers who search for specific
            electronic component keywords. Own a keyword and be the first result.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: 0.16 }}
          >
            <GlowButton variant="gold" onClick={() => setModalOpen(true)}>
              Request a Keyword
            </GlowButton>
          </motion.div>
        </div>
      </section>

      {/* Request modal */}
      <RequestModal
        open={modalOpen}
        keyword={keyword || ''}
        companyName={companyName}
        email={email}
        message={message}
        submitting={submitting}
        submitted={submitted}
        formError={formError}
        onCompanyNameChange={setCompanyName}
        onEmailChange={setEmail}
        onMessageChange={setMessage}
        onSubmit={handleSubmit}
        onClose={closeModal}
      />

      <Footer />
    </motion.div>
  );
}

// ─── Request keyword modal ────────────────────────────────────────────────

interface RequestModalProps {
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

function RequestModal({
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
            transition={{ duration: 0.25, ease: 'easeOut' }}
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
