import { useEffect, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import PageHead from "@public/components/PageHead";
import { STATIC_PAGE_SEO } from "@public/services/seoRoutes";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import PageHeaderBand from "@public/components/layout/PageHeaderBand";
import { api } from "@public/services/api";
import styles from "./ContactPage.module.scss";

// Founder roster — surfaced as schematic component designators (U1).
// The U1 monospace label is a load-bearing brand element (datasheet motif —
// see CLAUDE.md "Contact Page — Datasheet Card Motif"). Do not strip.
const CONTACTS = [
  {
    name: "Matthew Chirichella",
    title: "Founder",
    email: "matthew@circuitcenter.ai",
    initials: "MC",
    des: "U1",
  },
];

const REASONS = [
  { id: "general", label: "General question" },
  { id: "list", label: "Listing my company" },
  { id: "data", label: "Data accuracy" },
  { id: "press", label: "Press / partnership" },
  { id: "other", label: "Other" },
];

const MAX_MSG = 1200;

/** The anchor the BOM tool's per-line "Request a quote" links land on. */
const DESK_ID = "partner-desk";

/** A `?part=` value is somebody's part identity, not a whole BOM — the BOM
 *  tool builds it from one line's identity fields and clamps it there too.
 *  Clamped again here because a URL is editable and the field is not
 *  unbounded. */
const MAX_PART_PREFILL = 200;

/** Turn `/contact?part=STM32F103C8T6 · STMicroelectronics` into the opening of
 *  a message the reader can send as-is or edit. Returns "" for an absent or
 *  blank param, which leaves the field exactly as it was. */
function partPrefillMessage(part: string | null): string {
  const identity = (part ?? "").trim().slice(0, MAX_PART_PREFILL);
  if (identity === "") return "";
  return `Please quote this line from my BOM:\n\n${identity}\n\nQuantity needed:\n`;
}

export default function ContactPage() {
  // Open-Placement sponsor CTAs (CategorySponsor "Become a sponsor") navigate
  // here with a prefilled message in location.state. Read it ONCE in the lazy
  // useState initializer so a later re-render (or back-nav) doesn't re-apply it.
  const location = useLocation();
  const sponsorPrefill =
    (location.state as { prefillMessage?: string } | null)?.prefillMessage ?? "";

  // The BOM tool routes an unpriceable line here as `?part=<identity>` — a
  // query param rather than router state so the link survives a copy-paste,
  // a new tab and a middle-click. Read once, in the same lazy initializer, and
  // never allowed to overwrite the sponsor prefill.
  const [searchParams] = useSearchParams();
  const prefillMessage = sponsorPrefill || partPrefillMessage(searchParams.get("part"));

  // A sponsorship inquiry is a "Listing my company" reason; default to it when
  // that prefill is present so the folded-subject line reads correctly. A part
  // quote is an ordinary question and keeps the general default.
  const [reason, setReason] = useState(() => (sponsorPrefill ? "list" : "general"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState(() => prefillMessage);

  // `#partner-desk` arrivals land on the form, not the top of the page.
  // App.tsx's scroll-to-top deliberately skips a hash, so the landing spot is
  // ours to set; scroll-margin-top (ContactPage.module.scss) owns the offset.
  const hash = location.hash;
  useEffect(() => {
    if (hash !== `#${DESK_ID}`) return;
    document
      .getElementById(DESK_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash]);

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !email.trim() || !message.trim()) {
      setError("Name, email, and message are required.");
      return;
    }

    setSubmitting(true);
    try {
      // Reason chip is folded into the subject line so the existing API contract
      // (name/email/subject/message — see services/api.ts) doesn't need a new
      // field. If the user typed an explicit subject it wins; otherwise the
      // selected reason label becomes the subject.
      const reasonLabel = REASONS.find((r) => r.id === reason)?.label ?? "";
      const composedSubject = subject.trim() || reasonLabel;
      await api.submitContact({
        name: name.trim(),
        email: email.trim(),
        subject: composedSubject,
        message: message.trim(),
      });
      setSubmitted(true);
    } catch (err) {
      // Log the upstream failure so production debugging has a trail; user-
      // facing message stays generic to avoid leaking API internals.
      console.error("[ContactPage] api.submitContact failed", err);
      setError("Something went wrong. Please try again later.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    const firstName = name.split(" ")[0] || "friend";
    return (
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        transition={{ duration: 0.15, ease: "easeInOut" as const }}
      >
        <PageHead seo={STATIC_PAGE_SEO.contact} />
        <PageHeaderBand
          page="contact"
          title="Contact Us"
          subtitle="Have a question or want to learn more? We'd love to hear from you."
        />

        <div className={styles.contactPage}>
          <motion.div
            className={styles.contactSuccess}
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{
              duration: 0.5,
              ease: [0.18, 0.89, 0.32, 1.28] as const,
            }}
          >
            <motion.span
              className={styles.contactSuccessMark}
              initial={{ scale: 0, rotate: -45 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{
                type: "spring",
                stiffness: 300,
                damping: 12,
                delay: 0.15,
              }}
              aria-hidden="true"
            >
              ✓
            </motion.span>
            <h2>Message sent.</h2>
            <p>
              Thanks, {firstName}. We&rsquo;ll reply to <code>{email}</code>{" "}
              within one business day.
            </p>
            <Link to="/" className={styles.contactSubmit}>
              Back to Home
            </Link>
          </motion.div>
        </div>
      </motion.div>
    );
  }

  const reasonLabel = REASONS.find((r) => r.id === reason)?.label ?? "";

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: "easeInOut" as const }}
    >
      <PageHeaderBand
        page="contact"
        title="Contact Us"
        subtitle="Have a question or want to learn more? We'd love to hear from you."
      />

      <div className={styles.contactPage}>
        <div className={styles.contactGrid}>
          {/* Datasheet info panel — founders */}
          <motion.aside
            className={styles.contactInfo}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, delay: 0.1, ease: "easeOut" as const }}
          >
            <header className={styles.contactInfoHead}>
              <span className={styles.contactInfoTag}>
                CIRCUIT CENTER · CONTACTS · U1
              </span>
              <h2 className={styles.contactInfoTitle}>Get in Touch</h2>
              <p className={styles.contactInfoDek}>
                A direct line to the founder. No gatekeepers, no ticket queue,
                no chatbot.
              </p>
            </header>

            <div className={styles.contactCards}>
              {CONTACTS.map((c, i) => (
                <motion.article
                  key={c.email}
                  className={styles.contactCard}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.4,
                    delay: 0.18 + i * 0.08,
                    ease: "easeOut" as const,
                  }}
                  aria-labelledby={`contact-name-${i}`}
                >
                  <span className={styles.contactDes} aria-hidden="true">
                    {c.des}
                  </span>

                  <div className={styles.contactCardHead}>
                    <span className={styles.contactAvatar} aria-hidden="true">
                      {c.initials}
                    </span>
                    <div>
                      <h3
                        id={`contact-name-${i}`}
                        className={styles.contactName}
                      >
                        {c.name}
                      </h3>
                      <p className={styles.contactTitle}>{c.title}</p>
                    </div>
                  </div>

                  <div className={styles.contactRows}>
                    <a
                      className={styles.contactLine}
                      href={`mailto:${c.email}`}
                      aria-label={`Email ${c.name}`}
                    >
                      <span
                        className={styles.contactLineIco}
                        aria-hidden="true"
                      >
                        ✉
                      </span>
                      <span className={styles.contactLineText}>{c.email}</span>
                      <span
                        className={styles.contactLineArrow}
                        aria-hidden="true"
                      >
                        →
                      </span>
                    </a>
                  </div>
                </motion.article>
              ))}
            </div>

            <footer
              className={styles.contactInfoFoot}
              aria-label="Expected response time"
            >
              <span className={styles.contactStatusDot} aria-hidden="true" />
              <span>
                Typically responds within 1 business day · Mon&ndash;Fri,
                9&ndash;6 ET
              </span>
            </footer>
          </motion.aside>

          {/* Message form */}
          <motion.form
            id={DESK_ID}
            className={styles.contactForm}
            onSubmit={handleSubmit}
            noValidate
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{
              duration: 0.4,
              delay: 0.15,
              ease: "easeOut" as const,
            }}
          >
            <h2 className={styles.contactFormTitle}>Send a message</h2>
            <p className={styles.contactFormDek}>
              Pick what this is about and tell us in your own words.
            </p>

            {error && (
              <div className={styles.contactError} role="alert">
                {error}
              </div>
            )}

            <div className={styles.contactField}>
              <label>What&rsquo;s this about?</label>
              <div className={styles.contactReasons}>
                {REASONS.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    className={`${styles.contactReason} ${reason === r.id ? styles.on : ""}`}
                    onClick={() => setReason(r.id)}
                    aria-pressed={reason === r.id}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.contactRow}>
              <div className={styles.contactField}>
                <label htmlFor="c-name">
                  Your name<span className={styles.contactReq}>*</span>
                </label>
                <input
                  id="c-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  required
                />
              </div>

              <div className={styles.contactField}>
                <label htmlFor="c-email">
                  Email<span className={styles.contactReq}>*</span>
                </label>
                <input
                  id="c-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </div>
            </div>

            <div className={styles.contactField}>
              <label htmlFor="c-subject">Subject</label>
              <input
                id="c-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={`Re: ${reasonLabel}`}
              />
            </div>

            <div className={styles.contactField}>
              <label htmlFor="c-msg">
                Message<span className={styles.contactReq}>*</span>
              </label>
              <textarea
                id="c-msg"
                rows={6}
                maxLength={MAX_MSG}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="How can we help you?"
                required
              />
              <span className={styles.contactCount} aria-live="polite">
                {message.length} / {MAX_MSG}
              </span>
            </div>

            <div className={styles.contactActions}>
              <button
                type="submit"
                className={styles.contactSubmit}
                disabled={submitting}
              >
                {submitting ? "Sending…" : "Send Message →"}
              </button>
            </div>
          </motion.form>
        </div>
      </div>
    </motion.div>
  );
}
