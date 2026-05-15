import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import GlowButton from '@public/components/widgets/GlowButton';
import RequestModal from '@public/components/widgets/RequestModal';
import { api } from '@public/services/api';
import AvailabilityCheck from './components/AvailabilityCheck';
import HowItWorksChip from './components/HowItWorksChip';
import SponsorFAQ from './components/SponsorFAQ';
import { SPONSOR_TIERS, HOW_STEPS } from './constants';
import styles from './KeywordLandingPage.module.scss';

// KeywordLandingPage — /keyword/ (no slug). Fills the bug where the route
// rendered blank, AND becomes the in-site discoverability surface for the
// keyword-sponsorship product. Sibling motif to the Contact page (datasheet
// crop-mark corners + mono designators + PCB grid backdrop). Sections:
// 1) Spec card  2) Availability check  3) IC-chip how-it-works
// 4) Tier cards  5) FAQ accordion  6) Closing dark CTA strip.
//
// Modal is the SHARED <RequestModal> (extracted from keyword/index.tsx) so
// the two surfaces never diverge in copy or behavior. State lives here so
// the page owns the submit pipeline (api.submitKeywordRequest).

export default function KeywordLandingPage() {
  const navigate = useNavigate();

  // Modal-state mirror of keyword/index.tsx's pattern. modalKw === null means
  // closed; non-null means open with that keyword pre-filled.
  const [modalKw, setModalKw] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const closeModal = useCallback(() => {
    setModalKw(null);
    // Reset after close animation completes (matches keyword/index.tsx).
    setTimeout(() => {
      setCompanyName('');
      setEmail('');
      setMessage('');
      setFormError(null);
      setSubmitted(false);
    }, 200);
  }, []);

  // Body-scroll-lock + Esc-to-close while modal is open. Same state-machine
  // pattern as Navbar/AdminLayout drawers (CLAUDE.md "Mobile drawer
  // state-machine pattern").
  useEffect(() => {
    if (modalKw === null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [modalKw, closeModal]);

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
        keyword: modalKw || '',
        message: message.trim(),
      });
      setSubmitted(true);
    } catch (err) {
      console.error('[keyword-landing] keyword-request submit failed', err);
      setFormError('Something went wrong. Please try again later.');
    } finally {
      setSubmitting(false);
    }
  }

  // Helpers wired into AvailabilityCheck.
  const handleRequest = (kw: string) => setModalKw(kw);
  const handleViewSponsor = (slug: string) => navigate(`/keyword/${slug}`);

  return (
    // <main> satisfies the landmark-one-main a11y requirement and gives the
    // page a single semantic landmark for screen-reader navigation.
    <motion.main
      className={styles.sponsorPage}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      {/* ── Section 1 · Datasheet spec block ─────────────────────────────
         Sits OUTSIDE the .sponsorPageBody wrapper so the persistent
         <BackdropLayer />'s PCB traces show through around the white spec
         card (same window-onto-backdrop pattern as Contact's PageHeaderBand).
         The card itself is opaque #fff, but the section padding around it
         is transparent. */}
      <section className={styles.sponsorSpec} aria-labelledby="sponsor-spec-title">
        <div className={styles.sponsorSpecInner}>
          <article className={styles.sponsorSpecCard}>
            <span className={styles.sponsorSpecCrop} aria-hidden="true" />
            <header className={styles.sponsorSpecHead}>
              <span className={styles.sponsorSpecTag}>
                DATASHEET · KEYWORD-SPONSORSHIP · /REV-A
              </span>
              <h2 id="sponsor-spec-title">The short version.</h2>
              <p>
                You pay to own a search term. When a buyer searches it on Circuits.com, your
                sponsor card answers — logo, one paragraph, a buy-link, and a way to reach you.
              </p>
            </header>
            <dl className={styles.sponsorSpecRows}>
              <div>
                <dt>PRODUCT</dt>
                <dd>Keyword Sponsorship</dd>
              </div>
              <div>
                <dt>AUDIENCE</dt>
                <dd>Buyers searching for components you sell</dd>
              </div>
              <div>
                <dt>PLACEMENT</dt>
                <dd>
                  <code>circuits.com/keyword/&lt;your-keyword&gt;</code>
                </dd>
              </div>
              <div>
                <dt>EXCLUSIVITY</dt>
                <dd>One sponsor per keyword · variants bundle in</dd>
              </div>
              <div>
                <dt>SLA</dt>
                <dd>48 hours from request to live</dd>
              </div>
              <div>
                <dt>COMMITMENT</dt>
                <dd>Month-to-month, cancel before next cycle</dd>
              </div>
            </dl>
            <footer className={styles.sponsorSpecFoot}>
              <Link className={styles.sponsorSpecLink} to="/keyword/rp2040">
                See a live example: <code>/keyword/rp2040</code> &rarr;
              </Link>
              <span className={styles.sponsorSpecFootRev}>
                &copy; 2026 Circuits.com · APP-NOTE · KW-SP-001
              </span>
            </footer>
          </article>
        </div>
      </section>

      {/* ── Sections 2-5 body wrapper ─────────────────────────────────────
         All light-surface sections live inside .sponsorPageBody, which
         carries the --theme-surface-bg. The wrapper covers the lower
         portion of the BackdropLayer, while the section-1 spec area above
         stays transparent (window onto backdrop). Same pattern as About /
         Contact pages — see CLAUDE.md "Inner-page light surface-bg" gotcha. */}
      <div className={styles.sponsorPageBody}>
        {/* ── Section 2 · Availability check ──────────────────────────── */}
        <section
          className={`${styles.sponsorSection} ${styles.sponsorAvailSection}`}
          aria-labelledby="sponsor-avail-title"
        >
          <div className={styles.sponsorSectionInner}>
            <header className={styles.sponsorSectionHead}>
              <span className={styles.sponsorSectionNum}>02</span>
              <h2 id="sponsor-avail-title">Is your keyword open?</h2>
              <p>Type the term. We check live against the sponsor index — no spoilers, no waiting.</p>
            </header>
            <AvailabilityCheck
              initialKeyword=""
              onRequest={handleRequest}
              onViewSponsor={handleViewSponsor}
            />
          </div>
        </section>

        {/* ── Section 3 · How it works (IC chip) ─────────────────────── */}
        <section className={styles.sponsorSection} aria-labelledby="sponsor-how-title">
          <div className={styles.sponsorSectionInner}>
            <header className={styles.sponsorSectionHead}>
              <span className={styles.sponsorSectionNum}>03</span>
              <h2 id="sponsor-how-title">How it works.</h2>
              <p>Three pins. No phone calls. Live in two business days.</p>
            </header>
            <HowItWorksChip steps={HOW_STEPS} />
          </div>
        </section>

        {/* ── Section 4 · Tier cards ──────────────────────────────────── */}
        <section className={styles.sponsorSection} aria-labelledby="sponsor-tiers-title">
          <div className={styles.sponsorSectionInner}>
            <header className={styles.sponsorSectionHead}>
              <span className={styles.sponsorSectionNum}>04</span>
              <h2 id="sponsor-tiers-title">Pick a tier.</h2>
              <p>All tiers month-to-month. You can change at any time before the next cycle.</p>
            </header>
            <div className={styles.sponsorTiers}>
              {SPONSOR_TIERS.map((t) => (
                <article
                  key={t.id}
                  className={`${styles.sponsorTier} ${t.featured ? styles.featured : ''}`}
                >
                  <header className={styles.sponsorTierHead}>
                    <span className={styles.sponsorTierName}>{t.name}</span>
                    <span className={styles.sponsorTierPrice}>{t.price}</span>
                  </header>
                  <span className={styles.sponsorTierTag}>{t.tag}</span>
                  <ul className={styles.sponsorTierPerks}>
                    {t.perks.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  <GlowButton
                    variant={t.featured ? 'primary' : 'ghost'}
                    onClick={() => setModalKw('(any)')}
                  >
                    {t.featured ? 'Choose ' : 'Start with '}
                    {t.name}
                  </GlowButton>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ── Section 5 · FAQ ─────────────────────────────────────────── */}
        <section className={styles.sponsorSection} aria-labelledby="sponsor-faq-title">
          <div className={`${styles.sponsorSectionInner} ${styles.sponsorFaqInner}`}>
            <header className={styles.sponsorSectionHead}>
              <span className={styles.sponsorSectionNum}>05</span>
              <h2 id="sponsor-faq-title">Frequently asked.</h2>
              <p>
                Five we hear every week. Anything else,{' '}
                <Link className={styles.sponsorSpecLink} to="/contact">
                  reach a founder directly
                </Link>
                .
              </p>
            </header>
            <SponsorFAQ />
          </div>
        </section>
      </div>

      {/* ── Section 6 · Closing CTA strip (dark) ─────────────────────── */}
      <section className={styles.sponsorCtaStrip} aria-labelledby="sponsor-cta-title">
        <div className={styles.sponsorCtaInner}>
          <div>
            <span className={styles.sponsorCtaTag}>PIN-OUT · NEXT STEP</span>
            <h2 id="sponsor-cta-title">Don't see your keyword?</h2>
            <p>
              Tell us what you'd want to own. We'll come back within one business day with
              availability, options, and a price.
            </p>
          </div>
          <div className={styles.sponsorCtaActions}>
            <GlowButton variant="primary" onClick={() => setModalKw('(custom)')}>
              Request a custom keyword &rarr;
            </GlowButton>
            <GlowButton variant="ghost" onClick={() => navigate('/contact')}>
              Talk to a founder
            </GlowButton>
          </div>
        </div>
      </section>

      {/* Shared request modal */}
      <RequestModal
        open={modalKw !== null}
        keyword={modalKw || ''}
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
    </motion.main>
  );
}
