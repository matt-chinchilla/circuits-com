// FlowsPanel — one Sankey card on the Site Analytics tab, in the place of
// the bar chart it replaced (owner, 2026-09-11: the flows were meant to take
// over "Traffic Sources" and "Popular Parts", not sit above them).
//
// "traffic": one session flows from where it came from, to the page it
// landed on, to what it did next. "parts": one part-page view flows from
// category, to subcategory, to the brand — and on to the distributor it
// clicked out to, once there are enough clicks to read (a twelve-click column
// is hairlines and a huge "stayed" band; below the floor the clicks live in
// the caption instead).
//
// The exact figures the old chart showed stay one click away: the Flow /
// Numbers switch swaps the Sankey for a plain table of the SAME rows the bar
// chart drew (referrer sites → views; part pages → views), because a flow
// diagram is for reading a story and a table is for quoting a number.
//
// Reads through the query cache like the rest of Reports, so a revisit paints
// from memory; the previous flow stays up while a range/segment change loads.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsType } from 'echarts/core'
import EChart from '@admin/components/charts/EChart'
import { installSankeyPin, type SankeyPin } from '@admin/components/charts/sankeyPin'
import { LAST_COLUMN_LABEL_ROOM, sankeyOption } from '@admin/components/charts/options'
import { adminApi } from '@admin/services/adminApi'
import { useCachedQuery, type DataScope } from '@admin/services/queryCache'
import type { AnalyticsSegment, FlowPayload } from '@admin/types/admin'
import styles from './ReportsPage.module.scss'

const TRAFFIC_SCOPES: readonly DataScope[] = ['traffic']
const PARTS_FLOW_SCOPES: readonly DataScope[] = ['traffic', 'catalog']

type FlowKind = FlowPayload['kind']
type View = 'flow' | 'numbers'

/** Distributor clicks in the window before the fourth column is drawn. */
export const MIN_CLICKS_TO_DRAW = 30
/** Below this the columns stack vertically — three labelled columns need
 *  ~700px of width to keep their labels off each other. */
const NARROW_QUERY = '(max-width: 720px)'

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY)
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

const SEGMENT_LABEL: Record<AnalyticsSegment, string> = {
  humans: 'people only',
  bots: 'crawlers only',
  all: 'everyone, crawlers included',
}

const TITLE: Record<FlowKind, string> = {
  traffic: 'Where visitors come from, and what they do next',
  parts: 'Which parts people look at, by category and brand',
}

/** Assemble the drawable flow: the distributor column joins only past the floor. */
export function drawableFlow(flow: FlowPayload, minClicks = MIN_CLICKS_TO_DRAW) {
  const withDistributors = flow.kind === 'parts' && (flow.clicks_total ?? 0) >= minClicks
  return {
    nodes: withDistributors ? [...flow.nodes, ...(flow.distributor_nodes ?? [])] : flow.nodes,
    links: withDistributors ? [...flow.links, ...(flow.distributor_links ?? [])] : flow.links,
    columns: withDistributors ? [...flow.columns, 'Distributor'] : flow.columns,
    withDistributors,
  }
}

/** Pixels per node in the widest column, plus chrome; clamped to the card. */
export function flowHeight(nodes: readonly { column: number }[], narrow: boolean): number {
  const perColumn = new Map<number, number>()
  for (const n of nodes) perColumn.set(n.column, (perColumn.get(n.column) ?? 0) + 1)
  const widest = Math.max(0, ...perColumn.values())
  if (narrow) return Math.min(900, Math.max(640, 44 * widest + 120))
  return Math.min(760, Math.max(440, 28 * widest + 80))
}

/** The Numbers view: the SAME rows the replaced bar chart drew. */
export interface NumberRows {
  /** Heading of the label column ("Site", "Part"). */
  label: string
  /** Heading of the value column ("Views"). */
  value: string
  rows: ReadonlyArray<readonly [string, number]>
}

/** Rows with each one's share of the table's own total, for the third column. */
export function withShare(
  rows: ReadonlyArray<readonly [string, number]>,
): Array<{ label: string; value: number; share: string }> {
  const total = rows.reduce((sum, [, v]) => sum + (Number(v) || 0), 0)
  return rows.map(([label, value]) => ({
    label,
    value,
    share: total > 0 ? `${((100 * value) / total).toFixed(1)}%` : '—',
  }))
}

interface FlowsPanelProps {
  kind: FlowKind
  days: number
  segment: AnalyticsSegment
  numbers: NumberRows
}

export default function FlowsPanel({ kind, days, segment, numbers }: FlowsPanelProps) {
  const [view, setView] = useState<View>('flow')
  const narrow = useNarrow()
  const query = useCachedQuery(
    `reports:flow:${kind}:${days}:${segment}`,
    () => adminApi.getFlow(kind, days, segment),
    // The parts flow labels views with catalog names, so a catalog change
    // (the nightly import) is a change to it too.
    { keepPrevious: true, scopes: kind === 'parts' ? PARTS_FLOW_SCOPES : TRAFFIC_SCOPES },
  )
  const flow = query.data

  // The card grows with its widest column so a dozen subcategories are
  // bands, not hairlines; capped so a phone never scrolls a wall of chart.
  const height = useMemo(() => {
    if (!flow) return narrow ? 640 : 440
    return flowHeight(drawableFlow(flow).nodes, narrow)
  }, [flow, narrow])

  const columns = flow ? drawableFlow(flow).columns : []

  const option = useMemo(() => {
    if (!flow || flow.total === 0) return null
    const { nodes, links } = drawableFlow(flow)
    return sankeyOption({
      nodes,
      links,
      unit: flow.unit,
      total: flow.total,
      orient: narrow ? 'vertical' : 'horizontal',
    })
  }, [flow, narrow])

  // Click-to-keep: one pin per chart INSTANCE (EChart re-inits under
  // StrictMode and hands each instance to onReady), forgotten whenever the
  // option is rebuilt, unbound when the panel goes.
  const pinRef = useRef<SankeyPin | null>(null)
  const onReady = useCallback((chart: EChartsType) => {
    pinRef.current?.uninstall()
    pinRef.current = installSankeyPin(chart)
  }, [])
  useEffect(() => {
    pinRef.current?.reset()
  }, [option])
  useEffect(
    () => () => {
      pinRef.current?.uninstall()
      pinRef.current = null
    },
    [],
  )

  const tableRows = useMemo(() => withShare(numbers.rows), [numbers.rows])

  const caption =
    view === 'numbers'
      ? `The figures behind the flow · last ${days} days · ${SEGMENT_LABEL[segment]}`
      : flow
        ? `${flow.total.toLocaleString()} ${flow.unit} · last ${days} days · ${SEGMENT_LABEL[segment]}`
        : query.error !== undefined
          ? 'Couldn’t load this flow.'
          : 'Loading…'

  const note =
    kind === 'traffic'
      ? 'Hover a band to follow it; click to keep it lit. Direct is every visit that arrived without a referrer — typed, bookmarked, or sent by an app that strips one, which Reddit’s app and most email clients do.'
      : flow && (flow.clicks_total ?? 0) > 0 && (flow.clicks_total ?? 0) < MIN_CLICKS_TO_DRAW
        ? `Hover a band to follow it; click to keep it lit. Top brands by part views; a brand’s tooltip lists its most-viewed parts. ${flow.clicks_total} click${flow.clicks_total === 1 ? '' : 's'} out to distributors so far — that column appears at ${MIN_CLICKS_TO_DRAW}.`
        : 'Hover a band to follow it; click to keep it lit. Top brands by part views; a brand’s tooltip lists its most-viewed parts. Distributor clicks join as a fourth column once there are enough to read.'

  return (
    <section className={`${styles.chartCard} ${styles.chartFull} ${styles.flowCard}`} aria-label={TITLE[kind]}>
      <div className={`${styles.chartHead} ${styles.flowHead}`}>
        <div className={styles.flowHeadText}>
          <h3 className={styles.chartTitle}>{TITLE[kind]}</h3>
          <span className={styles.chartSub}>{caption}</span>
        </div>
        <div className={`${styles.seg} ${styles.flowSeg}`} role="group" aria-label="Flow or numbers">
          {(['flow', 'numbers'] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`${styles.segBtn} ${view === v ? styles.on : ''}`}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v === 'flow' ? 'Flow' : 'Numbers'}
            </button>
          ))}
        </div>
      </div>

      {view === 'numbers' ? (
        <div className={styles.tableScroll}>
          {tableRows.length === 0 ? (
            <div className={styles.flowEmpty} style={{ height: 160 }}>
              No {numbers.value.toLowerCase()} in this window yet.
            </div>
          ) : (
            <table className={styles.flowTable}>
              <thead>
                <tr>
                  <th>{numbers.label}</th>
                  <th className={styles.flowNum}>{numbers.value}</th>
                  <th className={styles.flowNum}>Share</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => (
                  <tr key={r.label}>
                    <td className={styles.flowLabel} title={r.label}>
                      {r.label}
                    </td>
                    <td className={styles.flowNum}>{r.value.toLocaleString()}</td>
                    <td className={`${styles.flowNum} ${styles.flowShare}`}>{r.share}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <>
          {option && columns.length > 0 && (
            // Headings in the DOM, spread across the columns' real extent: the
            // first sits on the first column's left edge, the last on the last
            // column's (the chart keeps LAST_COLUMN_LABEL_ROOM free right of it).
            <div
              className={styles.flowColumns}
              style={narrow ? undefined : { paddingRight: LAST_COLUMN_LABEL_ROOM }}
              aria-hidden="true"
            >
              {narrow ? (
                <span>{columns.join(' → ')}</span>
              ) : (
                columns.map((c) => <span key={c}>{c}</span>)
              )}
            </div>
          )}
          {option ? (
            <EChart option={option} className={styles.flowChart} style={{ height }} onReady={onReady} />
          ) : (
            <div className={styles.flowEmpty} style={{ height }}>
              {query.loading ? 'Loading…' : `No ${flow?.unit ?? 'traffic'} in this window yet.`}
            </div>
          )}
          <p className={styles.flowNote}>{note}</p>
        </>
      )}
    </section>
  )
}
