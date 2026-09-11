// FlowsPanel — the two Sankeys on the Site Analytics tab.
//
// "Traffic sources": one session flows from where it came from, to the page
// it landed on, to what it did next. "Part popularity": one part-page view
// flows from category, to subcategory, to the part — and on to the
// distributor it clicked out to, once there are enough clicks to read (a
// twelve-click column is hairlines and a huge "stayed" band; below the floor
// the clicks live in the caption instead).
//
// Both read through the query cache like the rest of Reports, so a revisit
// paints from memory; the previous flow stays up while a range/segment change
// loads so the toggle never blanks the chart.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EChartsType } from 'echarts/core'
import EChart from '@admin/components/charts/EChart'
import { installSankeyPin, type SankeyPin } from '@admin/components/charts/sankeyPin'
import { LAST_COLUMN_LABEL_ROOM, sankeyOption } from '@admin/components/charts/options'
import { adminApi } from '@admin/services/adminApi'
import { useCachedQuery } from '@admin/services/queryCache'
import type { AnalyticsSegment, FlowPayload } from '@admin/types/admin'
import styles from './ReportsPage.module.scss'

type FlowKind = FlowPayload['kind']

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

interface FlowsPanelProps {
  days: number
  segment: AnalyticsSegment
}

export default function FlowsPanel({ days, segment }: FlowsPanelProps) {
  const [kind, setKind] = useState<FlowKind>('traffic')
  const narrow = useNarrow()
  const query = useCachedQuery(
    `reports:flow:${kind}:${days}:${segment}`,
    () => adminApi.getFlow(kind, days, segment),
    { keepPrevious: true },
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

  const caption = flow
    ? `${flow.total.toLocaleString()} ${flow.unit} · last ${days} days · ${SEGMENT_LABEL[segment]}`
    : query.error !== undefined
      ? 'Couldn’t load this flow.'
      : 'Loading…'

  const shownKind = flow?.kind ?? kind
  const note =
    shownKind === 'traffic'
      ? 'Hover a band to follow it; click to keep it lit. Direct is every visit that arrived without a referrer — typed, bookmarked, or sent by an app that strips one, which Reddit’s app and most email clients do.'
      : flow && (flow.clicks_total ?? 0) > 0 && (flow.clicks_total ?? 0) < MIN_CLICKS_TO_DRAW
        ? `Hover a band to follow it; click to keep it lit. Top brands by part views; a brand’s tooltip lists its most-viewed parts. ${flow.clicks_total} click${flow.clicks_total === 1 ? '' : 's'} out to distributors so far — that column appears at ${MIN_CLICKS_TO_DRAW}.`
        : 'Hover a band to follow it; click to keep it lit. Top brands by part views; a brand’s tooltip lists its most-viewed parts. Distributor clicks join as a fourth column once there are enough to read.'

  return (
    <section className={`${styles.chartCard} ${styles.flowCard}`} aria-label="Visitor flows">
      <div className={styles.chartHead}>
        <div className={styles.flowHeadText}>
          {/* Titled off the flow on screen, not the toggle: with keepPrevious
              the previous chart stays up for one round trip after a click. */}
          <h3 className={styles.chartTitle}>{TITLE[flow?.kind ?? kind]}</h3>
          <span className={styles.chartSub}>{caption}</span>
        </div>
        <div className={styles.seg} role="group" aria-label="Which flow">
          {(['traffic', 'parts'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`${styles.segBtn} ${kind === k ? styles.on : ''}`}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
            >
              {k === 'traffic' ? 'Traffic sources' : 'Part popularity'}
            </button>
          ))}
        </div>
      </div>

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
    </section>
  )
}
