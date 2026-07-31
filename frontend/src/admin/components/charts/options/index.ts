// Pure ECharts option builders. Each returns a plain option object and imports
// NOTHING from echarts at runtime (type-only imports are erased), so a page can
// build an option without pulling the library in.

export { sparklineOption } from './sparklineOption';
export type { SparklinePoint, SparklineOptionInput } from './sparklineOption';

export {
  comparatorOption,
  expensesOption,
  monthsToComparatorSeries,
  trendToComparatorSeries,
} from './comparatorOption';
export type {
  ComparatorLineStyle,
  ComparatorPoint,
  ComparatorSeries,
  ComparatorOptionInput,
  MonthlyDailyMonth,
} from './comparatorOption';

export { pieOption } from './pieOption';
export type { PieSlice, PieOptionInput } from './pieOption';

export { buildSalesForce } from './salesForceOption';
export type {
  SalesForceBuild,
  SalesForceCustomer,
  SalesForceGroup,
  SalesForceOptionInput,
  SalesForceRestNode,
} from './salesForceOption';
// The interaction layer for the sales-force graph lives in ./salesForcePhysics
// (imported directly by its host) — it is NOT an option builder, so it stays
// out of this barrel on purpose.

export { escapeHtml, tooltipCard, tooltipItems, tooltipRow, numericValue } from './tooltip';
export type { TooltipItem } from './tooltip';
