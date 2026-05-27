import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Helmet } from 'react-helmet-async';
import { Link, useNavigate } from 'react-router-dom';
import GlowButton from '@public/components/widgets/GlowButton';
import PageHeaderBand from '@public/components/layout/PageHeaderBand';
import RequestModal, { type RequestModalTier } from '@public/components/widgets/RequestModal';
import { useKeywordRequestModal } from '@public/hooks/useKeywordRequestModal';
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

  // modalKw === null means closed; non-null means open with that keyword
  // pre-filled. Tracking the keyword in the open-state lets a single source
  // of truth drive both "is open" and "what to submit".
  const [modalKw, setModalKw] = useState<string | null>(null);
  const form = useKeywordRequestModal({ logTag: 'keyword-landing' });

  const closeModal = useCallback(() => {
    setModalKw(null);
    setTimeout(form.resetAfterClose, 200);
  }, [form.resetAfterClose]);

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

  // Clicking a tier card on Section 04 pre-selects that tier AND opens the
  // modal so the picker inside the modal already reflects the user's choice.
  const handleTierCardClick = (tierId: RequestModalTier['id']) => {
    form.setSelectedTier(tierId);
    setModalKw('(any)');
  };

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
      {/* ── PageHeaderBand · v2 design parity (2026-05-16) ──────────────────
         Standard slim hero band that every inner page uses (About / Join /
         Contact / Privacy / NotFound). Page="sponsor" → green REV-A tag
         reads "REV-A · /SPONSOR". The band is transparent layout-only —
         the dark substrate + animated CircuitTraces come from the
         persistent <BackdropLayer /> at App.tsx level. Adding this slots
         /keyword into the standard inner-page contract; previously the
         page jumped straight into section 01 with no top-band signature. */}
      <Helmet>
        <title>Keyword Sponsorship — Promote Your Brand | Circuits.com</title>
        <meta name="description" content="Sponsor a keyword on Circuits.com. Own the search term your buyers type — one sponsor per keyword, live in 48 hours, month-to-month." />
        <link rel="canonical" href="https://circuits.com/keyword" />
      </Helmet>
      <PageHeaderBand
        page="sponsor"
        title="Sponsor a Keyword"
        subtitle="Own the search term your buyers actually type. One sponsor per keyword, live in 48 hours, month-to-month."
      />

      {/* ── Sections 01-05 body wrapper ───────────────────────────────────
         All light-surface sections live inside .sponsorPageBody, which
         carries the --theme-surface-bg. The PageHeaderBand above already
         serves as the PCB-window (transparent over the BackdropLayer), so
         section 01 (availability) is now inside the body wrapper alongside
         02-05 — matches v2 design's surface-bg-everywhere page layout. */}
      <div className={styles.sponsorPageBody}>
        {/* ── Section 01 · Availability check ──────────────────────────── */}
        <section
          className={`${styles.sponsorSection} ${styles.sponsorAvailSection}`}
          aria-labelledby="sponsor-avail-title"
        >
          <div className={styles.sponsorSectionInner}>
            <header className={styles.sponsorSectionHead}>
              <span className={styles.sponsorSectionNum}>01</span>
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
        {/* ── Section 02 · Datasheet spec card ─────────────────────────
           V2 design parity (2026-05-16): the spec card now uses the
           shared .sponsorSectionHead pattern with a "02" badge, and the
           title/dek live OUTSIDE the card. The card contains only the
           datasheet dl rows and footer link. */}
        <section className={styles.sponsorSection} aria-labelledby="sponsor-spec-title">
          <div className={styles.sponsorSectionInner}>
            <header className={styles.sponsorSectionHead}>
              <span className={styles.sponsorSectionNum}>02</span>
              <h2 id="sponsor-spec-title">The short version.</h2>
              <p>
                You pay to own a search term. When a buyer searches it on Circuits.com, your
                sponsor card answers — logo, one paragraph, a buy-link, and a way to reach you.
              </p>
            </header>
            <article className={styles.sponsorSpecCard}>
              <span className={styles.sponsorSpecCrop} aria-hidden="true" />
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

        {/* ── Section 03 · How it works (IC chip) ─────────────────────── */}
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

        {/* ── Section 04 · Tier cards ──────────────────────────────────── */}
        <section className={styles.sponsorSection} aria-labelledby="sponsor-tiers-title">
          <div className={styles.sponsorSectionInner}>
            <header className={styles.sponsorSectionHead}>
              <span className={styles.sponsorSectionNum}>04</span>
              <h2 id="sponsor-tiers-title">Pick a tier.</h2>
              <p>All tiers month-to-month. You can change at any time before the next cycle.</p>
            </header>
            <div className={styles.sponsorTiers}>
              {SPONSOR_TIERS.map((t) => {
                const isSelected = form.selectedTier === t.id;
                return (
                  <article
                    key={t.id}
                    className={`${styles.sponsorTier} ${t.featured ? styles.featured : ''} ${
                      isSelected ? styles.selected : ''
                    }`}
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
                    {/* V2 design parity (2026-05-16): ALL tier buttons use
                       the primary variant + uniform "Choose {Name}" label.
                       The featured Gold tier is distinguished by its outer
                       ring + ★ MOST CHOSEN ribbon, not by the button style.
                       aria-pressed announces selection state to AT users. */}
                    <GlowButton
                      variant="primary"
                      onClick={() => handleTierCardClick(t.id)}
                      aria-pressed={isSelected}
                    >
                      Choose {t.name}
                    </GlowButton>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── Section 05 · FAQ ─────────────────────────────────────────── */}
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

      {/* Shared request modal — v2 design parity: receives Name + Tier
         pre-selection so the in-modal picker mirrors whichever tier card the
         user clicked, and the success-state receipt shows the chosen tier. */}
      <RequestModal
        open={modalKw !== null}
        keyword={modalKw || ''}
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
        onSubmit={form.handleSubmit(modalKw || '')}
        onClose={closeModal}
      />
    </motion.main>
  );
}
