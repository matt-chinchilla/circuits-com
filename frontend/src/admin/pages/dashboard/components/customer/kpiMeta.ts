// KPI presentation — the two things the wire does not carry.
//
// `GET /api/account/kpi` sends `{selected, available, points}` and nothing
// else: no unit, and no label for `selected` when the account has lost the
// capability that offered it. Both gaps are resolved here rather than in the
// panel, so they are testable without mounting React.
//
// The registry itself stays SERVER-owned (`app/services/account_kpis.py`).
// Nothing below enumerates the KPIs — every label the user reads comes from
// the payload, so a sixth KPI shipped on the backend appears in the selector
// with no frontend change at all.

import type { AccountKpi, AccountKpiOption } from '@admin/types/account';
import { count, usd, usdCompact } from '../format';

/**
 * The KPIs whose `value` is DOLLARS. Everything else is a count of parts,
 * listings or stock units.
 *
 * An explicit set, not a heuristic on the key text: `inventory_value_by_category`
 * and `stock_by_category` differ by one word and by four orders of magnitude,
 * and printing 41,271 stock units as $41,271.00 is a lie that looks like a
 * feature. A money KPI added to the registry must be added here too — it is
 * the one line that has to follow the backend, and a miss reads as a count,
 * which is wrong but never inflates a number into currency.
 */
const MONEY_KPI_KEYS: ReadonlySet<string> = new Set(['inventory_value_by_category']);

export function isMoneyKpi(key: string): boolean {
  return MONEY_KPI_KEYS.has(key);
}

/** Headline / tooltip formatter for a KPI's values. */
export function kpiValueFormat(key: string): (value: number) => string {
  return isMoneyKpi(key) ? usd : count;
}

/** Axis formatter — read at a glance, so money compacts to `$12K`. */
export function kpiAxisFormat(key: string): (value: number) => string {
  return isMoneyKpi(key) ? usdCompact : count;
}

/** `inventory_value_by_category` -> `Inventory value by category`.
 *
 *  A LAST resort, used only for a stored key the server did not send a label
 *  for. It reads as a sentence rather than as a database column, which is the
 *  most the client can honestly do without inventing a name. */
export function humanizeKpiKey(key: string): string {
  const words = key.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface KpiChoice extends AccountKpiOption {
  /** False for the stored-but-uncapable key: it is what the chart is showing,
   *  so it must appear as the selector's current value, but choosing it again
   *  would only earn a 422. */
  pickable: boolean;
}

/**
 * The selector's options.
 *
 * `available` is capability-filtered server-side, and `selected` is whatever
 * `users.dashboard_kpi` holds — the two disagree the moment staff unlink an
 * account's supplier row while its stored pick was a distributor-only KPI. A
 * `<select>` whose value is not among its options displays the WRONG label
 * (the browser falls back to the first entry), so the missing key is carried
 * in front as an unpickable choice instead of being dropped.
 */
export function kpiChoices(kpi: AccountKpi): KpiChoice[] {
  const choices: KpiChoice[] = kpi.available.map((o) => ({ ...o, pickable: true }));
  if (kpi.selected && !choices.some((c) => c.key === kpi.selected)) {
    choices.unshift({
      key: kpi.selected,
      label: humanizeKpiKey(kpi.selected),
      pickable: false,
    });
  }
  return choices;
}

/** The label to print for the KPI currently on screen. */
export function kpiLabel(kpi: AccountKpi): string {
  const match = kpi.available.find((o) => o.key === kpi.selected);
  return match ? match.label : humanizeKpiKey(kpi.selected);
}
