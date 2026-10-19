import { DEFAULT_HISTOGRAM_BINS } from "./limits.js";
import type {
  AnalyticsEvent,
  AnalyticsResult,
  CategoryEventTypeCount,
  CategoryStats,
  ComputeOptions,
  Histogram,
  Percentiles,
} from "./types.js";
import { validateComputeOptions, validateEvents } from "./validate.js";

/**
 * Computes all analytics in one call. Validates its input first and throws
 * ValidationError on any violation.
 *
 * Definitions (normative for the C++ core):
 *
 * Sums: IEEE 754 doubles added sequentially in input order, starting from 0,
 * with no compensation and no reordering. Results can therefore depend on
 * input order for non-integer values; counts, histograms and percentiles never do.
 * Averages are `sum / count`; undefined (null) for an empty dataset.
 *
 * Percentiles: nearest-rank. With n values sorted ascending and an integer
 * p in {50, 95, 99}, the result is sorted[rank - 1] where
 * rank = ceil(p * n / 100), computed in integer arithmetic. The result is
 * always an observed value (no interpolation). null when n = 0.
 *
 * Histogram: `binCount` equal-width bins over [min, max] of the observed
 * values, where width = (max - min) / binCount. Bin i holds values in
 * [min + i*width, min + (i+1)*width); the last bin is closed so that max is
 * counted. Normative index: min(binCount - 1, floor((v - min) / width)); when
 * width is 0 (all values equal) every value is in bin 0. `edges` is
 * informational: edges[i] = min + i*width for i < binCount and edges[binCount] = max.
 * For an empty dataset: min/max null, edges [], counts all zero.
 *
 * Ordering: groups are sorted by category, then eventType, using code-unit
 * (byte) order; names are ASCII so both agree.
 */
export function computeAnalytics(
  events: readonly AnalyticsEvent[],
  options: ComputeOptions = {},
): AnalyticsResult {
  validateEvents(events);
  validateComputeOptions(options);
  const binCount = options.histogramBins ?? DEFAULT_HISTOGRAM_BINS;

  const n = events.length;
  const values = new Float64Array(n);
  const categoryAgg = new Map<string, { count: number; sum: number }>();
  const typeCounts = new Map<string, Map<string, number>>();
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < n; i++) {
    const e = events[i] as AnalyticsEvent;
    const v = e.value;
    values[i] = v;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;

    let agg = categoryAgg.get(e.category);
    if (agg === undefined) {
      agg = { count: 0, sum: 0 };
      categoryAgg.set(e.category, agg);
    }
    agg.count++;
    agg.sum += v;

    let byType = typeCounts.get(e.category);
    if (byType === undefined) {
      byType = new Map();
      typeCounts.set(e.category, byType);
    }
    byType.set(e.eventType, (byType.get(e.eventType) ?? 0) + 1);
  }

  const categories = [...categoryAgg.keys()].sort();
  const byCategory: CategoryStats[] = categories.map((category) => {
    const agg = categoryAgg.get(category) as { count: number; sum: number };
    return { category, count: agg.count, sum: agg.sum, average: agg.sum / agg.count };
  });
  const countsByCategoryAndType: CategoryEventTypeCount[] = categories.flatMap((category) => {
    const byType = typeCounts.get(category) as Map<string, number>;
    return [...byType.keys()].sort().map((eventType) => ({
      category,
      eventType,
      count: byType.get(eventType) as number,
    }));
  });

  return {
    summary: {
      count: n,
      sum,
      average: n === 0 ? null : sum / n,
      min: n === 0 ? null : min,
      max: n === 0 ? null : max,
    },
    countsByCategoryAndType,
    byCategory,
    histogram: buildHistogram(values, binCount, min, max),
    percentiles: buildPercentiles(values),
  };
}

function buildHistogram(values: Float64Array, binCount: number, min: number, max: number): Histogram {
  const counts = new Array<number>(binCount).fill(0);
  if (values.length === 0) return { binCount, min: null, max: null, edges: [], counts };

  const width = (max - min) / binCount;
  for (let i = 0; i < values.length; i++) {
    const index = width === 0 ? 0 : Math.min(binCount - 1, Math.floor(((values[i] as number) - min) / width));
    counts[index] = (counts[index] as number) + 1;
  }
  const edges = new Array<number>(binCount + 1);
  for (let i = 0; i < binCount; i++) edges[i] = min + i * width;
  edges[binCount] = max;
  return { binCount, min, max, edges, counts };
}

function buildPercentiles(values: Float64Array): Percentiles {
  if (values.length === 0) return { p50: null, p95: null, p99: null };
  const sorted = Float64Array.from(values).sort();
  return {
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
  };
}

function nearestRank(sorted: Float64Array, p: number): number {
  const rank = Math.floor((p * sorted.length + 99) / 100); // integer ceil(p * n / 100)
  return sorted[Math.max(1, rank) - 1] as number;
}
