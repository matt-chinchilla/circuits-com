import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Link, useParams } from 'react-router-dom';
import PageHead from '@public/components/PageHead';
import PageHeaderBand from '@public/components/layout/PageHeaderBand';
import { STATIC_PAGE_SEO } from '@public/services/seoRoutes';
import type { PageSeo } from '@public/services/seo';
import BomIntake from './components/BomIntake';
import ShareBar, { formatShareDate } from '@public/components/bom/ShareBar';
import BomTable from '@public/components/bom/BomTable';
import ColumnMapper from './components/ColumnMapper';
import { bomApi } from '@public/services/bom/bomApi';
import { applyRoleMap, canPrice, type ParseResult } from '@public/services/bom/parseBom';
import { loadRoleMap, saveRoleMap } from '@public/services/bom/mapMemory';
import { parseSharePayload } from '@public/services/bom/share';
import { useBomWorkbench } from '@public/services/bom/useBomWorkbench';
import type { BomRole } from '@public/services/bom/headerAliases';
import type { TableRow } from '@public/services/bom/types';
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

/** `/bom/s/:slug` only: fetching, readable, or gone. */
type ShareState = 'loading' | 'ready' | 'missing';

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
 *  `canPrice` is that floor, shared with the mapper's Continue button. */
function needsMapping(result: ParseResult): boolean {
  return !canPrice(result.roleByColumn);
}

export default function BomPage() {
  const { slug } = useParams<{ slug?: string }>();
  const isShare = slug != null;

  const [phase, setPhase] = useState<Phase>('intake');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [mapRoles, setMapRoles] = useState<(BomRole | null)[]>([]);

  // Everything that happens to a BOM once it is ready to price — the match,
  // the resolve stream, build quantity, the DNP toggle, the similar-pick —
  // lives in the workbench, which /viewer mounts too (spec §6). Handing it
  // null is how the page says "not ready": the share view never prices (that
  // quota is not the reader's to spend), and neither do the intake or mapper
  // phases. The viewer route stays null here; Task 3.4 fills it in when a
  // viewer session is what produced these lines.
  const wb = useBomWorkbench(isShare || phase !== 'table' ? null : parsed, null);

  const sourceText = useRef('');

  // The share view is its own small machine: one GET, then either a read-only
  // table or the dead-link state. `unreadable` is folded into `missing` on
  // purpose — a link whose payload this build cannot parse is, to the reader,
  // exactly as useful as one that expired.
  const [shareState, setShareState] = useState<ShareState>(isShare ? 'loading' : 'ready');
  const [shareExpiry, setShareExpiry] = useState<string | null>(null);

  // A share's rows are the workbench's opposite number: replayed, never
  // matched, never resolved. They are held here rather than pushed into the
  // workbench because nothing the workbench does applies to them — giving it
  // rows it may not price would be a seam somebody later mistakes for one.
  // Quantity and the DNP toggle stay live: both are arithmetic on data already
  // on the page, and ask nothing of anyone.
  const [shareRows, setShareRows] = useState<TableRow[]>([]);
  const [shareQty, setShareQty] = useState(1);
  const [shareDnp, setShareDnp] = useState(false);

  // Hydrate a shared BOM. No intake, no mapper, and deliberately NO resolve:
  // the reader of a share did not upload this file, and spending distributor
  // quota on somebody else's BOM every time a link is opened is not theirs to
  // spend. The table renders the answers the BOM was shared with.
  useEffect(() => {
    if (slug == null) return;
    let cancelled = false;
    setShareState('loading');
    bomApi
      .getShare(slug)
      .then((envelope) => {
        if (cancelled) return;
        const hydrated = parseSharePayload(envelope.payload);
        if (hydrated == null) {
          setShareState('missing');
          return;
        }
        setShareRows(hydrated.rows);
        setShareQty(hydrated.buildQty);
        setShareDnp(hydrated.includeDnp);
        setShareExpiry(envelope.expires_at);
        setShareState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setShareState('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const handleParsed = useCallback((result: ParseResult, name: string, text: string) => {
    sourceText.current = text;
    setSourceName(name);

    // A hard error keeps the intake on screen with the reason attached; the
    // parser only sets it for the two unrecoverable cases (over the cap, or
    // nothing to read).
    if (result.error != null) {
      setParsed(result);
      setPhase('intake');
      return;
    }

    if (needsMapping(result)) {
      // A layout this browser has already been asked about is answered from
      // memory — the mapper is a question, and asking it twice about the same
      // weekly export is the thing the memory exists to prevent.
      const remembered = loadRoleMap(result.headerSignature);
      if (remembered != null && canPrice(remembered)) {
        const mapped = applyRoleMap(text, remembered);
        setParsed(mapped);
        setMapRoles(remembered);
        setPhase(mapped.error != null ? 'intake' : 'table');
        return;
      }
      setParsed(result);
      setMapRoles(result.roleByColumn);
      setPhase('mapping');
      return;
    }

    setParsed(result);
    setMapRoles(result.roleByColumn);
    setPhase('table');
  }, []);

  // Continue from the mapper: remember the answer against this header
  // signature, then re-materialize the SAME text with the chosen roles.
  const handleMapContinue = useCallback(() => {
    if (parsed == null) return;
    saveRoleMap(parsed.headerSignature, mapRoles);
    const mapped = applyRoleMap(sourceText.current, mapRoles);
    setParsed(mapped);
    setPhase(mapped.error != null ? 'intake' : 'table');
  }, [parsed, mapRoles]);

  const startOver = () => {
    wb.reset();
    setParsed(null);
    sourceText.current = '';
    setSourceName(null);
    setMapRoles([]);
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
        subtitle={
          <>
            Price every line of your build across <strong>dozens of distributors</strong>.
          </>
        }
      />

      {/* Surface wrapper INSIDE the motion div: the band above is a window
          onto the persistent BackdropLayer, so the wash starts here. */}
      <div className={styles.page}>
        <div className={styles.stack}>
          {isShare && shareState === 'loading' && (
            <p className={styles.phaseText} role="status">
              Loading this shared BOM&#8230;
            </p>
          )}

          {/* A dead link is NAMED, not silently redirected to the tool: the
              reader followed a URL somebody sent them and needs to know it is
              the link that expired, not their file that failed. */}
          {isShare && shareState === 'missing' && (
            <section className={styles.deadLink}>
              <h2 className={styles.phaseTitle}>This shared BOM is no longer available</h2>
              <p className={styles.phaseText}>
                Share links expire on their own, and the person who created this one may have let
                it lapse. Ask them for a fresh link, or price your own build in a minute.
              </p>
              <Link className={styles.deadCta} to="/bom">
                Start your own BOM &#8594;
              </Link>
            </section>
          )}

          {isShare && shareState === 'ready' && shareRows.length > 0 && (
            <section className={styles.tablePhase}>
              <p className={styles.shareBanner} role="status">
                Shared BOM
                {shareExpiry != null ? ` — expires ${formatShareDate(shareExpiry)}` : ''}
              </p>
              {/* Read-only: no intake above it, no share button below it, and
                  no live resolve behind it. Build quantity and the DNP toggle
                  stay live because both are arithmetic on data already on the
                  page — they ask nothing of anyone. */}
              <BomTable
                rows={shareRows}
                buildQty={shareQty}
                onBuildQtyChange={setShareQty}
                onPickSimilar={null}
                includeDnp={shareDnp}
                onIncludeDnpChange={setShareDnp}
              />
            </section>
          )}

          {!isShare && phase === 'intake' && (
            <>
              <BomIntake onParsed={handleParsed} />
              {parsed?.error != null && (
                <p className={styles.pageError} role="alert">
                  {parsed.error}
                </p>
              )}
            </>
          )}

          {!isShare && phase === 'mapping' && parsed != null && (
            <ColumnMapper
              headers={parsed.headers}
              roles={mapRoles}
              text={sourceText.current}
              onChange={setMapRoles}
              onContinue={handleMapContinue}
            />
          )}

          {!isShare && phase === 'table' && parsed != null && (
            <section className={styles.tablePhase}>
              <div className={styles.bomHead}>
                <h2 className={styles.bomTitle}>Bill of Materials</h2>
                {sourceName != null && <span className={styles.bomFile}>{sourceName}</span>}
                <p className={styles.bomSub}>
                  {parsed.lines.length.toLocaleString('en-US')}{' '}
                  {parsed.lines.length === 1 ? 'line' : 'lines'} priced across{' '}
                  <strong>dozens of distributors</strong>. Your file stays in your browser.
                </p>
              </div>

              {parsed.warnings.map((warning) => (
                <p key={warning} className={styles.phaseWarn}>
                  {warning}
                </p>
              ))}

              {wb.resolveNote != null && <p className={styles.phaseWarn}>{wb.resolveNote}</p>}

              {wb.matchError != null && (
                <p className={styles.pageError} role="alert">
                  {wb.matchError}
                </p>
              )}

              {wb.resolveError != null && (
                <p className={styles.phaseWarn} role="status">
                  {wb.resolveError}
                </p>
              )}

              {wb.matching && (
                <p className={styles.phaseText} role="status">
                  Pricing {parsed.lines.length.toLocaleString('en-US')}{' '}
                  {parsed.lines.length === 1 ? 'line' : 'lines'} against the catalog&#8230;
                </p>
              )}

              {!wb.matching && wb.rows.length > 0 && (
                <>
                  <BomTable
                    rows={wb.rows}
                    buildQty={wb.buildQty}
                    onBuildQtyChange={wb.setBuildQty}
                    onPickSimilar={wb.pickSimilar}
                    includeDnp={wb.includeDnp}
                    onIncludeDnpChange={wb.setIncludeDnp}
                  />
                  <ShareBar
                    rows={wb.rows}
                    buildQty={wb.buildQty}
                    includeDnp={wb.includeDnp}
                    onChangeFile={startOver}
                  />
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </motion.div>
  );
}
