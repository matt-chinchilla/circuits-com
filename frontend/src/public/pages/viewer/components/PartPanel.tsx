// The identification panel: one place, on every tab, that says what the
// selected part IS — its designator, value and footprint; where it lives on
// the sheet and the board; how many the BOM buys and with which siblings; and,
// once the BOM has been priced, its catalog match and best price with a way
// to the part page. Desktop: a rail beside the stage. Phone: a sheet along the
// bottom that peeks the essentials and opens on a tap.
//
// It renders a `PartFacts` record and nothing else; every number here was read
// from the project by `partFacts`, and an absent fact is an em dash.
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatUnit } from '@public/services/bom/format';
import { footprintName, formatMm, type PartFacts } from '../partFacts';
import styles from './PartPanel.module.scss';

export type ShowOn = 'schematic' | 'board' | 'board3d';

export interface PartPanelHandle {
  focusSearch(): void;
}

export interface PartPanelProps {
  facts: PartFacts | null;
  /** Every designator the project names — the search's suggestions. */
  knownRefs: readonly string[];
  /** Which drawings this project offers, for the "Show on" row. */
  views: Record<ShowOn, boolean>;
  /** The tab that is live, so its "Show on" button reads as pressed. */
  current: ShowOn | null;
  /** A reference the reader typed. The page resolves it against the project. */
  onSearch: (text: string) => void;
  onClear: () => void;
  onShow: (view: ShowOn) => void;
  /** Opens the BOM tab, which is what prices the project. */
  onPriceBom: () => void;
  /** The search field took focus — the page reads the board's placements then. */
  onSearchFocus?: () => void;
}

const DASH = '—';
const SIDE: Record<'F' | 'B', string> = { F: 'Front', B: 'Back' };
const MATCH_LABEL = { exact: 'Exact match', approx: 'Similar part', live: 'Live match' } as const;
const LIFECYCLE_LABEL: Record<string, string> = { active: 'Active', nrnd: 'Not for new designs', obsolete: 'Obsolete' };

/** `io_banks.kicad_sch` → `io_banks`. */
function sheetName(path: string): string {
  return path.split('/').pop()?.replace(/\.kicad_sch$/i, '') ?? path;
}

const PartPanel = forwardRef<PartPanelHandle, PartPanelProps>(function PartPanel(
  { facts, knownRefs, views, current, onSearch, onClear, onShow, onPriceBom, onSearchFocus },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const listId = useId();
  // Phone only: the sheet is either peeking (one row) or open. A new selection
  // peeks — the essentials are on that row and the drawing the reader just
  // tapped stays in view; a tap on the row opens the rest.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [facts?.ref]);

  useImperativeHandle(ref, () => ({
    focusSearch: () => {
      setOpen(true);
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const wanted = text.trim();
    if (wanted === '') return;
    onSearch(wanted);
    setText('');
    inputRef.current?.blur();
  };

  const peekLine = facts == null
    ? null
    : facts.found
      ? [facts.value, facts.price == null ? null : formatUnit(facts.price.unit)].filter((s) => s != null && s !== '').join(' · ')
      : 'Not in this project';

  return (
    <aside className={styles.panel} aria-label="Part" data-open={open || undefined}>
      <button
        type="button"
        className={styles.peek}
        aria-expanded={open}
        aria-controls={`${listId}-body`}
        aria-label={open ? 'Hide part details' : facts == null ? 'Select a part, or search a reference' : `${facts.ref}, ${peekLine ?? ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <span className={styles.peekEmpty}>Part</span>
        ) : facts == null ? (
          <span className={styles.peekEmpty}>Select a part, or search a reference</span>
        ) : (
          <>
            <span className={styles.peekRef}>{facts.ref}</span>
            <span className={styles.peekMeta}>{peekLine}</span>
          </>
        )}
        <span className={styles.peekChevron} aria-hidden="true" />
      </button>

      <div id={`${listId}-body`} className={styles.body}>
        <form className={styles.search} onSubmit={submit} role="search">
          <input
            ref={inputRef}
            className={styles.searchInput}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            list={listId}
            placeholder="Find a reference, e.g. U30"
            aria-label="Find a reference"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={onSearchFocus}
          />
          <kbd className={styles.key} aria-hidden="true">/</kbd>
          <datalist id={listId}>
            {knownRefs.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </form>

        {facts == null && (
          <div className={styles.empty}>
            <p className={styles.emptyLead}>
              Click a part on the schematic, board or 3D view, or search a reference above, to identify it.
            </p>
            <p className={styles.hints}>
              <kbd className={styles.key}>/</kbd> search
              <kbd className={styles.key}>Esc</kbd> clear
            </p>
          </div>
        )}

        {facts != null && !facts.found && (
          <div className={styles.head}>
            <p className={styles.ref}>{facts.ref}</p>
            <p className={styles.missing}>Not in this project. Check the designator and try again.</p>
            <button type="button" className={styles.clear} onClick={onClear} aria-label="Clear selection">
              &#215;
            </button>
          </div>
        )}

        {facts != null && facts.found && (
          <>
            <div className={styles.head}>
              <p className={styles.ref}>{facts.ref}</p>
              <p className={styles.value}>{facts.value ?? DASH}</p>
              <p className={styles.footprint}>{facts.footprint == null ? 'No footprint named' : footprintName(facts.footprint)}</p>
              <button type="button" className={styles.clear} onClick={onClear} aria-label="Clear selection">
                &#215;
              </button>
            </div>

            <dl className={styles.facts}>
              <dt>Sheet</dt>
              <dd>{facts.sheet == null ? DASH : sheetName(facts.sheet)}</dd>
              <dt>Side</dt>
              <dd>{facts.placement == null ? DASH : SIDE[facts.placement.side]}</dd>
              <dt>Position</dt>
              <dd className={styles.num}>
                {facts.placement == null ? DASH : `${formatMm(facts.placement.x)}, ${formatMm(facts.placement.y)} mm`}
              </dd>
              <dt>Rotation</dt>
              <dd className={styles.num}>{facts.placement == null ? DASH : `${formatMm(facts.placement.rotDeg)}°`}</dd>
              <dt>In BOM</dt>
              <dd>
                {facts.line == null
                  ? 'No'
                  : facts.siblings.length === 0
                    ? `${facts.line.qty} on its own line`
                    : `${facts.line.qty} on a line with ${facts.siblings.slice(0, 6).join(', ')}${facts.siblings.length > 6 ? ` and ${facts.siblings.length - 6} more` : ''}`}
              </dd>
              {facts.mpn != null && (
                <>
                  <dt>Part number</dt>
                  <dd className={styles.num}>{facts.mpn}</dd>
                </>
              )}
              {facts.line?.dnp && (
                <>
                  <dt>Fit</dt>
                  <dd>Do not populate</dd>
                </>
              )}
            </dl>

            <section className={styles.catalog} aria-label="Catalog">
              {!facts.priced && facts.line != null && (
                <button type="button" className={styles.priceBtn} onClick={onPriceBom}>
                  Price the BOM to see its catalog match
                </button>
              )}
              {!facts.priced && facts.line == null && (
                <p className={styles.note}>Not on the BOM, so it has no price.</p>
              )}
              {facts.priced && facts.resolving && <p className={styles.note}>Looking this part up live&#8230;</p>}
              {facts.priced && !facts.resolving && facts.catalog == null && facts.line != null && (
                <p className={styles.note}>No catalog match for this line.</p>
              )}
              {facts.priced && facts.catalog != null && (
                <>
                  <p className={styles.matchLine}>
                    <span className={styles.match} data-match={facts.catalog.match ?? 'none'}>
                      {facts.catalog.match == null ? 'No match' : MATCH_LABEL[facts.catalog.match]}
                    </span>
                    {facts.catalog.lifecycle != null && (
                      <span className={styles.lifecycle}>{LIFECYCLE_LABEL[facts.catalog.lifecycle] ?? facts.catalog.lifecycle}</span>
                    )}
                  </p>
                  <p className={styles.sku}>
                    <Link to={facts.catalog.path}>{facts.catalog.sku}</Link>
                    {facts.catalog.manufacturer != null && <span className={styles.maker}>{facts.catalog.manufacturer}</span>}
                  </p>
                  {facts.catalog.description != null && <p className={styles.desc}>{facts.catalog.description}</p>}
                  {facts.price == null ? (
                    <p className={styles.note}>No distributor has it in stock.</p>
                  ) : (
                    <p className={styles.price}>
                      <span className={styles.priceUnit}>{formatUnit(facts.price.unit)}</span>
                      <span className={styles.priceMeta}>
                        each at {facts.price.lineQty.toLocaleString('en-US')} from {facts.price.supplier},{' '}
                        {facts.price.stock.toLocaleString('en-US')} in stock
                      </span>
                    </p>
                  )}
                  <Link className={styles.partLink} to={facts.catalog.path}>
                    Open the part page
                  </Link>
                </>
              )}
            </section>

            <div className={styles.show} role="group" aria-label="Show on">
              <span className={styles.showLabel}>Show on</span>
              {views.schematic && (
                <button type="button" className={styles.showBtn} aria-pressed={current === 'schematic'} onClick={() => onShow('schematic')}>
                  Schematic
                </button>
              )}
              {views.board && (
                <button type="button" className={styles.showBtn} aria-pressed={current === 'board'} onClick={() => onShow('board')}>
                  Board
                </button>
              )}
              {views.board3d && (
                <button type="button" className={styles.showBtn} aria-pressed={current === 'board3d'} onClick={() => onShow('board3d')}>
                  3D
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
});

export default PartPanel;
