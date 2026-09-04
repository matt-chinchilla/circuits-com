import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { adminApi } from '@admin/services/adminApi';
import { useCachedQuery } from '@admin/services/queryCache';
import type { OrgLocation, OrganizationsResponse, VisitorOrganization } from '@admin/services/adminApi';
import type { AnalyticsSegment } from '@admin/types/admin';
import { deviceSplitLabel, formatLastSeen } from '../cityIntel';
import { flagEmoji, refHost } from '../chartKit';
import { countryName } from '@admin/services/country';
import {
  FILTER_LABEL,
  KIND_BADGE,
  matchBadge,
  ORG_FILTERS,
  ORG_SORTS,
  sortOrganizations,
  emptyMessage,
  filterCount,
  filterOrganizations,
  locationLabel,
  locationSummary,
  visitorLine,
  type OrgFilter,
  type OrgSort,
} from './orgRows';
import styles from './OrganizationsPanel.module.scss';

/**
 * Visiting Organizations — the "which companies are on the site" panel.
 *
 * It reads ONE axis of the same rows the map above it plots
 * (`page_views.network`, the AS organization) and sorts them into companies,
 * consumer ISPs and hosting. It fetches for itself rather than taking the
 * analytics payload as a prop: the organization roll-up is a different set of
 * aggregations and putting it in /dashboard/analytics would make every load of
 * the Site Analytics tab pay for a panel most visits never expand.
 *
 * `days` and `segment` come from the page's own controls, so the two panels
 * always describe the same window.
 */
interface Props {
  days: number;
  segment: AnalyticsSegment;
  /** A location the reader clicked in "Where & how". The page passes it to
   *  the map panel, which shows the place on whichever view is open. Absent
   *  when no map is mounted, and every location then renders as plain text —
   *  a control that goes nowhere is worse than a label. */
  onFocusLocation?: (location: OrgLocation) => void;
  /** The countries the map will actually open — `analytics.region_countries`,
   *  the SAME list the map gates its own two doors on. This roll-up keeps
   *  country-only rows on purpose ("a country with no city is still an
   *  answer"), so it routinely lists countries the map refuses to drill into;
   *  without this those rendered as buttons onto the "Collecting" overlay.
   *  Absent means "gate nothing", which is the pre-region behaviour. */
  focusableCountries?: readonly string[];
}

type Status = 'loading' | 'ready' | 'error';

export default function OrganizationsPanel({
  days,
  segment,
  onFocusLocation,
  focusableCountries,
}: Props) {
  const [filter, setFilter] = useState<OrgFilter>('corporate');
  const [sort, setSort] = useState<OrgSort>('visitors');
  const [openName, setOpenName] = useState<string | null>(null);

  // Keyed on the window and segment, so a late response for an older pair
  // can never overwrite a newer one, and a pair the operator already looked at
  // renders from memory. (The Site tab unmounts this panel on every tab
  // switch; the cache is what makes coming back free.)
  const query = useCachedQuery(`reports:orgs:${days}:${segment}`, () =>
    adminApi.getOrganizations(days, segment),
  );
  const data: OrganizationsResponse | null = query.data ?? null;
  const status: Status =
    query.loading ? 'loading' : query.error !== undefined && data === null ? 'error' : 'ready';

  const counts = {
    corporate: data?.corporate_count ?? 0,
    isp: data?.isp_count ?? 0,
    hosting: data?.hosting_count ?? 0,
    matched: data?.matched_count ?? 0,
  };
  // A Set once per render rather than an `includes` per location row.
  // `undefined` (an API that predates region capture) means gate nothing.
  const focusable = useMemo(
    () => (focusableCountries ? new Set(focusableCountries) : null),
    [focusableCountries],
  );
  const rows = sortOrganizations(
    filterOrganizations(data?.organizations ?? [], filter),
    sort,
  );

  return (
    <section className={styles.orgCard} aria-labelledby="org-panel-title">
      <div className={styles.orgHead}>
        <h3 className={styles.orgTitle} id="org-panel-title">
          Visiting Organizations
        </h3>
        <span className={styles.orgSub}>
          By network operator · last {data?.period_days ?? days}d
        </span>
      </div>

      <div className={styles.chipRow} role="group" aria-label="Organization type">
        {ORG_FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            className={`${styles.chip} ${filter === key ? styles.chipOn : ''}`}
            data-filter={key}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {FILTER_LABEL[key]}
            <span className={styles.chipCount}>{filterCount(counts, key)}</span>
          </button>
        ))}
      </div>

      {/* Sort sits under the chips, not among them: the chips choose WHICH
          organizations, this chooses their ORDER, and merging the two rows
          would read as one set of mutually exclusive options. */}
      <div className={styles.sortRow}>
        <span className={styles.sortLabel} id="org-sort-label">
          Sort
        </span>
        <div role="group" aria-labelledby="org-sort-label" className={styles.sortGroup}>
          {ORG_SORTS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`${styles.sortBtn} ${sort === key ? styles.sortOn : ''}`}
              aria-pressed={sort === key}
              onClick={() => setSort(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {status === 'loading' && <p className={styles.state}>Loading organizations…</p>}

      {status === 'error' && (
        <p className={styles.state}>
          Couldn&rsquo;t load organizations for this window.
        </p>
      )}

      {status === 'ready' && rows.length === 0 && (
        <p className={styles.state}>
          {emptyMessage(filter, counts, data?.network_tracked_since ?? null)}
        </p>
      )}

      {status === 'ready' && rows.length > 0 && (
        <ul className={styles.list} tabIndex={0} aria-label="Visiting organizations">
          {rows.map((org) => (
            <OrgRow
              key={org.name}
              org={org}
              open={openName === org.name}
              onToggle={() => setOpenName(openName === org.name ? null : org.name)}
              onFocusLocation={onFocusLocation}
              focusable={focusable}
            />
          ))}
        </ul>
      )}

      <p className={styles.note}>
        The name is the network operator, not the visitor&rsquo;s employer — a
        company on business fibre still shows as its carrier. Companies are the
        rows whose own address space resolved.
      </p>
    </section>
  );
}

function OrgRow({
  org,
  open,
  onToggle,
  onFocusLocation,
  focusable,
}: {
  org: VisitorOrganization;
  open: boolean;
  onToggle: () => void;
  onFocusLocation?: (location: OrgLocation) => void;
  focusable: ReadonlySet<string> | null;
}) {
  // The id has to survive an organization name containing anything at all —
  // DB-IP emits quotes, commas and non-ASCII ("UAB \"Bite Lietuva\"").
  const detailId = `org-detail-${encodeURIComponent(org.name)}`;
  const place = locationSummary(org.locations);
  const lastSeen = formatLastSeen(org.last_seen);

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.rowHead}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <ChevronRight
          size={14}
          strokeWidth={2}
          className={`${styles.caret} ${open ? styles.caretOpen : ''}`}
          aria-hidden="true"
        />
        <span className={styles.rowMain}>
          <span className={styles.rowName}>
            {org.name}
            {/* The badge that changes what this row means: not a stranger,
                someone already on the call list. Titled with the record's own
                name, which can differ from the network's registry spelling. */}
            {org.match && (
              <span className={styles.matchBadge} title={`Matches ${org.match.name}`}>
                {matchBadge(org.match.kind)}
              </span>
            )}
          </span>
          <span className={styles.rowMeta}>
            {place && <span className={styles.rowPlace}>{place}</span>}
            <span className={styles.rowStat}>{visitorLine(org)}</span>
          </span>
        </span>
        <span className={styles.badge} data-kind={org.kind}>
          {KIND_BADGE[org.kind]}
        </span>
        <span className={styles.rowSeen}>{lastSeen ?? '—'}</span>
      </button>

      {open && (
        <div className={styles.detail} id={detailId}>
          <DetailBlock title="Pages viewed" tone="pages">
            {org.top_pages.length === 0 ? (
              <p className={styles.detailEmpty}>No pages recorded.</p>
            ) : (
              <>
                {/* Every page, scrolling in place — the drawer keeps its
                    height whether the visitor read three pages or ninety. */}
                <ul className={`${styles.detailList} ${styles.detailListScroll}`}>
                  {org.top_pages.map((page) => (
                    <li key={page.path}>
                      <span className={styles.detailPath} title={page.path}>
                        {page.path}
                      </span>
                      <span className={styles.detailNum}>{page.views}</span>
                    </li>
                  ))}
                </ul>
                {org.pages_total != null && org.pages_total > org.top_pages.length && (
                  <p className={styles.detailFoot}>
                    +{org.pages_total - org.top_pages.length} more not shown
                  </p>
                )}
              </>
            )}
          </DetailBlock>

          <DetailBlock title="Came from" tone="from">
            {org.referrers.length === 0 ? (
              <p className={styles.detailEmpty}>Direct — no referrer sent.</p>
            ) : (
              <ul className={styles.detailList}>
                {org.referrers.map((ref) => (
                  <li key={ref.referrer}>
                    <span className={styles.detailPath} title={ref.referrer}>
                      {refHost(ref.referrer)}
                    </span>
                    <span className={styles.detailNum}>{ref.views}</span>
                  </li>
                ))}
              </ul>
            )}
          </DetailBlock>

          <DetailBlock title="Where & how" tone="where">
            <ul className={styles.detailList}>
              {org.locations.map((loc) => {
                const label = locationLabel(loc);
                if (!label) return null;
                // Clickable only when BOTH halves are true: somebody is
                // listening, and the row carries a country to point at. A
                // location with no country renders as the plain text it
                // always was rather than as a control that does nothing.
                const canFocus =
                  !!onFocusLocation &&
                  !!loc.country &&
                  (!focusable || focusable.has(loc.country));
                // "Gellerup, Central Jutland" answers WHERE only if you know
                // your Danish geography — when the label is a city or region,
                // the country is spelled out beside it. A country-only row's
                // label already IS the country name, so it takes no suffix.
                const suffix =
                  (loc.city || loc.region) && loc.country ? countryName(loc.country) : null;
                const flag = loc.country ? (
                  <span
                    className={styles.detailFlag}
                    // The glyph is decoration beside a name that already says
                    // the place; a screen reader gets the country spelled out
                    // on the control instead.
                    aria-hidden="true"
                  >
                    {flagEmoji(loc.country)}
                  </span>
                ) : null;
                return (
                  <li key={`${loc.city}-${loc.region}-${loc.country}`}>
                    {canFocus ? (
                      <button
                        type="button"
                        className={styles.detailPlaceBtn}
                        title={`Show ${label} on the map`}
                        aria-label={`Show ${label}, ${countryName(loc.country as string)}, on the map`}
                        onClick={() => onFocusLocation?.(loc)}
                      >
                        {flag}
                        <span className={styles.detailPath}>{label}</span>
                        {suffix && <span className={styles.detailCountry}>{suffix}</span>}
                      </button>
                    ) : (
                      <span className={styles.detailPlace}>
                        {flag}
                        <span className={styles.detailPath}>{label}</span>
                        {suffix && <span className={styles.detailCountry}>{suffix}</span>}
                      </span>
                    )}
                    <span className={styles.detailNum}>{loc.views}</span>
                  </li>
                );
              })}
            </ul>
            <p className={styles.detailFoot}>
              {deviceSplitLabel(org.devices) ?? 'Device unknown'}
              {org.first_seen && ` · first seen ${formatLastSeen(org.first_seen)}`}
            </p>
          </DetailBlock>
        </div>
      )}
    </li>
  );
}

function DetailBlock({
  title,
  tone,
  children,
}: {
  title: string;
  /** Which of the three columns this is — each keeps one color: pages are
   *  the zone cyan, referrers the violet, places the map's beacon gold. */
  tone: 'pages' | 'from' | 'where';
  children: ReactNode;
}) {
  return (
    <div className={styles.detailBlock} data-tone={tone}>
      <h4 className={styles.detailTitle}>{title}</h4>
      {children}
    </div>
  );
}
