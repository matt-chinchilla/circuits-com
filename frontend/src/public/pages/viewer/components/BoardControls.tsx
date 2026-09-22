// The Board panel's Layers and Objects tabs (spec 2026-09-22 §1): what the
// reader can show, hide, fade and light on the board. Both render the page's
// one `BoardViewState` and hand changes back as reducers from `boardView.ts`,
// so the Board tab and the 3D tab can never disagree about what is hidden.
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { NetInfo } from '@public/components/kicad/canvasController';
import {
  CLASSES_2D,
  CLASSES_3D,
  drawnIn3D,
  groupLayers,
  groupVisibility,
  opacityOf,
  setAllLayers,
  setLayerVisible,
  setOpacity,
  toggleLayerHighlight,
  toggleNet,
  type BoardViewState,
  type ClassRow,
  type LayerGroup,
  type LayerGroupId,
  type ObjectClass,
  type PanelLayer,
  type SideFilter,
} from '../boardView';
import styles from './BoardControls.module.scss';

export type BoardContext = 'board' | 'board3d';
export type ViewUpdate = (update: (state: BoardViewState) => BoardViewState) => void;

/** How many nets the list draws at once; the search narrows the rest. */
export const NET_ROWS = 200;

export function netLabel(net: NetInfo): string {
  return net.name === '' ? `Net ${net.number}` : net.name;
}

// ─── Layers ───────────────────────────────────────────────────────────────

export const SIDES: readonly [SideFilter, string][] = [['top', 'Top'], ['bottom', 'Bottom'], ['both', 'Both']];

export interface LayersTabProps {
  context: BoardContext;
  layers: readonly PanelLayer[];
  view: BoardViewState;
  onChange: ViewUpdate;
  /** The Top / Bottom / Both filter: which face's layers are listed. Held by
   *  the panel so it survives a trip to another tab. */
  side: SideFilter;
  onSide: (side: SideFilter) => void;
  /** The groups the reader has folded shut, held by the panel for the same reason. */
  collapsed: ReadonlySet<LayerGroupId>;
  onCollapsed: (collapsed: ReadonlySet<LayerGroupId>) => void;
}

/**
 * The layers as a tree (owner, 2026-09-22): six groups in a fixed order —
 * Copper, Solder mask, Paste mask, Silkscreen, Mechanical, Other — each a
 * row with a chevron, the name, a tri-state box for the whole group and the
 * count, and the layers indented under it. Show all / Hide all and the group
 * boxes act on what is LISTED, so a Top view never resurrects a bottom layer.
 */
export function LayersTab({ context, layers, view, onChange, side, onSide, collapsed, onCollapsed }: LayersTabProps) {
  const ids = useId();
  const groups = useMemo(() => groupLayers(layers, side), [layers, side]);
  const listed = useMemo(() => groups.flatMap((g) => g.layers.map((l) => l.name)), [groups]);
  if (layers.length === 0) {
    return <p className={styles.note}>This board lists no layers that can be shown.</p>;
  }
  const toggleGroup = (id: LayerGroupId) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onCollapsed(next);
  };
  return (
    <div className={styles.section}>
      <div className={styles.toolRow}>
        <div className={styles.seg} role="group" aria-label="Side">
          {SIDES.map(([id, label]) => (
            <button key={id} type="button" className={styles.segBtn} aria-pressed={side === id} onClick={() => onSide(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className={styles.bulk}>
          <button type="button" className={styles.bulkBtn} onClick={() => onChange((s) => setAllLayers(s, listed, true))}>
            Show all
          </button>
          <button type="button" className={styles.bulkBtn} onClick={() => onChange((s) => setAllLayers(s, listed, false))}>
            Hide all
          </button>
        </div>
      </div>
      <p className={styles.help}>Click a layer&#8217;s name to highlight it; click again to clear.</p>
      {groups.length === 0 ? (
        <p className={styles.note}>No layers on this side.</p>
      ) : (
        <ul className={styles.tree} aria-label="Layers">
          {groups.map((group) => (
            <LayerGroupRows
              key={group.id}
              group={group}
              listId={`${ids}-${group.id}`}
              context={context}
              view={view}
              onChange={onChange}
              open={!collapsed.has(group.id)}
              onToggle={() => toggleGroup(group.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function LayerGroupRows({ group, listId, context, view, onChange, open, onToggle }: {
  group: LayerGroup;
  listId: string;
  context: BoardContext;
  view: BoardViewState;
  onChange: ViewUpdate;
  open: boolean;
  onToggle: () => void;
}) {
  const names = group.layers.map((l) => l.name);
  const shown = groupVisibility(view, names);
  return (
    <li className={styles.group}>
      <div className={styles.groupRow}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={shown !== 'none'}
            // The box's third state is a DOM property, not an attribute.
            ref={(el) => {
              if (el != null) el.indeterminate = shown === 'some';
            }}
            aria-label={`Show all ${group.label.toLowerCase()} layers`}
            onChange={() => onChange((s) => setAllLayers(s, names, shown !== 'all'))}
          />
        </label>
        <button
          type="button"
          className={styles.groupToggle}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={onToggle}
        >
          <span className={styles.chevron} aria-hidden="true" />
          <span className={styles.groupName}>{group.label}</span>
          <span className={styles.groupCount}>{group.layers.length}</span>
        </button>
      </div>
      {open && (
        <ul id={listId} className={styles.list} aria-label={group.label}>
          {group.layers.map((layer) => {
            const inert = context === 'board3d' && !drawnIn3D(layer.name);
            const visible = !view.hiddenLayers.has(layer.name);
            const lit = view.highlightedLayer === layer.name;
            return (
              <li key={layer.name} className={styles.row} data-hidden={!visible || undefined} data-inert={inert || undefined}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={visible}
                    disabled={inert}
                    aria-label={`Show ${layer.name}`}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      onChange((s) => setLayerVisible(s, layer.name, on));
                    }}
                  />
                </label>
                <span className={styles.swatch} style={{ background: layer.color }} aria-hidden="true" />
                <button
                  type="button"
                  className={styles.name}
                  aria-pressed={lit}
                  disabled={inert}
                  onClick={() => onChange((s) => toggleLayerHighlight(s, layer.name))}
                >
                  {layer.name}
                </button>
                {inert && <span className={styles.aside}>not in 3D</span>}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

// ─── Objects ──────────────────────────────────────────────────────────────

export interface ObjectsTabProps {
  context: BoardContext;
  nets: readonly NetInfo[];
  view: BoardViewState;
  onChange: ViewUpdate;
}

function ClassControl({ row, view, onChange, last }: {
  row: ClassRow<ObjectClass>;
  view: BoardViewState;
  onChange: ViewUpdate;
  /** The last non-zero opacity per class, so ticking a class back on restores it. */
  last: Map<ObjectClass, number>;
}) {
  const id = useId();
  const opacity = opacityOf(view, row.kind);
  const percent = Math.round(opacity * 100);
  return (
    <li className={styles.classRow} data-hidden={opacity === 0 || undefined}>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={opacity > 0}
          aria-label={`Show ${row.label.toLowerCase()}`}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            if (!on && opacity > 0) last.set(row.kind, opacity);
            onChange((s) => setOpacity(s, row.kind, on ? last.get(row.kind) ?? 1 : 0));
          }}
        />
      </label>
      <label className={styles.className} htmlFor={id}>
        {row.label}
      </label>
      <input
        id={id}
        className={styles.range}
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        aria-valuetext={`${percent}%`}
        onChange={(e) => {
          const value = Number(e.currentTarget.value) / 100;
          if (value > 0) last.set(row.kind, value);
          onChange((s) => setOpacity(s, row.kind, value));
        }}
      />
      <span className={styles.percent} aria-hidden="true">
        {percent}%
      </span>
    </li>
  );
}

export function ObjectsTab({ context, nets, view, onChange }: ObjectsTabProps) {
  const last = useRef(new Map<ObjectClass, number>()).current;
  const rows: readonly ClassRow<ObjectClass>[] = context === 'board' ? CLASSES_2D : CLASSES_3D;
  return (
    <div className={styles.section}>
      <ul className={styles.list} aria-label="Objects">
        {rows.map((row) => (
          <ClassControl key={row.kind} row={row} view={view} onChange={onChange} last={last} />
        ))}
      </ul>
      <NetsList context={context} nets={nets} view={view} onChange={onChange} />
    </div>
  );
}

function NetsList({ context, nets, view, onChange }: ObjectsTabProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const wanted = query.trim().toLowerCase();
  const matches = useMemo(
    () => (wanted === '' ? nets : nets.filter((n) => n.name.toLowerCase().includes(wanted) || String(n.number) === wanted)),
    [nets, wanted],
  );
  const lit = view.highlightedNet == null ? null : nets.find((n) => n.number === view.highlightedNet) ?? null;
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (query !== '') setQuery('');
    else inputRef.current?.blur();
  };
  return (
    <section className={styles.nets} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.netsHead}>
        Nets <span className={styles.count}>{nets.length.toLocaleString('en-US')}</span>
      </h3>
      {nets.length === 0 ? (
        <p className={styles.note}>This board names no nets.</p>
      ) : (
        <>
          <input
            ref={inputRef}
            className={styles.netSearch}
            type="text"
            inputMode="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Find a net, e.g. GND"
            aria-label="Find a net"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          {lit != null && (
            <p className={styles.lit}>
              <span className={styles.litName}>{netLabel(lit)}</span>
              <button type="button" className={styles.litClear} onClick={() => onChange((s) => ({ ...s, highlightedNet: null }))}>
                Clear
              </button>
            </p>
          )}
          {context === 'board3d' && <p className={styles.help}>In 3D a net lights on the outer copper only.</p>}
          {matches.length === 0 ? (
            <p className={styles.note}>No net matches &#8220;{query.trim()}&#8221;.</p>
          ) : (
            <ul className={styles.netList} aria-label="Nets">
              {matches.slice(0, NET_ROWS).map((net) => (
                <li key={net.number}>
                  <button
                    type="button"
                    className={styles.net}
                    aria-pressed={view.highlightedNet === net.number}
                    onClick={() => onChange((s) => toggleNet(s, net.number))}
                  >
                    {netLabel(net)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {matches.length > NET_ROWS && (
            <p className={styles.note}>
              Showing {NET_ROWS} of {matches.length.toLocaleString('en-US')}. Type to narrow the list.
            </p>
          )}
        </>
      )}
    </section>
  );
}
