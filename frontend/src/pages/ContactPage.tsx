import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import Navbar from '../components/layout/Navbar';
import Footer from '../components/layout/Footer';
import GlowButton from '../components/shared/GlowButton';
import { api } from '../services/api';
import CircuitTraces from '../components/shared/CircuitTraces';
import styles from './ContactPage.module.scss';

const CONTACT_INFO = {
  name: 'John Tietjen',
  location: 'Holbrook, NY',
  email: 'john@circuits.com',
  phone: '631-495-0445',
};

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
      transition={{ duration: 0.3, ease: 'easeInOut' }}
    >
      <Navbar />

      <div className={styles.pageHeader}>
        <CircuitTraces />
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
              <h2 className={styles.infoPanelTitle}>Get in Touch</h2>

              <div className={styles.infoRow}>
                <span className={styles.infoIcon} aria-hidden="true">👤</span>
                <div className={styles.infoContent}>
                  <p className={styles.infoLabel}>Contact</p>
                  <p className={styles.infoValue}>{CONTACT_INFO.name}</p>
                </div>
              </div>

              <div className={styles.infoRow}>
                <span className={styles.infoIcon} aria-hidden="true">📍</span>
                <div className={styles.infoContent}>
                  <p className={styles.infoLabel}>Location</p>
                  <p className={styles.infoValue}>{CONTACT_INFO.location}</p>
                </div>
              </div>

              <div className={styles.infoRow}>
                <span className={styles.infoIcon} aria-hidden="true">✉️</span>
                <div className={styles.infoContent}>
                  <p className={styles.infoLabel}>Email</p>
                  <p className={styles.infoValue}>
                    <a
                      href={`mailto:${CONTACT_INFO.email}`}
                      className={styles.infoLink}
                    >
                      {CONTACT_INFO.email}
                    </a>
                  </p>
                </div>
              </div>

              <div className={styles.infoRow}>
                <span className={styles.infoIcon} aria-hidden="true">📞</span>
                <div className={styles.infoContent}>
                  <p className={styles.infoLabel}>Phone</p>
                  <p className={styles.infoValue}>
                    <a
                      href={`tel:${CONTACT_INFO.phone}`}
                      className={styles.infoLink}
                    >
                      {CONTACT_INFO.phone}
                    </a>
                  </p>
                </div>
              </div>
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

              <div className={styles.actions}>
                <GlowButton type="submit" variant="primary" disabled={submitting}>
                  {submitting ? 'Sending...' : 'Send Message'}
                </GlowButton>
              </div>
            </motion.form>
          </div>
        )}
      </div>

      <Footer />
    </motion.div>
  );
}
