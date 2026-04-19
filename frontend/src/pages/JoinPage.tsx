import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import Footer from '../components/layout/Footer';
import GlowButton from '../components/shared/GlowButton';
import { useCategories } from '../hooks/useCategories';
import { api } from '../services/api';
import CircuitTraces from '../components/shared/CircuitTraces';
import styles from './JoinPage.module.scss';

export default function JoinPage() {
  const { categories } = useCategories();

  const [companyName, setCompanyName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [message, setMessage] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleCategoryChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const options = e.target.options;
    const selected: string[] = [];
    for (let i = 0; i < options.length; i++) {
      if (options[i].selected) selected.push(options[i].value);
    }
    setSelectedCategories(selected);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!companyName.trim() || !email.trim()) {
      setError('Company name and email are required.');
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
        message: message.trim(),
      });
      setSubmitted(true);
    } catch {
      setError('Something went wrong. Please try again later.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' }}
    >

      <div className={styles.pageHeader}>
        <CircuitTraces />
        <div className={styles.headerInner}>
          <motion.h1
            className={styles.title}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            Join Circuits.com
          </motion.h1>
          <p className={styles.subtitle}>
            Get your company listed in our electronic components directory.
          </p>
        </div>
      </div>

      <div className={styles.content}>
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
              ✓
            </motion.span>
            <h2 className={styles.successTitle}>Welcome aboard!</h2>
            <p className={styles.successSubtitle}>
              We&rsquo;ve received your application. Our team will review it and get back to you
              shortly.
            </p>
            <Link to="/">
              <GlowButton variant="primary">Back to Home</GlowButton>
            </Link>
          </motion.div>
        ) : (
          <motion.form
            className={styles.form}
            onSubmit={handleSubmit}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            {error && <div className={styles.formError}>{error}</div>}

            <div className={styles.row}>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="join-company">
                  Company Name<span className={styles.required}>*</span>
                </label>
                <input
                  id="join-company"
                  className={styles.input}
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Acme Electronics"
                  required
                />
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="join-contact">
                  Contact Person
                </label>
                <input
                  id="join-contact"
                  className={styles.input}
                  type="text"
                  value={contactPerson}
                  onChange={(e) => setContactPerson(e.target.value)}
                  placeholder="Jane Doe"
                />
              </div>
            </div>

            <div className={styles.row}>
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="join-email">
                  Email<span className={styles.required}>*</span>
                </label>
                <input
                  id="join-email"
                  className={styles.input}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="info@company.com"
                  required
                />
              </div>

              <div className={styles.fieldGroup}>
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

            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="join-website">
                Website
              </label>
              <input
                id="join-website"
                className={styles.input}
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://www.company.com"
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="join-categories">
                Categories of Interest
              </label>
              <select
                id="join-categories"
                className={styles.multiSelect}
                multiple
                value={selectedCategories}
                onChange={handleCategoryChange}
              >
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.slug}>
                    {cat.icon} {cat.name}
                  </option>
                ))}
              </select>
              <p className={styles.fieldHint}>Hold Ctrl / Cmd to select multiple categories.</p>
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="join-message">
                Message
              </label>
              <textarea
                id="join-message"
                className={styles.textarea}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Tell us about your company and what you're looking for..."
              />
            </div>

            <div className={styles.actions}>
              <GlowButton type="submit" variant="primary" disabled={submitting}>
                {submitting ? 'Submitting...' : 'Submit Application'}
              </GlowButton>
            </div>
          </motion.form>
        )}
      </div>

      <Footer />
    </motion.div>
  );
}
