import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import PageHeaderBand from "@public/components/layout/PageHeaderBand";
import styles from "./PrivacyPage.module.scss";

// PrivacyPage — ported from 2026-05-12 Claude Design bundle. Both /privacy
// and /terms render this single page (Claude Design intentionally consolidated
// the two footer destinations; see chat transcript at design-import/
// circuits-com-legal-design/.../chats/chat1.md lines 2178-2257).

// Namespace prefix for the DOM `id` of each rendered section. Keeps the
// SECTIONS data IDs semantic ("scope", "rights") while preventing collision
// with same-named IDs elsewhere in the SPA (e.g. footer "contact" links).
const SECTION_DOM_ID = (id: string) => `privacy-${id}`;

function formatEffectiveDate(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

interface Section {
  id: string;
  num: string;
  title: string;
  body: string[];
}

const SECTIONS: Section[] = [
  {
    id: "scope",
    num: "01",
    title: "Scope",
    body: [
      'This Privacy Policy describes how Circuits.com ("we", "us", "our") collects, uses, and shares information when you visit circuits.com or use any service we operate (collectively, the "Service").',
      "By using the Service you agree to the practices described here. If you do not agree, please do not use the Service.",
    ],
  },
  {
    id: "collect",
    num: "02",
    title: "Information We Collect",
    body: [
      "Information you provide directly. When you contact us, request a listing, or sign in as a distributor, we collect the name, email address, phone number, company name, and any other content you submit.",
      "Information collected automatically. Like most websites, our servers automatically log your IP address, browser type, referring page, pages viewed, and timestamps. We use first-party cookies and similar technologies to remember preferences (such as your theme selection) and to measure aggregate site usage.",
      "Information from third parties. Distributor stock and pricing data displayed in our directory is provided by manufacturers and authorized distributors. We do not collect personal information about you from those parties.",
    ],
  },
  {
    id: "use",
    num: "03",
    title: "How We Use Information",
    body: [
      "We use the information we collect to operate, maintain, and improve the Service; to respond to your inquiries; to verify distributor listings; to detect, prevent, and address abuse, fraud, or technical problems; and to comply with applicable laws.",
      "We do not sell personal information. We do not use buyer or visitor data to build advertising profiles.",
    ],
  },
  {
    id: "share",
    num: "04",
    title: "How We Share Information",
    body: [
      "Service providers. We share information with vendors who help us operate the Service (e.g. hosting, analytics, email delivery). These providers are contractually limited to processing data on our behalf.",
      "Distributors. When you click a buy-link, you leave Circuits.com and enter the distributor's own website under their terms and privacy policy. We do not transmit your identity to the distributor unless you tell them yourself by signing in there.",
      "Legal. We may disclose information when we believe in good faith that disclosure is required by law, court order, or to protect the rights, property, or safety of any person.",
      "Business transfers. If Circuits.com is involved in a merger, acquisition, or sale of assets, information may be transferred as part of that transaction.",
    ],
  },
  {
    id: "cookies",
    num: "05",
    title: "Cookies & Tracking",
    body: [
      "We use a small number of first-party cookies and localStorage entries to keep the Service usable — for example, remembering which theme you selected or which page you last viewed.",
      "We do not use third-party advertising trackers. You can disable cookies in your browser; some features (such as remembering preferences across sessions) will not work without them.",
    ],
  },
  {
    id: "retention",
    num: "06",
    title: "Data Retention",
    body: [
      "We retain personal information only for as long as needed to fulfill the purposes described in this Policy, to comply with our legal obligations, to resolve disputes, and to enforce our agreements. When information is no longer needed, we delete or anonymize it.",
    ],
  },
  {
    id: "rights",
    num: "07",
    title: "Your Rights",
    body: [
      "Depending on where you live (including residents of the EEA, the United Kingdom, and California), you may have the right to access, correct, delete, or port your personal information; to object to or restrict certain processing; and to withdraw consent where we rely on it.",
      "To exercise any of these rights, email privacy@circuits.com from the address associated with your information. We will respond within the timeframe required by applicable law.",
    ],
  },
  {
    id: "security",
    num: "08",
    title: "Security",
    body: [
      "We use commercially reasonable administrative, technical, and physical safeguards designed to protect the information we hold. No method of transmission or storage is 100% secure, however, and we cannot guarantee absolute security.",
    ],
  },
  {
    id: "children",
    num: "09",
    title: "Children's Privacy",
    body: [
      "The Service is intended for engineering and purchasing professionals and is not directed to children under 13. We do not knowingly collect personal information from children under 13. If you believe a child has provided us with personal information, please contact privacy@circuits.com and we will delete it.",
    ],
  },
  {
    id: "intl",
    num: "10",
    title: "International Transfers",
    body: [
      "Circuits.com is operated from the United States. If you access the Service from outside the United States, your information may be transferred to, stored in, and processed in the United States or other countries with different data protection laws than your jurisdiction.",
    ],
  },
  {
    id: "changes",
    num: "11",
    title: "Changes to This Policy",
    body: [
      'We may update this Policy from time to time. When we do, we will revise the "Last revised" date at the top of the page and, for material changes, provide a more prominent notice. Your continued use of the Service after a change takes effect constitutes acceptance of the updated Policy.',
    ],
  },
  {
    id: "contact",
    num: "12",
    title: "Contact Us",
    body: [
      "Questions, requests, or complaints regarding this Policy may be sent to privacy@circuits.com or by mail to Circuits.com, Attn: Privacy, 1 Industry Park Way, Brookhaven, NY 11719, USA.",
    ],
  },
];

interface License {
  tag: string;
  name: string;
  body: string;
}

const LICENSES: License[] = [
  {
    tag: "MIT-style",
    name: "Site Content License",
    body: 'Copyright (c) 2003–2026 Circuits.com. Permission is hereby granted, free of charge, to any person obtaining a copy of the publicly displayed directory pages of circuits.com ("the Content"), to use, copy, reference, and link to the Content for personal, educational, or internal engineering use, subject to the following conditions: the above copyright notice and this permission notice shall be included in all substantial reproductions; bulk scraping, automated re-distribution, or resale of the Content is prohibited without written consent. THE CONTENT IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
  },
  {
    tag: "Trademarks",
    name: "Third-Party Marks",
    body: "All manufacturer names, part numbers, logos, and trademarks displayed on circuits.com are the property of their respective owners and are used here solely for identification and reference purposes. Their appearance on this site does not imply endorsement, sponsorship, or affiliation.",
  },
  {
    tag: "Datasheets",
    name: "Distributor Data",
    body: "Stock levels, pricing, and lead-time information are aggregated under license from participating authorized distributors and are subject to their own terms of use. Circuits.com makes no warranty as to the accuracy or timeliness of any third-party data displayed.",
  },
];

export default function PrivacyPage() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  const effectiveDate = useMemo(formatEffectiveDate, []);

  useEffect(() => {
    // rootMargin shrinks the observation band so a section is "active" only
    // while its heading is near the top of the page, not when it's barely
    // peeking in from the bottom.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          );
        if (!visible[0]) return;
        // Bare SECTIONS id ("scope"), not the prefixed DOM id — keeps `active`
        // comparable to the same SECTIONS array used by the TOC render.
        const next = visible[0].target.id.replace(/^privacy-/, "");
        // Equality guard: IO can fire several callbacks with the same top
        // section during fast scrolls; without this we reconcile all 12 TOC
        // buttons every duplicate.
        setActive((prev) => (prev === next ? prev : next));
      },
      { rootMargin: "-140px 0px -55% 0px", threshold: 0 },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(SECTION_DOM_ID(s.id));
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  function jump(id: string) {
    const el = document.getElementById(SECTION_DOM_ID(id));
    // scroll-margin-top: 100px (PrivacyPage.module.scss) handles the offset,
    // so scrollIntoView is the single source of truth for the landing spot.
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: "easeInOut" as const }}
    >
      <Helmet>
        <title>Privacy Policy | Circuits.com</title>
        <meta name="description" content="Circuits.com privacy policy — how we handle your data, cookies, and third-party services." />
        <link rel="canonical" href="https://circuits.com/privacy" />
      </Helmet>
      <PageHeaderBand
        page="privacy"
        title="Privacy Policy"
        subtitle={`The plain-English version · Effective ${effectiveDate}`}
      />

      <main className={styles.privacyPage}>
        <div className={styles.privacyGrid}>
          <aside className={styles.privacyToc} aria-label="Privacy policy sections">
            <div className={styles.tocHead}>
              <h2>Contents</h2>
              <p className={styles.tocMeta}>
                Privacy Policy &middot; Effective {effectiveDate}
              </p>
            </div>
            <ol className={styles.tocList}>
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`${styles.tocItem} ${active === s.id ? styles.on : ""}`}
                    onClick={() => jump(s.id)}
                    aria-current={active === s.id ? "true" : undefined}
                  >
                    <span className={styles.tocItemNum}>{s.num}</span>
                    <span className={styles.tocItemTitle}>{s.title}</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className={styles.tocFoot}>
              <Link to="/contact" className={styles.tocFootLink}>
                Questions? Contact us &rarr;
              </Link>
            </div>
          </aside>

          <article className={styles.privacyDoc}>
            <header className={styles.docHead}>
              <p className={styles.docRev}>
                Version 1.0 &middot; Effective {effectiveDate}
              </p>
              <p className={styles.docLede}>
                We run a parts directory, not a profiling business. This
                document explains, in plain English, what we collect, why, and
                how to reach us about it.
              </p>
              <dl className={styles.docMeta}>
                <div>
                  <dt>Effective</dt>
                  <dd>{effectiveDate}</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>1.0</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>privacy@circuits.com</dd>
                </div>
              </dl>
            </header>

            {SECTIONS.map((s) => (
              <section
                key={s.id}
                id={SECTION_DOM_ID(s.id)}
                className={styles.section}
              >
                <header className={styles.sectionHead}>
                  <span className={styles.sectionNum} aria-hidden="true">
                    {s.num}
                  </span>
                  <h2 className={styles.sectionTitle}>{s.title}</h2>
                </header>
                {s.body.map((p, i) => (
                  <p key={i} className={styles.p}>
                    {p}
                  </p>
                ))}
              </section>
            ))}

            <section
              id={SECTION_DOM_ID("appendix")}
              className={`${styles.section} ${styles.appendix}`}
            >
              <header className={styles.sectionHead}>
                <span className={styles.sectionNum} aria-hidden="true">
                  A
                </span>
                <h2 className={styles.sectionTitle}>Appendix &middot; Licenses</h2>
              </header>
              <p className={styles.p}>
                The following generic licenses govern the content displayed on
                circuits.com. They are provided for reference and do not
                modify any agreement you have entered into separately with us.
              </p>
              <div className={styles.licenseGrid}>
                {LICENSES.map((l) => (
                  <article key={l.name} className={styles.licenseCard}>
                    <span className={styles.licenseTag}>{l.tag}</span>
                    <h3 className={styles.licenseName}>{l.name}</h3>
                    <p className={styles.licenseBody}>{l.body}</p>
                  </article>
                ))}
              </div>
            </section>

            <footer className={styles.docSign}>
              <div className={styles.signRow}>
                <span className={styles.signLabel}>Signed</span>
                <span className={styles.signName}>
                  M. Chirichella &middot; M. Kennedy &middot; J. Tietjen
                </span>
              </div>
              <div className={styles.signRow}>
                <span className={styles.signLabel}>Date</span>
                <span>{effectiveDate}</span>
              </div>
              <div className={styles.signActions}>
                <Link to="/contact" className={styles.signActionGhost}>
                  Contact us
                </Link>
                <Link to="/" className={styles.signActionPrimary}>
                  Back to Home &rarr;
                </Link>
              </div>
            </footer>
          </article>
        </div>
      </main>
    </motion.div>
  );
}
