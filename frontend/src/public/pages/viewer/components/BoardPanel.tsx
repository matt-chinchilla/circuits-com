// The Board panel (spec 2026-09-22 §1): three tabs beside the stage. PARTS is
// the identification panel: one place, on every tab, that says what the
// selected part IS — its designator, value and footprint; where it lives on
// the sheet and the board; how many the BOM buys and with which siblings; and,
// once the BOM has been priced, its catalog match and best price with a way
// to the part page. Desktop: a rail beside the stage. Phone: a sheet along the
// bottom that peeks the essentials and opens on a tap.
//
// It renders a `PartFacts` record and nothing else; every number here was read
// from the project by `partFacts`, and an absent fact is an em dash.
//
// LAYERS and OBJECTS (BoardControls.tsx) show, hide, fade and light what the
// Board and 3D tabs draw, from the page's one `BoardViewState`. They are
// offered only for a project with a board, and are disabled — with the reason
// — while neither drawing of the board is on screen.
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import type { NetInfo } from '@public/components/kicad/canvasController';
import { formatUnit } from '@public/services/bom/format';
import { footprintName, formatMm, type PartFacts } from '../partFacts';
import type { BoardViewState, PanelLayer } from '../boardView';
import { LayersTab, ObjectsTab, type BoardContext, type ViewUpdate } from './BoardControls';
import styles from './BoardPanel.module.scss';

export type ShowOn = 'schematic' | 'board' | 'board3d';

export interface BoardPanelHandle {
  focusSearch(): void;
}

export type PanelTab = 'parts' | 'layers' | 'objects';

/** The board half of the panel. Absent for a project with no board: the
 *  panel is then the part panel alone, with no tabs. */
export interface BoardPanelBoard {
  /** Which drawing of the board is on screen, or null — the Layers and
   *  Objects tabs are disabled then, and `hint` says why. */
  context: BoardContext | null;
  hint: string;
  layers: readonly PanelLayer[];
  nets: readonly NetInfo[];
  view: BoardViewState;
  onChange: ViewUpdate;
  /** The reader opened Layers or Objects: the page reads the board's tables then. */
  onOpen?: () => void;
}

export interface BoardPanelProps {
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
  board?: BoardPanelBoard | null;
}

const DASH = '—';
const SIDE: Record<'F' | 'B', string> = { F: 'Front', B: 'Back' };
const MATCH_LABEL = { exact: 'Exact match', approx: 'Similar part', live: 'Live match' } as const;
const LIFECYCLE_LABEL: Record<string, string> = { active: 'Active', nrnd: 'Not for new designs', obsolete: 'Obsolete' };
const SHOW_ON: readonly [ShowOn, string][] = [['schematic', 'Schematic'], ['board', 'Board'], ['board3d', '3D']];
const PANEL_TABS: readonly [PanelTab, string][] = [['parts', 'Parts'], ['layers', 'Layers'], ['objects', 'Objects']];

/** `io_banks.kicad_sch` → `io_banks`. */
function sheetName(path: string): string {
  return path.split('/').pop()?.replace(/\.kicad_sch$/i, '') ?? path;
}

const BoardPanel = forwardRef<BoardPanelHandle, BoardPanelProps>(function BoardPanel(
  { facts, knownRefs, views, current, onSearch, onClear, onShow, onPriceBom, onSearchFocus, board },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const listId = useId();
  const tabIds = useId();
  const [panelTab, setPanelTab] = useState<PanelTab>('parts');
  const tabRefs = useRef<Partial<Record<PanelTab, HTMLButtonElement | null>>>({});
  /** A tab is offered when the project has a board; Layers and Objects are
   *  usable only while a drawing of it is on screen. */
  const usable = (id: PanelTab) => id === 'parts' || (board != null && board.context != null);
  // Without a board there is nothing but Parts to show.
  const shownTab: PanelTab = board == null ? 'parts' : panelTab;
  // Phone only: the sheet is either peeking (one row) or open. A selection made
  // OUTSIDE the panel peeks — the essentials are on that row and the drawing
  // the reader just tapped stays in view; a tap on the row opens the rest. A
  // selection made from the panel's own search stays open: the reader opened
  // the sheet to ask, and collapsing it would hide the answer.
  const [open, setOpen] = useState(false);
  /** What the search just asked for, until the selection it caused arrives. */
  const searched = useRef<string | null>(null);
  useEffect(() => {
    const asked = searched.current;
    searched.current = null;
    if (asked != null && facts != null && facts.ref.toUpperCase() === asked.toUpperCase()) return;
    setOpen(false);
    // A part picked on a drawing is a question about that part: answer it on
    // the Parts tab, whichever tab the reader was on.
    if (facts != null) setPanelTab('parts');
    // Keyed on the designator alone: a re-priced line must not collapse the sheet.
  }, [facts?.ref]);

  useImperativeHandle(ref, () => ({
    focusSearch: () => {
      // The search lives on the Parts tab, which must be in the DOM to take focus.
      flushSync(() => {
        setOpen(true);
        setPanelTab('parts');
      });
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const wanted = text.trim();
    if (wanted === '') return;
    searched.current = wanted;
    onSearch(wanted);
    setText('');
    inputRef.current?.blur();
  };

  /** Esc in the field: empty it first; empty already, leave the field and
   *  clear the selection — the same Esc the rest of the page answers. */
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (text !== '') {
      setText('');
      return;
    }
    inputRef.current?.blur();
    onClear();
  };

  const peekLine = facts == null
    ? null
    : facts.found
      ? [facts.value, facts.price == null ? null : formatUnit(facts.price.unit)].filter((s) => s != null && s !== '').join(' · ')
      : 'Not in this project';

  const choose = (id: PanelTab) => {
    if (!usable(id)) return;
    setPanelTab(id);
    if (id !== 'parts') board?.onOpen?.();
  };

  /** The same roving tablist as the page's own: one tab stop, the arrows and
   *  Home/End move focus and selection, skipping a tab that is disabled. */
  const onTabKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const open = PANEL_TABS.map(([id]) => id).filter(usable);
    const here = open.indexOf(shownTab);
    let next: number;
    if (e.key === 'ArrowRight') next = (here + 1) % open.length;
    else if (e.key === 'ArrowLeft') next = (here - 1 + open.length) % open.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = open.length - 1;
    else return;
    const target = open[next];
    if (target == null) return;
    e.preventDefault();
    choose(target);
    tabRefs.current[target]?.focus();
  };

  const tabId = (id: PanelTab) => `${tabIds}-tab-${id}`;
  const panelId = (id: PanelTab) => `${tabIds}-panel-${id}`;
  const hintId = `${tabIds}-hint`;
  const openLabel = PANEL_TABS.find(([id]) => id === shownTab)?.[1] ?? 'Part';

  return (
    <aside className={styles.panel} aria-label={board == null ? 'Part' : 'Board panel'} data-open={open || undefined}>
      <button
        type="button"
        className={styles.peek}
        aria-expanded={open}
        aria-controls={`${listId}-body`}
        aria-label={open ? 'Hide part details' : facts == null ? 'Select a part, or search a reference' : `${facts.ref}, ${peekLine ?? ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <span className={styles.peekEmpty}>{board == null ? 'Part' : openLabel}</span>
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
        {board != null && (
          <div className={styles.tabs} role="tablist" aria-label="Board panel" onKeyDown={onTabKeys}>
            {board.context == null && (
              <span id={hintId} className={styles.srOnly}>
                {board.hint}
              </span>
            )}
            {PANEL_TABS.map(([id, label]) => {
              const disabled = !usable(id);
              return (
                <button
                  key={id}
                  id={tabId(id)}
                  type="button"
                  role="tab"
                  className={styles.tab}
                  aria-selected={shownTab === id}
                  aria-controls={shownTab === id ? panelId(id) : undefined}
                  aria-disabled={disabled || undefined}
                  aria-describedby={disabled ? hintId : undefined}
                  title={disabled ? board.hint : undefined}
                  tabIndex={shownTab === id ? 0 : -1}
                  ref={(el) => {
                    tabRefs.current[id] = el;
                  }}
                  onClick={() => choose(id)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {board != null && shownTab !== 'parts' && (
          <div id={panelId(shownTab)} role="tabpanel" aria-labelledby={tabId(shownTab)} className={styles.tabBody}>
            {board.context == null ? (
              <p className={styles.note}>{board.hint}</p>
            ) : shownTab === 'layers' ? (
              <LayersTab context={board.context} layers={board.layers} view={board.view} onChange={board.onChange} />
            ) : (
              <ObjectsTab context={board.context} nets={board.nets} view={board.view} onChange={board.onChange} />
            )}
          </div>
        )}

        {shownTab === 'parts' && (
          <div
            id={board == null ? undefined : panelId('parts')}
            role={board == null ? undefined : 'tabpanel'}
            aria-labelledby={board == null ? undefined : tabId('parts')}
            className={styles.tabBody}
          >
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
                onKeyDown={onSearchKey}
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
                  {SHOW_ON.filter(([view]) => views[view]).map(([view, label]) => (
                    <button key={view} type="button" className={styles.showBtn} aria-pressed={current === view} onClick={() => onShow(view)}>
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
});

export default BoardPanel;
