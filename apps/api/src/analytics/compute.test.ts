import { describe, expect, it } from "vitest";
import { computeAnalytics, ValidationError, type AnalyticsEvent } from "./index.js";

function ev(id: number, category: string, eventType: string, value: number): AnalyticsEvent {
  return { id, timestamp: 1000 * id, eventType, category, value };
}

/** Values 1..n, all in one category. */
function sequence(n: number): AnalyticsEvent[] {
  return Array.from({ length: n }, (_, i) => ev(i + 1, "books", "view", i + 1));
}

// Hand-verified dataset: values sorted = 5, 10, 15, 20, 30; sum 80.
const SMALL: AnalyticsEvent[] = [
  ev(1, "books", "view", 10),
  ev(2, "books", "click", 20),
  ev(3, "books", "view", 30),
  ev(4, "toys", "purchase", 5),
  ev(5, "toys", "view", 15),
];

describe("computeAnalytics: known small dataset", () => {
  const result = computeAnalytics(SMALL, { histogramBins: 5 });

  it("summarises the whole dataset", () => {
    expect(result.summary).toEqual({ count: 5, sum: 80, average: 16, min: 5, max: 30 });
  });

  it("counts by category and event type, sorted", () => {
    expect(result.countsByCategoryAndType).toEqual([
      { category: "books", eventType: "click", count: 1 },
      { category: "books", eventType: "view", count: 2 },
      { category: "toys", eventType: "purchase", count: 1 },
      { category: "toys", eventType: "view", count: 1 },
    ]);
  });

  it("sums and averages by category, sorted", () => {
    expect(result.byCategory).toEqual([
      { category: "books", count: 3, sum: 60, average: 20 },
      { category: "toys", count: 2, sum: 20, average: 10 },
    ]);
  });

  it("computes nearest-rank percentiles", () => {
    // n=5: rank(p50)=ceil(2.5)=3 -> 15; rank(p95)=ceil(4.75)=5 -> 30; rank(p99)=5 -> 30
    expect(result.percentiles).toEqual({ p50: 15, p95: 30, p99: 30 });
  });

  it("builds the histogram", () => {
    expect(result.histogram).toEqual({
      binCount: 5,
      min: 5,
      max: 30,
      edges: [5, 10, 15, 20, 25, 30],
      counts: [1, 1, 1, 1, 1],
    });
  });

  it("uses 10 histogram bins by default", () => {
    expect(computeAnalytics(SMALL).histogram.binCount).toBe(10);
    expect(computeAnalytics(SMALL).histogram.counts).toHaveLength(10);
  });
});

describe("computeAnalytics: empty dataset", () => {
  const result = computeAnalytics([], { histogramBins: 3 });

  it("returns zero counts and null statistics", () => {
    expect(result.summary).toEqual({ count: 0, sum: 0, average: null, min: null, max: null });
    expect(result.countsByCategoryAndType).toEqual([]);
    expect(result.byCategory).toEqual([]);
    expect(result.percentiles).toEqual({ p50: null, p95: null, p99: null });
  });

  it("returns an empty-range histogram with zeroed bins", () => {
    expect(result.histogram).toEqual({ binCount: 3, min: null, max: null, edges: [], counts: [0, 0, 0] });
  });
});

describe("computeAnalytics: histogram boundaries", () => {
  it("places the minimum in the first bin and the maximum in the last (closed) bin", () => {
    const h = computeAnalytics(SMALL, { histogramBins: 2 }).histogram;
    // width 12.5: [5,17.5) -> 5,10,15 ; [17.5,30] -> 20,30
    expect(h.edges).toEqual([5, 17.5, 30]);
    expect(h.counts).toEqual([3, 2]);
  });

  it("puts a value exactly on an interior edge into the upper bin", () => {
    const events = [0, 5, 10].map((v, i) => ev(i + 1, "a", "x", v));
    expect(computeAnalytics(events, { histogramBins: 2 }).histogram.counts).toEqual([1, 2]);
  });

  it("puts all values in bin 0 when min equals max", () => {
    const events = [7, 7, 7].map((v, i) => ev(i + 1, "a", "x", v));
    const h = computeAnalytics(events, { histogramBins: 4 }).histogram;
    expect(h.counts).toEqual([3, 0, 0, 0]);
    expect(h.min).toBe(7);
    expect(h.max).toBe(7);
  });

  it("handles a single bin and negative values", () => {
    const events = [-10, 0, 10].map((v, i) => ev(i + 1, "a", "x", v));
    expect(computeAnalytics(events, { histogramBins: 1 }).histogram).toEqual({
      binCount: 1,
      min: -10,
      max: 10,
      edges: [-10, 10],
      counts: [3],
    });
    expect(computeAnalytics(events, { histogramBins: 4 }).histogram.counts).toEqual([1, 0, 1, 1]);
  });

  it("always accounts for every event", () => {
    const events = sequence(1000);
    for (const bins of [1, 3, 7, 10, 64, 1024]) {
      const counts = computeAnalytics(events, { histogramBins: bins }).histogram.counts;
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1000);
    }
  });
});

describe("computeAnalytics: percentile convention (nearest rank)", () => {
  it("returns the observed value at rank ceil(p*n/100) for 1..100", () => {
    expect(computeAnalytics(sequence(100)).percentiles).toEqual({ p50: 50, p95: 95, p99: 99 });
  });

  it("rounds the rank up for non-integer positions", () => {
    // n=10: ranks 5, 10, 10
    expect(computeAnalytics(sequence(10)).percentiles).toEqual({ p50: 5, p95: 10, p99: 10 });
    // n=2: ranks 1, 2, 2 (no interpolation)
    expect(computeAnalytics(sequence(2)).percentiles).toEqual({ p50: 1, p95: 2, p99: 2 });
  });

  it("returns the single value for n=1", () => {
    expect(computeAnalytics(sequence(1)).percentiles).toEqual({ p50: 1, p95: 1, p99: 1 });
  });

  it("handles duplicate values", () => {
    const dup = [1, 1, 1, 1, 100].map((v, i) => ev(i + 1, "a", "x", v));
    expect(computeAnalytics(dup).percentiles).toEqual({ p50: 1, p95: 100, p99: 100 });
    const same = [7, 7, 7, 7].map((v, i) => ev(i + 1, "a", "x", v));
    expect(computeAnalytics(same).percentiles).toEqual({ p50: 7, p95: 7, p99: 7 });
  });

  it("does not depend on input order", () => {
    const forward = sequence(101);
    const reversed = [...forward].reverse();
    expect(computeAnalytics(reversed).percentiles).toEqual(computeAnalytics(forward).percentiles);
  });

  it("keeps p50 <= p95 <= p99 within [min, max]", () => {
    const { percentiles: p, summary } = computeAnalytics(sequence(37));
    expect(p.p50).toBeLessThanOrEqual(p.p95 as number);
    expect(p.p95).toBeLessThanOrEqual(p.p99 as number);
    expect(p.p50).toBeGreaterThanOrEqual(summary.min as number);
    expect(p.p99).toBeLessThanOrEqual(summary.max as number);
  });
});

describe("computeAnalytics: grouping and aggregation", () => {
  it("is independent of input order for counts, groups, histogram and percentiles", () => {
    const shuffled = [SMALL[3], SMALL[0], SMALL[4], SMALL[2], SMALL[1]] as AnalyticsEvent[];
    expect(computeAnalytics(shuffled)).toEqual(computeAnalytics(SMALL));
  });

  it("keeps groups separate and totals consistent", () => {
    const events = [
      ev(1, "a", "x", 1),
      ev(2, "a", "y", 2),
      ev(3, "b", "x", 3),
      ev(4, "b", "x", 4),
      ev(5, "c", "z", 5),
    ];
    const r = computeAnalytics(events);
    expect(r.byCategory.map((c) => c.category)).toEqual(["a", "b", "c"]);
    expect(r.countsByCategoryAndType.reduce((s, g) => s + g.count, 0)).toBe(5);
    expect(r.byCategory.reduce((s, g) => s + g.sum, 0)).toBe(r.summary.sum);
    expect(r.countsByCategoryAndType).toContainEqual({ category: "b", eventType: "x", count: 2 });
  });

  it("sorts names in code-unit order (uppercase before lowercase)", () => {
    const events = [ev(1, "b", "x", 1), ev(2, "B", "x", 1), ev(3, "a", "x", 1)];
    expect(computeAnalytics(events).byCategory.map((c) => c.category)).toEqual(["B", "a", "b"]);
  });

  it("sums doubles sequentially in input order", () => {
    const events = [0.1, 0.2, 0.3].map((v, i) => ev(i + 1, "a", "x", v));
    expect(computeAnalytics(events).summary.sum).toBe(0.1 + 0.2 + 0.3); // 0.6000000000000001
  });

  it("handles negative values", () => {
    const events = [-4, 2].map((v, i) => ev(i + 1, "a", "x", v));
    const r = computeAnalytics(events);
    expect(r.summary).toEqual({ count: 2, sum: -2, average: -1, min: -4, max: 2 });
  });

  it("does not mutate its input", () => {
    const copy = structuredClone(SMALL);
    computeAnalytics(SMALL);
    expect(SMALL).toEqual(copy);
  });
});

describe("computeAnalytics: invalid input", () => {
  const good = ev(1, "a", "x", 1);

  it.each([
    ["non-array", {}],
    ["null event", [null]],
    ["array event", [[]]],
    ["missing value", [{ ...good, value: undefined }]],
    ["NaN value", [{ ...good, value: NaN }]],
    ["Infinity value", [{ ...good, value: Infinity }]],
    ["-Infinity value", [{ ...good, value: -Infinity }]],
    ["string value", [{ ...good, value: "1" }]],
    ["value beyond limit", [{ ...good, value: 1e12 + 1 }]],
    ["fractional id", [{ ...good, id: 1.5 }]],
    ["negative id", [{ ...good, id: -1 }]],
    ["unsafe id", [{ ...good, id: 2 ** 53 }]],
    ["fractional timestamp", [{ ...good, timestamp: 1.5 }]],
    ["negative timestamp", [{ ...good, timestamp: -1 }]],
    ["timestamp beyond range", [{ ...good, timestamp: 8_640_000_000_000_001 }]],
    ["empty category", [{ ...good, category: "" }]],
    ["category with space", [{ ...good, category: "a b" }]],
    ["non-ASCII category", [{ ...good, category: "café" }]],
    ["over-long eventType", [{ ...good, eventType: "x".repeat(65) }]],
    ["numeric eventType", [{ ...good, eventType: 3 }]],
  ])("rejects %s", (_name, input) => {
    expect(() => computeAnalytics(input as unknown as AnalyticsEvent[])).toThrow(ValidationError);
  });

  it("identifies the offending index", () => {
    const events = [good, { ...good, value: NaN }];
    expect(() => computeAnalytics(events)).toThrow(/events\[1\]\.value/);
  });

  it("accepts values at the limit", () => {
    expect(() => computeAnalytics([{ ...good, value: 1e12 }, { ...good, value: -1e12 }])).not.toThrow();
  });

  it.each([0, -1, 1.5, 1025, NaN, "10"])("rejects histogramBins=%s", (bins) => {
    expect(() => computeAnalytics([good], { histogramBins: bins as number })).toThrow(ValidationError);
  });

  it("accepts the histogramBins bounds", () => {
    expect(computeAnalytics([good], { histogramBins: 1 }).histogram.counts).toEqual([1]);
    expect(computeAnalytics([good], { histogramBins: 1024 }).histogram.counts).toHaveLength(1024);
  });
});
