import { useCallback, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useParams } from 'react-router-dom';
import PageHead from '@public/components/PageHead';
import PageHeaderBand from '@public/components/layout/PageHeaderBand';
import { STATIC_PAGE_SEO } from '@public/services/seoRoutes';
import type { PageSeo } from '@public/services/seo';
import BomIntake from './components/BomIntake';
import type { ParseResult } from './lib/parseBom';
import styles from './BomPage.module.scss';

/**
 * BOM pricing tool — the page shell and its phase machine.
 *
 * One component serves two routes: `/bom` (the tool) and `/bom/s/:slug` (a
 * read-only share). The share view is per-user content, so it declares
 * noindex — the sitemap and the prerender cover `/bom` only.
 *
 * Phases are deliberately explicit rather than derived from "is there a parse
 * result": the mapper (Task 15) is entered from a COMPLETE parse whose columns
 * are ambiguous, so "parsed" and "ready to price" are different facts.
 *
 * Ownership: the intake reads and parses; every result of that read lands
 * HERE. The source text is held in a ref because the mapper re-materializes
 * the SAME text with the roles the user picks (applyRoleMap) rather than
 * asking for the file again — it is input to a handler, never render data.
 */

type Phase = 'intake' | 'mapping' | 'table';

/** The share view must never be indexed: it is somebody's parts list, and a
 *  self-canonical would put it in the index next to the tool itself. */
const SHARE_SEO: PageSeo = {
  ...STATIC_PAGE_SEO.bom,
  canonical: null,
  robots: 'noindex, follow',
};

/** The mapper exists for ONE question: which column identifies the part? A
 *  BOM with neither an MPN nor a value column cannot be priced, so that — not
 *  the presence of unmapped extras like `Price` or `LCSC#` — is the trigger.
 *  Task 15 refines the ambiguous cases; this is the floor. */
function needsMapping(result: ParseResult): boolean {
  return !result.roleByColumn.some((role) => role === 'mpn' || role === 'value');
}

export default function BomPage() {
  const { slug } = useParams<{ slug?: string }>();
  const isShare = slug != null;

  const [phase, setPhase] = useState<Phase>('intake');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const sourceText = useRef('');

  const handleParsed = useCallback((result: ParseResult, name: string, text: string) => {
    setParsed(result);
    sourceText.current = text;
    setSourceName(name);
    // A hard error keeps the intake on screen with the reason attached; the
    // parser only sets it for the two unrecoverable cases (over the cap, or
    // nothing to read).
    setPhase(result.error != null ? 'intake' : needsMapping(result) ? 'mapping' : 'table');
  }, []);

  const startOver = () => {
    setParsed(null);
    sourceText.current = '';
    setSourceName(null);
    setPhase('intake');
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <PageHead seo={isShare ? SHARE_SEO : STATIC_PAGE_SEO.bom} />
      <PageHeaderBand
        page="bom"
        title="BOM Pricing Tool"
        subtitle="Price every line of your build across 57 distributors."
      />

      {/* Surface wrapper INSIDE the motion div: the band above is a window
          onto the persistent BackdropLayer, so the wash starts here. */}
      <div className={styles.page}>
        <div className={styles.stack}>
          {phase === 'intake' && (
            <>
              {/* Task 19 turns a share slug into the read-only table. Until
                  then the shared URL is an ordinary intake — an empty "shared
                  BOM" frame would promise content that is not loaded yet. */}
              <BomIntake onParsed={handleParsed} />
              {parsed?.error != null && (
                <p className={styles.pageError} role="alert">
                  {parsed.error}
                </p>
              )}
            </>
          )}

          {/* Phase bodies land in Tasks 15 (mapper) and 16 (table). The shell
              carries the state they read so those tasks add a component and
              delete a placeholder, never rewire the page. */}
          {phase !== 'intake' && parsed != null && (
            <section className={styles.phaseStub}>
              <h2 className={styles.phaseTitle}>
                {phase === 'mapping' ? 'Match your columns' : 'Your BOM'}
              </h2>
              <p className={styles.phaseText}>
                Read {parsed.lines.length.toLocaleString('en-US')}{' '}
                {parsed.lines.length === 1 ? 'line' : 'lines'}
                {sourceName != null ? ` from ${sourceName}` : ''}.
              </p>
              {parsed.warnings.map((warning) => (
                <p key={warning} className={styles.phaseWarn}>
                  {warning}
                </p>
              ))}
              <button type="button" className={styles.linkBtn} onClick={startOver}>
                Start over
              </button>
            </section>
          )}
        </div>
      </div>
    </motion.div>
  );
}
