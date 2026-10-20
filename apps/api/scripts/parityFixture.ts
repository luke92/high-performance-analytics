/**
 * Builds the cross-language parity fixture from the TypeScript reference
 * implementation. The C++ tests (cpp/tests) consume the committed output.
 *
 * Format (line based, whitespace separated; "null" marks an absent value;
 * doubles use JS shortest round-trip text, with "-0" for negative zero):
 *
 *   GENERATE <name> <seed> <count> <start> <interval>   then E lines, END
 *   COMPUTE  <name> <bins> INLINE                       then E lines, results, END
 *   COMPUTE  <name> <bins> GENERATED <seed> <count> <start> <interval>   then results, END
 *   ERROR    <name> <message...>
 *   E <id> <timestamp> <eventType> <category> <value>
 *   SUMMARY <count> <sum> <average> <min> <max>
 *   PCT <p50> <p95> <p99>
 *   HIST <binCount> <min> <max> <edgeCount> <edges...>
 *   COUNTS <counts...>
 *   GT <category> <eventType> <count>
 *   CAT <category> <count> <sum> <average>
 */
import {
  computeAnalytics,
  generateEvents,
  type AnalyticsEvent,
  type AnalyticsResult,
  type ComputeOptions,
  type GenerateOptions,
} from "../src/analytics/index.js";

function num(x: number | null): string {
  if (x === null) return "null";
  return Object.is(x, -0) ? "-0" : String(x);
}

function ev(id: number, category: string, eventType: string, value: number): AnalyticsEvent {
  return { id, timestamp: 1000 * id, eventType, category, value };
}

const eventLine = (e: AnalyticsEvent) => `E ${e.id} ${e.timestamp} ${e.eventType} ${e.category} ${num(e.value)}`;

function resultLines(r: AnalyticsResult): string[] {
  const h = r.histogram;
  return [
    `SUMMARY ${r.summary.count} ${num(r.summary.sum)} ${num(r.summary.average)} ${num(r.summary.min)} ${num(r.summary.max)}`,
    `PCT ${num(r.percentiles.p50)} ${num(r.percentiles.p95)} ${num(r.percentiles.p99)}`,
    `HIST ${h.binCount} ${num(h.min)} ${num(h.max)} ${h.edges.length} ${h.edges.map(num).join(" ")}`.trimEnd(),
    `COUNTS ${h.counts.join(" ")}`,
    ...r.countsByCategoryAndType.map((g) => `GT ${g.category} ${g.eventType} ${g.count}`),
    ...r.byCategory.map((c) => `CAT ${c.category} ${c.count} ${num(c.sum)} ${num(c.average)}`),
  ];
}

const gen = (seed: number, count: number, startTimestamp = 1_700_000_000_000, intervalMs = 1000): Required<GenerateOptions> => ({
  seed,
  count,
  startTimestamp,
  intervalMs,
});

const SMALL: AnalyticsEvent[] = [
  ev(1, "books", "view", 10),
  ev(2, "books", "click", 20),
  ev(3, "books", "view", 30),
  ev(4, "toys", "purchase", 5),
  ev(5, "toys", "view", 15),
];
const values = (vs: number[], category = "a", eventType = "x") => vs.map((v, i) => ev(i + 1, category, eventType, v));
const sequence = (n: number) => values(Array.from({ length: n }, (_, i) => i + 1), "books", "view");

export const GENERATE_CASES: Array<[string, Required<GenerateOptions>]> = [
  ["seed42_n3", gen(42, 3)],
  ["seed0_n2", gen(0, 2)],
  ["seed123_n2000_start5000_interval7", gen(123, 2000, 5000, 7)],
  ["seed_max_uint32_n5", gen(4_294_967_295, 5)],
  ["seed1_empty", gen(1, 0)],
  ["seed9_n100", gen(9, 100)],
];

export const COMPUTE_INLINE: Array<[string, AnalyticsEvent[], number]> = [
  ["small_5bins", SMALL, 5],
  ["small_2bins", SMALL, 2],
  ["small_default_bins", SMALL, 10],
  ["small_shuffled_5bins", [SMALL[3], SMALL[0], SMALL[4], SMALL[2], SMALL[1]] as AnalyticsEvent[], 5],
  ["empty_3bins", [], 3],
  ["equal_values_4bins", values([7, 7, 7]), 4],
  ["interior_edge_2bins", values([0, 5, 10]), 2],
  ["negative_1bin", values([-10, 0, 10]), 1],
  ["negative_4bins", values([-10, 0, 10]), 4],
  ["seq_100", sequence(100), 10],
  ["seq_10", sequence(10), 10],
  ["seq_2", sequence(2), 10],
  ["seq_1", sequence(1), 1],
  ["seq_37_1024bins", sequence(37), 1024],
  ["duplicates_1_1_1_1_100", values([1, 1, 1, 1, 100]), 5],
  ["float_sum_order", values([0.1, 0.2, 0.3]), 3],
  ["negative_zero", values([0, -0, -0, 5]), 4],
  // Input order differs from sorted order, so a comparator that ignores the sign of zero returns +0 for p50.
  ["negative_zero_sort_order", values([0, 0, -0, -0]), 4],
  ["negative_zero_sort_order_mixed", values([5, 0, -0, 0, -0, 1]), 3],
  ["limit_values", values([1e12, -1e12, 0.5]), 7],
  [
    "name_ordering",
    [ev(1, "b", "x", 1), ev(2, "B", "x", 1), ev(3, "a", "y", 1), ev(4, "a", "x", 1), ev(5, "a", "X", 1)],
    3,
  ],
];

export const COMPUTE_GENERATED: Array<[string, Required<GenerateOptions>, number]> = [
  ["generated_seed42_n1000", gen(42, 1000), 10],
  ["generated_seed7_n100000_64bins", gen(7, 100_000), 64],
  ["generated_seed123_n2000", gen(123, 2000, 5000, 7), 10],
  ["generated_empty", gen(0, 0), 10],
];

/** The two operations every engine (TypeScript, native addon) exposes. */
export interface EngineApi {
  generateEvents(options: GenerateOptions): unknown;
  computeAnalytics(events: AnalyticsEvent[], options?: ComputeOptions): unknown;
}
export const TS_ENGINE: EngineApi = { generateEvents, computeAnalytics };

type Thunk = (api: EngineApi) => unknown;
const good = ev(1, "a", "x", 1);
const withEvent = (patch: Partial<Record<keyof AnalyticsEvent, unknown>>): Thunk => (api) =>
  api.computeAnalytics([{ ...good, ...patch } as AnalyticsEvent]);
const withOptions = (o: Record<string, unknown>): Thunk => (api) => api.generateEvents(o as unknown as GenerateOptions);

/** Names must match the table in cpp/tests/test_validation.cpp. */
export const ERROR_CASES: Array<[string, Thunk]> = [
  ["generate_seed_negative", withOptions({ seed: -1, count: 1 })],
  ["generate_seed_too_large", withOptions({ seed: 4_294_967_296, count: 1 })],
  ["generate_count_negative", withOptions({ seed: 1, count: -1 })],
  ["generate_count_too_large", withOptions({ seed: 1, count: 5_000_001 })],
  ["generate_interval_zero", withOptions({ seed: 1, count: 1, intervalMs: 0 })],
  ["generate_interval_too_large", withOptions({ seed: 1, count: 1, intervalMs: 86_400_001 })],
  ["generate_start_negative", withOptions({ seed: 1, count: 1, startTimestamp: -5 })],
  [
    "generate_timestamp_overflow",
    withOptions({ seed: 1, count: 3, startTimestamp: 8_640_000_000_000_000, intervalMs: 1 }),
  ],
  ["generate_first_error_wins", withOptions({ seed: -1, count: -1, intervalMs: 0 })],
  ["event_id_negative", withEvent({ id: -1 })],
  ["event_id_too_large", withEvent({ id: 2 ** 53 })],
  ["event_timestamp_negative", withEvent({ timestamp: -1 })],
  ["event_timestamp_too_large", withEvent({ timestamp: 8_640_000_000_000_001 })],
  ["event_type_empty", withEvent({ eventType: "" })],
  ["event_type_too_long", withEvent({ eventType: "x".repeat(65) })],
  ["event_type_bad_char", withEvent({ eventType: "a/b" })],
  ["event_category_empty", withEvent({ category: "" })],
  ["event_category_space", withEvent({ category: "a b" })],
  ["event_category_non_ascii", withEvent({ category: "café" })],
  ["event_value_nan", withEvent({ value: NaN })],
  ["event_value_infinity", withEvent({ value: Infinity })],
  ["event_value_neg_infinity", withEvent({ value: -Infinity })],
  ["event_value_over_limit", withEvent({ value: 1e12 + 1 })],
  ["event_first_error_wins", withEvent({ id: -1, value: NaN })],
  ["event_index_in_message", (api) => api.computeAnalytics([good, { ...good, value: NaN }])],
  ["bins_zero", (api) => api.computeAnalytics([good], { histogramBins: 0 })],
  ["bins_negative", (api) => api.computeAnalytics([good], { histogramBins: -1 })],
  ["bins_too_large", (api) => api.computeAnalytics([good], { histogramBins: 1025 })],
  ["events_checked_before_bins", (api) => api.computeAnalytics([{ ...good, value: NaN }], { histogramBins: 0 })],
];

export function buildParityFixture(): string {
  const out: string[] = ["# Generated by apps/api/scripts/export-parity-fixtures.ts from the TypeScript reference. Do not edit.", "HPA-PARITY 1"];

  for (const [name, o] of GENERATE_CASES) {
    out.push(`GENERATE ${name} ${o.seed} ${o.count} ${o.startTimestamp} ${o.intervalMs}`);
    out.push(...generateEvents(o).map(eventLine), "END");
  }
  for (const [name, events, bins] of COMPUTE_INLINE) {
    out.push(`COMPUTE ${name} ${bins} INLINE`, ...events.map(eventLine));
    out.push(...resultLines(computeAnalytics(events, { histogramBins: bins })), "END");
  }
  for (const [name, o, bins] of COMPUTE_GENERATED) {
    out.push(`COMPUTE ${name} ${bins} GENERATED ${o.seed} ${o.count} ${o.startTimestamp} ${o.intervalMs}`);
    out.push(...resultLines(computeAnalytics(generateEvents(o), { histogramBins: bins })), "END");
  }
  for (const [name, run] of ERROR_CASES) {
    let message: string | undefined;
    try {
      run(TS_ENGINE);
    } catch (err) {
      message = (err as Error).message;
    }
    if (message === undefined) throw new Error(`Error case ${name} did not throw in the TypeScript implementation`);
    out.push(`ERROR ${name} ${message}`);
  }
  return out.join("\n") + "\n";
}
