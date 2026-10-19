/**
 * Contracts for the analytics engine. Everything here is JSON-compatible and
 * free of Node.js types so it can be mirrored by the C++ core.
 */

/**
 * A single synthetic event.
 *
 * - `id`: non-negative safe integer (0..2^53-1). Uniqueness is NOT enforced.
 * - `timestamp`: integer milliseconds since the Unix epoch (UTC), 0..8.64e15
 *   (the ECMAScript Date range). No timezone, no leap seconds. Analytics in
 *   this stage do not use it; it is validated and carried through.
 * - `eventType`, `category`: 1..64 chars from [A-Za-z0-9_.-]. ASCII-only so
 *   byte-wise and UTF-16 ordering agree.
 * - `value`: finite number with |value| <= MAX_ABS_VALUE (1e12). Doubles are
 *   IEEE 754 binary64.
 */
export interface AnalyticsEvent {
  id: number;
  timestamp: number;
  eventType: string;
  category: string;
  value: number;
}

export interface GenerateOptions {
  /** Unsigned 32-bit integer (0..4294967295). */
  seed: number;
  /** Number of events, 0..MAX_EVENTS. */
  count: number;
  /** Timestamp of the first event. Default DEFAULT_START_TIMESTAMP. */
  startTimestamp?: number;
  /** Milliseconds between consecutive events, 1..86_400_000. Default 1000. */
  intervalMs?: number;
}

/** GenerateOptions with defaults applied. */
export type ResolvedGenerateOptions = Required<GenerateOptions>;

export interface ComputeOptions {
  /** Histogram bin count, integer 1..MAX_HISTOGRAM_BINS. Default 10. */
  histogramBins?: number;
}

export interface CategoryEventTypeCount {
  category: string;
  eventType: string;
  count: number;
}

export interface CategoryStats {
  category: string;
  count: number;
  sum: number;
  average: number;
}

export interface Summary {
  count: number;
  sum: number;
  /** null when count is 0. */
  average: number | null;
  min: number | null;
  max: number | null;
}

export interface Histogram {
  binCount: number;
  /** null when the dataset is empty. */
  min: number | null;
  max: number | null;
  /** binCount + 1 informational edges; empty when the dataset is empty. */
  edges: number[];
  /** binCount counts; all zero when the dataset is empty. */
  counts: number[];
}

export interface Percentiles {
  /** Nearest-rank percentiles; null when the dataset is empty. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface AnalyticsResult {
  summary: Summary;
  /** Sorted by category, then eventType (code-unit order). */
  countsByCategoryAndType: CategoryEventTypeCount[];
  /** Sorted by category (code-unit order). */
  byCategory: CategoryStats[];
  histogram: Histogram;
  percentiles: Percentiles;
}
