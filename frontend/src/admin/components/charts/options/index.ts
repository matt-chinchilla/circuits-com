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

export { circlePackOption } from './circlePackOption';
export type {
  CirclePackChild,
  CirclePackGroup,
  CirclePackOptionInput,
} from './circlePackOption';

export { salesForceOption } from './salesForceOption';
export type {
  SalesForceCustomer,
  SalesForceGroup,
  SalesForceOptionInput,
} from './salesForceOption';

export { escapeHtml, tooltipCard, tooltipItems, tooltipRow, numericValue } from './tooltip';
export type { TooltipItem } from './tooltip';
