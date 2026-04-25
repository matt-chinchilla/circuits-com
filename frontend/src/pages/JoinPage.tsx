import { useMemo, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import Footer from '../components/layout/Footer';
import PageHeaderBand from '../components/layout/PageHeaderBand';
import GlowButton from '../components/shared/GlowButton';
import { useCategories } from '../hooks/useCategories';
import { api } from '../services/api';
import styles from './JoinPage.module.scss';

interface JoinTier {
  id: 'silver' | 'gold' | 'platinum';
  name: string;
  price: string;
  tag: string;
  perks: string[];
  featured: boolean;
}

const JOIN_TIERS: JoinTier[] = [
  {
    id: 'silver',
    name: 'Silver',
    price: '$0',
    tag: 'Free listing',
    perks: [
      'Standard listing in your category',
      'Up to 25 part numbers',
      'Email-only contact link',
    ],
    featured: false,
  },
  {
    id: 'gold',
    name: 'Gold',
    price: '$249/mo',
    tag: 'Most chosen',
    perks: [
      'Priority placement in category',
      'Unlimited part numbers',
      'Phone + website + email',
      'Monthly traffic report',
    ],
    featured: true,
  },
  {
    id: 'platinum',
    name: 'Platinum',
    price: '$849/mo',
    tag: 'Featured partner',
    perks: [
      'Top-of-page sponsor block',
      'Cross-category placement',
      'Dedicated account manager',
      'API for live stock sync',
    ],
    featured: false,
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+\..+/;

export default function JoinPage() {
  const { categories } = useCategories();

  // Real form state — preserved from prior version (POSTed to api.submitJoin).
  const [companyName, setCompanyName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [message, setMessage] = useState('');

  // Bundle additions — tier picker + terms checkbox.
  const [tier, setTier] = useState<JoinTier['id']>('gold');
  const [agreedTerms, setAgreedTerms] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailOk = useMemo(() => EMAIL_RE.test(email.trim()), [email]);
  const websiteOk = useMemo(
    () => !website || URL_RE.test(website.trim()),
    [website],
  );

  const completion = useMemo(() => {
    const checks = [
      Boolean(companyName.trim()),
      Boolean(contactPerson.trim()),
      Boolean(email.trim()) && emailOk,
      Boolean(phone.trim()),
      Boolean(website.trim()) && websiteOk,
      selectedCategories.length > 0,
      agreedTerms,
    ];
    const filled = checks.filter(Boolean).length;
    return Math.round((filled / checks.length) * 100);
  }, [
    companyName,
    contactPerson,
    email,
    emailOk,
    phone,
    website,
    websiteOk,
    selectedCategories,
    agreedTerms,
  ]);

  function toggleCategory(slug: string) {
    setSelectedCategories((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!companyName.trim() || !email.trim()) {
      setError('Company name and email are required.');
      return;
    }
    if (!emailOk) {
      setError('Please enter a valid email.');
      return;
    }
    if (website && !websiteOk) {
      setError('Website must start with http:// or https://');
      return;
    }
    if (!agreedTerms) {
      setError('Please accept the listing terms.');
      return;
    }

    setSubmitting(true);
    try {
      await api.submitJoin({
        company_name: companyName.trim(),
        contact_person: contactPerson.trim(),
        email: email.trim(),
        phone: phone.trim(),
        website: website.trim(),
        categories_of_interest: selectedCategories,
        tier,
        message: message.trim(),
      });
      setSubmitted(true);
    } catch (err) {
      // Log the upstream failure so production debugging has a trail; user-
      // facing message stays generic to avoid leaking API internals.
      console.error('[JoinPage] api.submitJoin failed', err);
      setError('Something went wrong. Please try again later.');
    } finally {
      setSubmitting(false);
    }
  }

  const activeTier = JOIN_TIERS.find((t) => t.id === tier) ?? JOIN_TIERS[1];
  const appId = useMemo(
    () => `JC-${Date.now().toString(36).toUpperCase().slice(-6)}`,
    [],
  );

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <PageHeaderBand
        page="join"
        title="Join Circuits.com"
        subtitle="Get your company listed in our electronic components directory."
      />

      <div className={styles.page}>
        {submitted ? (
          <div className={styles.success}>
            <div className={styles.successCard}>
              <span className={styles.successMark} aria-hidden="true">
                ✓
              </span>
              <h2 className={styles.successTitle}>
                Welcome aboard, {companyName || 'partner'}.
              </h2>
              <p className={styles.successText}>
                We&rsquo;ve received your application for the{' '}
                <strong>{activeTier.name}</strong> tier across{' '}
                <strong>{selectedCategories.length}</strong>{' '}
                {selectedCategories.length === 1 ? 'category' : 'categories'}.
                A founder will reach out at <code>{email}</code> within one
                business day.
              </p>
              <div className={styles.successReceipt}>
                <div>
                  <span>APP-ID</span>
                  <span>{appId}</span>
                </div>
                <div>
                  <span>TIER</span>
                  <span>{tier.toUpperCase()}</span>
                </div>
                <div>
                  <span>CATS</span>
                  <span>{selectedCategories.length || '—'}</span>
                </div>
                <div>
                  <span>STATUS</span>
                  <span className={styles.successOk}>RECEIVED</span>
                </div>
              </div>
              <div className={styles.successActions}>
                <Link to="/">
                  <GlowButton variant="primary">Back to Home</GlowButton>
                </Link>
                <Link to="/contact">
                  <GlowButton variant="gold">Reach a founder</GlowButton>
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.grid}>
            {/* Aside — benefits + tier picker */}
            <aside className={styles.aside}>
              <h2 className={styles.asideTitle}>Why list with us?</h2>
              <ul className={styles.benefits}>
                <li className={styles.benefitItem}>
                  <span className={styles.bullet} aria-hidden="true">
                    ⚡
                  </span>
                  <div>
                    <strong>Buyer intent traffic.</strong> Visitors arrive with
                    a part number in hand.
                  </div>
                </li>
                <li className={styles.benefitItem}>
                  <span className={styles.bullet} aria-hidden="true">
                    🔗
                  </span>
                  <div>
                    <strong>Direct buy-links.</strong> Your store, your
                    checkout — we never reroute the order.
                  </div>
                </li>
                <li className={styles.benefitItem}>
                  <span className={styles.bullet} aria-hidden="true">
                    📈
                  </span>
                  <div>
                    <strong>Monthly traffic report.</strong> See impressions,
                    clicks, top parts (Gold + Platinum).
                  </div>
                </li>
                <li className={styles.benefitItem}>
                  <span className={styles.bullet} aria-hidden="true">
                    🛠️
                  </span>
                  <div>
                    <strong>Optional API sync.</strong> Push live stock + price
                    updates from your ERP (Platinum).
                  </div>
                </li>
              </ul>

              <h3 className={styles.asideSub}>Pick a tier</h3>
              <div className={styles.tiers}>
                {JOIN_TIERS.map((t) => {
                  const cls = [
                    styles.tier,
                    tier === t.id ? styles.tierActive : '',
                    t.featured ? styles.tierFeatured : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <label key={t.id} className={cls}>
                      <input
                        type="radio"
                        name="tier"
                        value={t.id}
                        checked={tier === t.id}
                        onChange={() => setTier(t.id)}
                      />
                      <div className={styles.tierHead}>
                        <span className={styles.tierName}>{t.name}</span>
                        <span className={styles.tierPrice}>{t.price}</span>
                      </div>
                      <span className={styles.tierTag}>{t.tag}</span>
                      <ul className={styles.tierPerks}>
                        {t.perks.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    </label>
                  );
                })}
              </div>
            </aside>

            {/* Form */}
            <form
              className={styles.form}
              onSubmit={handleSubmit}
              noValidate
            >
              <div
                className={styles.progress}
                role="progressbar"
                aria-valuenow={completion}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={styles.progressBar}
                  style={{ width: `${completion}%` }}
                >
                  <span
                    className={styles.progressShimmer}
                    aria-hidden="true"
                  />
                </div>
                <span className={styles.progressLabel}>
                  APPLICATION · {completion}% COMPLETE
                </span>
              </div>

              {error && (
                <div className={styles.error} role="alert">
                  {error}
                </div>
              )}

              {/* Section 01 — Company profile */}
              <fieldset className={styles.fset}>
                <legend className={styles.legend}>
                  <span className={styles.legNum}>01</span> Company
                </legend>
                <div className={styles.row}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="join-company">
                      Company name<span className={styles.required}>*</span>
                    </label>
                    <input
                      id="join-company"
                      className={styles.input}
                      type="text"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="Acme Electronics, Inc."
                      required
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="join-contact">
                      Contact person
                    </label>
                    <input
                      id="join-contact"
                      className={styles.input}
                      type="text"
                      value={contactPerson}
                      onChange={(e) => setContactPerson(e.target.value)}
                      placeholder="Jane Doe, VP Sales"
                    />
                  </div>
                </div>
                <div className={styles.row}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="join-email">
                      Email<span className={styles.required}>*</span>
                    </label>
                    <input
                      id="join-email"
                      className={[
                        styles.input,
                        email && !emailOk ? styles.inputInvalid : '',
                        email && emailOk ? styles.inputValid : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="sales@company.com"
                      required
                    />
                    {email && (
                      <span
                        className={[
                          styles.fhint,
                          emailOk ? styles.fhintOk : styles.fhintBad,
                        ].join(' ')}
                      >
                        {emailOk
                          ? '✓ valid email'
                          : 'must look like name@domain.tld'}
                      </span>
                    )}
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="join-phone">
                      Phone
                    </label>
                    <input
                      id="join-phone"
                      className={styles.input}
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="(555) 123-4567"
                    />
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="join-website">
                    Website
                  </label>
                  <input
                    id="join-website"
                    className={[
                      styles.input,
                      website && !websiteOk ? styles.inputInvalid : '',
                      website && websiteOk ? styles.inputValid : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    type="url"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://www.company.com"
                  />
                  {website && !websiteOk && (
                    <span className={`${styles.fhint} ${styles.fhintBad}`}>
                      must start with http:// or https://
                    </span>
                  )}
                </div>
              </fieldset>

              {/* Section 02 — Categories of interest */}
              <fieldset className={styles.fset}>
                <legend className={styles.legend}>
                  <span className={styles.legNum}>02</span> Categories of
                  interest
                </legend>
                <p className={styles.fhelp}>
                  Pick every category your company supplies parts in. We&rsquo;ll
                  list you in each one.
                </p>
                <div className={styles.catGrid}>
                  {categories.map((c) => {
                    const on = selectedCategories.includes(c.slug);
                    return (
                      <button
                        type="button"
                        key={c.id}
                        className={[
                          styles.catChip,
                          on ? styles.catChipOn : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => toggleCategory(c.slug)}
                        aria-pressed={on}
                      >
                        <span className={styles.catIcon} aria-hidden="true">
                          {c.icon}
                        </span>
                        <span className={styles.catName}>{c.name}</span>
                        <span className={styles.catMark} aria-hidden="true">
                          {on ? '✓' : '+'}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className={`${styles.fhint} ${styles.fhintMono}`}>
                  {selectedCategories.length} / {categories.length} selected
                </p>
              </fieldset>

              {/* Section 03 — Message + Terms */}
              <fieldset className={styles.fset}>
                <legend className={styles.legend}>
                  <span className={styles.legNum}>03</span> Anything else?
                </legend>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="join-message">
                    Message (optional)
                  </label>
                  <textarea
                    id="join-message"
                    className={styles.textarea}
                    rows={4}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    maxLength={600}
                    placeholder="Tell us about your stock depth, lead times, or any specific categories you'd like to feature."
                  />
                  <span className={styles.fhint} aria-live="polite">{message.length} / 600</span>
                </div>
                <label className={styles.terms}>
                  <input
                    type="checkbox"
                    checked={agreedTerms}
                    onChange={(e) => setAgreedTerms(e.target.checked)}
                  />
                  <span>
                    I have authority to list this company and accept the{' '}
                    <button type="button" className={styles.termsLink} onClick={(e) => e.preventDefault()}>
                      Listing Terms
                    </button>{' '}
                    and{' '}
                    <button type="button" className={styles.termsLink} onClick={(e) => e.preventDefault()}>
                      Acceptable Use Policy
                    </button>
                    .
                  </span>
                </label>
              </fieldset>

              <div className={styles.actions}>
                <Link to="/contact">
                  <GlowButton type="button" variant="gold">
                    Have questions?
                  </GlowButton>
                </Link>
                <GlowButton
                  type="submit"
                  variant="primary"
                  disabled={submitting}
                >
                  {submitting ? 'Submitting…' : 'Submit Application →'}
                </GlowButton>
              </div>
            </form>
          </div>
        )}
      </div>

      <Footer />
    </motion.div>
  );
}
