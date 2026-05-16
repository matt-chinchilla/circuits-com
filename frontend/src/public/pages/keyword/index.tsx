import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import GlowButton from '@public/components/widgets/GlowButton';
import RequestModal from '@public/components/widgets/RequestModal';
import { useKeywordRequestModal } from '@public/hooks/useKeywordRequestModal';
import { api } from '@public/services/api';
import { SPONSOR_TIERS } from '@public/pages/keyword-landing/constants';
import type { Sponsor } from '@public/types/sponsor';
import styles from './KeywordSponsorPage.module.scss';

export default function KeywordSponsorPage() {
  const { keyword } = useParams<{ keyword: string }>();
  const [sponsor, setSponsor] = useState<Sponsor | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const form = useKeywordRequestModal({ logTag: 'keyword/:keyword' });

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

  function closeModal() {
    setModalOpen(false);
    setTimeout(form.resetAfterClose, 200);
  }

  const modal = (
    <RequestModal
      open={modalOpen}
      keyword={keyword || ''}
      name={form.name}
      companyName={form.companyName}
      email={form.email}
      message={form.message}
      submitting={form.submitting}
      submitted={form.submitted}
      formError={form.formError}
      tiers={SPONSOR_TIERS}
      selectedTier={form.selectedTier}
      onTierChange={form.setSelectedTier}
      onNameChange={form.setName}
      onCompanyNameChange={form.setCompanyName}
      onEmailChange={form.setEmail}
      onMessageChange={form.setMessage}
      onSubmit={form.handleSubmit(keyword || '')}
      onClose={closeModal}
    />
  );

  // ─── Loading state ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        transition={{ duration: 0.15, ease: 'easeInOut' }}
      >
        <div className={styles.loading}>
          <div className={styles.spinner} />
          <p className={styles.loadingText}>Loading sponsor...</p>
        </div>
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
        <div className={styles.errorState}>
          <h1 className={styles.errorTitle}>Something went wrong</h1>
          <p className={styles.errorText}>{error}</p>
          <Link to="/">
            <GlowButton variant="primary">Back to Home</GlowButton>
          </Link>
        </div>
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

        {modal}
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

      {/* Gold hero */}
      <section className={styles.hero}>
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

      {modal}
    </motion.div>
  );
}
