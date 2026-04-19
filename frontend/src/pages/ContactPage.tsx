import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import Footer from '../components/layout/Footer';
import GlowButton from '../components/shared/GlowButton';
import { api } from '../services/api';
import CircuitTraces from '../components/shared/CircuitTraces';
import styles from './ContactPage.module.scss';

const CONTACTS = [
  {
    name: 'John Tietjen',
    title: 'Founder / CEO',
    email: 'john@circuits.com',
    phone: '631-495-0445',
  },
  {
    name: 'Mike Kennedy, Ph.D',
    title: 'Co-Founder / COO',
    email: 'mike@circuits.com',
    phone: '631-708-6040',
  },
];

export default function ContactPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !email.trim() || !message.trim()) {
      setError('Name, email, and message are required.');
      return;
    }

    setSubmitting(true);
    try {
      await api.submitContact({
        name: name.trim(),
        email: email.trim(),
        subject: subject.trim(),
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
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >

      <div className={styles.pageHeader}>
        <CircuitTraces variant="static" />
        <div className={styles.headerInner}>
          <motion.h1
            className={styles.title}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            Contact Us
          </motion.h1>
          <p className={styles.subtitle}>
            Have a question or want to learn more? We&rsquo;d love to hear from you.
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
              ✉️
            </motion.span>
            <h2 className={styles.successTitle}>Message Sent!</h2>
            <p className={styles.successSubtitle}>
              Thank you for reaching out. We&rsquo;ll get back to you as soon as possible.
            </p>
            <Link to="/">
              <GlowButton variant="primary">Back to Home</GlowButton>
            </Link>
          </motion.div>
        ) : (
          <div className={styles.grid}>
            <motion.div
              className={styles.infoPanel}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
            >
              <div className={styles.infoPanelHeader}>
                <h2 className={styles.infoPanelTitle}>Get in Touch</h2>
                <p className={styles.infoPanelDek}>
                  Two founders, two direct lines. No gatekeepers.
                </p>
              </div>

              <div className={styles.contactList}>
                {CONTACTS.map((contact, idx) => (
                  <motion.article
                    key={contact.email}
                    className={styles.contactCard}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35, delay: 0.12 + idx * 0.05 }}
                    aria-labelledby={`contact-name-${idx}`}
                  >
                    <span className={styles.cardDesignator} aria-hidden="true">
                      U{idx + 1}
                    </span>

                    <div className={styles.contactHeader}>
                      <h3
                        id={`contact-name-${idx}`}
                        className={styles.contactName}
                      >
                        {contact.name}
                      </h3>
                      <p className={styles.contactTitle}>{contact.title}</p>
                    </div>

                    <div className={styles.contactRows}>
                      <a
                        className={styles.contactLineItem}
                        href={`mailto:${contact.email}`}
                        aria-label={`Email ${contact.name} at ${contact.email}`}
                        title={contact.email}
                      >
                        <span className={styles.infoIcon} aria-hidden="true">✉</span>
                        <span className={styles.infoText}>{contact.email}</span>
                        <span className={styles.infoArrow} aria-hidden="true">→</span>
                      </a>
                      <a
                        className={styles.contactLineItem}
                        href={`tel:${contact.phone}`}
                        aria-label={`Call ${contact.name} at ${contact.phone}`}
                      >
                        <span className={styles.infoIcon} aria-hidden="true">☎</span>
                        <span className={styles.infoText}>{contact.phone}</span>
                        <span className={styles.infoArrow} aria-hidden="true">→</span>
                      </a>
                    </div>
                  </motion.article>
                ))}
              </div>

              <motion.p
                className={styles.responseFooter}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 0.28 }}
                aria-label="Expected response time"
              >
                <span className={styles.statusDot} aria-hidden="true" />
                <span className={styles.responseText}>
                  Typically responds within 1 business day
                </span>
              </motion.p>
            </motion.div>

            <motion.form
              className={styles.form}
              onSubmit={handleSubmit}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: 0.15 }}
            >
              <h2 className={styles.formTitle}>Send a Message</h2>

              {error && <div className={styles.formError}>{error}</div>}

              <div className={styles.row}>
                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="contact-name">
                    Name<span className={styles.required}>*</span>
                  </label>
                  <input
                    id="contact-name"
                    className={styles.input}
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    required
                  />
                </div>

                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="contact-email">
                    Email<span className={styles.required}>*</span>
                  </label>
                  <input
                    id="contact-email"
                    className={styles.input}
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                  />
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="contact-subject">
                  Subject
                </label>
                <input
                  id="contact-subject"
                  className={styles.input}
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="What is this regarding?"
                />
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="contact-message">
                  Message<span className={styles.required}>*</span>
                </label>
                <textarea
                  id="contact-message"
                  className={styles.textarea}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="How can we help you?"
                  required
                />
              </div>

              <GlowButton
                type="submit"
                variant="primary"
                disabled={submitting}
                style={{ marginLeft: 'auto', marginTop: '24px' }}
              >
                {submitting ? 'Sending...' : 'Send Message'}
              </GlowButton>
            </motion.form>
          </div>
        )}
      </div>

      <Footer />
    </motion.div>
  );
}
