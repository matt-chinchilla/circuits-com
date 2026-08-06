import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import PageHead from "@public/components/PageHead";
import PageHeaderBand from "@public/components/layout/PageHeaderBand";
import type { PageSeo } from "@public/services/seo";
import { formatDocDate } from "@public/services/businessInfo";
import styles from "./LegalDoc.module.scss";

/**
 * The shared chrome for every legal document: contents rail with scroll-spy,
 * numbered sections, optional appendix, sign-off block.
 *
 * Extracted from PrivacyPage when Terms and Acceptable Use arrived, rather
 * than pasting ~200 lines of identical TOC-and-observer wiring into each. The
 * pages that consume it are now pure content, which is the point — a legal
 * document should be reviewable as prose without reading an IntersectionObserver.
 *
 * The stylesheet moved with it (was PrivacyPage.module.scss); only the four
 * page-scoped root selectors were renamed, so the rendering is byte-identical
 * to what shipped.
 */

export interface LegalSection {
  /** Semantic, unprefixed — "scope", "billing". Namespaced at render. */
  id: string;
  /** Two-character display number: "01".."12". */
  num: string;
  title: string;
  body: string[];
  /** Optional bulleted list rendered after `body`. */
  bullets?: string[];
}

export interface LegalAppendixCard {
  tag: string;
  name: string;
  body: string;
}

export interface LegalAppendix {
  title: string;
  intro: string;
  cards: LegalAppendixCard[];
}

export interface LegalDocProps {
  seo: PageSeo;
  /** PageHeaderBand's `page` key. */
  page: string;
  title: string;
  /** Header-band subtitle, left of the effective date. */
  kicker: string;
  /** One-paragraph plain-English summary above the first section. */
  lede: string;
  /** Pinned ISO date from DOC_DATES — never a live clock. */
  effectiveDate: string;
  version: string;
  /** Mailbox responsible for the document, shown in the meta block. */
  owner: string;
  /**
   * DOM-id namespace, e.g. "terms" -> id="terms-scope". Keeps section ids
   * from colliding with same-named ids elsewhere in the SPA (the footer has
   * its own "contact").
   */
  idPrefix: string;
  sections: LegalSection[];
  appendix?: LegalAppendix;
  /** Name on the sign-off line. */
  signedBy: string;
}

export default function LegalDoc({
  seo,
  page,
  title,
  kicker,
  lede,
  effectiveDate,
  version,
  owner,
  idPrefix,
  sections,
  appendix,
  signedBy,
}: LegalDocProps) {
  const [active, setActive] = useState<string>(sections[0].id);
  const displayDate = formatDocDate(effectiveDate);

  useEffect(() => {
    // rootMargin shrinks the observation band so a section is "active" only
    // while its heading is near the top of the page, not when it's barely
    // peeking in from the bottom.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (!visible[0]) return;
        // Bare section id, not the prefixed DOM id — keeps `active` comparable
        // to the same array the TOC renders from. Sliced rather than regexed
        // so an idPrefix containing regex metacharacters can't misbehave.
        const next = visible[0].target.id.slice(idPrefix.length + 1);
        // Equality guard: IO can fire several callbacks with the same top
        // section during a fast scroll; without this every duplicate
        // reconciles the whole TOC.
        setActive((prev) => (prev === next ? prev : next));
      },
      { rootMargin: "-140px 0px -55% 0px", threshold: 0 },
    );
    sections.forEach((s) => {
      const el = document.getElementById(`${idPrefix}-${s.id}`);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sections, idPrefix]);

  function jump(id: string) {
    // scroll-margin-top: 100px (LegalDoc.module.scss) owns the offset, so
    // scrollIntoView is the single source of truth for the landing spot.
    document
      .getElementById(`${idPrefix}-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: "easeInOut" as const }}
    >
      <PageHead seo={seo} />
      <PageHeaderBand
        page={page}
        title={title}
        subtitle={`${kicker} · Effective ${displayDate}`}
      />

      <main className={styles.legalPage}>
        <div className={styles.legalGrid}>
          <aside className={styles.legalToc} aria-label={`${title} sections`}>
            <div className={styles.tocHead}>
              <h2>Contents</h2>
              <p className={styles.tocMeta}>
                {title} &middot; Effective {displayDate}
              </p>
            </div>
            <ol className={styles.tocList}>
              {sections.map((s) => (
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

          <article className={styles.legalDoc}>
            <header className={styles.docHead}>
              <p className={styles.docRev}>
                Version {version} &middot; Effective {displayDate}
              </p>
              <p className={styles.docLede}>{lede}</p>
              <dl className={styles.docMeta}>
                <div>
                  <dt>Effective</dt>
                  <dd>{displayDate}</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>{version}</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>{owner}</dd>
                </div>
              </dl>
            </header>

            {sections.map((s) => (
              <section
                key={s.id}
                id={`${idPrefix}-${s.id}`}
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
                {s.bullets && (
                  <ul className={styles.bullets}>
                    {s.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                )}
              </section>
            ))}

            {appendix && (
              <section
                id={`${idPrefix}-appendix`}
                className={`${styles.section} ${styles.appendix}`}
              >
                <header className={styles.sectionHead}>
                  <span className={styles.sectionNum} aria-hidden="true">
                    A
                  </span>
                  <h2 className={styles.sectionTitle}>{appendix.title}</h2>
                </header>
                <p className={styles.p}>{appendix.intro}</p>
                <div className={styles.licenseGrid}>
                  {appendix.cards.map((c) => (
                    <article key={c.name} className={styles.licenseCard}>
                      <span className={styles.licenseTag}>{c.tag}</span>
                      <h3 className={styles.licenseName}>{c.name}</h3>
                      <p className={styles.licenseBody}>{c.body}</p>
                    </article>
                  ))}
                </div>
              </section>
            )}

            <footer className={styles.docSign}>
              <div className={styles.signRow}>
                <span className={styles.signLabel}>Signed</span>
                <span className={styles.signName}>{signedBy}</span>
              </div>
              <div className={styles.signRow}>
                <span className={styles.signLabel}>Date</span>
                <span>{displayDate}</span>
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
