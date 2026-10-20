import { describe, expect, it } from "vitest";
import {
  COMPUTE_GENERATED,
  COMPUTE_INLINE,
  ERROR_CASES,
  GENERATE_CASES,
  TS_ENGINE,
  type EngineApi,
} from "../../scripts/parityFixture.js";
import { computeAnalytics, generateEvents, MAX_EVENTS, ValidationError, type AnalyticsEvent } from "../analytics/index.js";
import { describeNative, expectIdentical, nativeRequired, outcome } from "../../test/support.js";
import { getNativeAddon, getNativeStatus } from "./loader.js";
import { nativeComputeAnalytics, nativeGenerateEvents } from "./nativeEngine.js";

const NATIVE_ENGINE: EngineApi = {
  generateEvents: nativeGenerateEvents,
  computeAnalytics: (events, options) => nativeComputeAnalytics(events, options),
};

const good: AnalyticsEvent = { id: 1, timestamp: 1000, eventType: "view", category: "books", value: 10 };
const ev = (id: number, category: string, eventType: string, value: number): AnalyticsEvent => ({
  id,
  timestamp: 1000 * id,
  eventType,
  category,
  value,
});

/** Runs the same call on both engines and requires the same outcome (result or exact error message). */
function expectSameOutcome(run: (api: EngineApi) => unknown): void {
  const ts = outcome(() => run(TS_ENGINE));
  const native = outcome(() => run(NATIVE_ENGINE));
  if ("error" in ts) {
    expect(native, "native engine should reject the same input").toEqual({ error: ts.error, name: "ValidationError" });
  } else {
    expect("ok" in native, `native engine threw: ${JSON.stringify(native)}`).toBe(true);
    expectIdentical((native as { ok: unknown }).ok, ts.ok);
  }
}

describe("native addon availability", () => {
  it.runIf(nativeRequired)("is built and loadable when HPA_REQUIRE_NATIVE=1", () => {
    expect(getNativeStatus()).toMatchObject({ available: true, napiVersion: 8 });
  });
});

describeNative("native addon", () => {
  it("loads and reports its versions", () => {
    const status = getNativeStatus();
    expect(status.available).toBe(true);
    if (status.available) {
      expect(status.coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(status.napiVersion).toBe(8);
    }
  });

  describe("generateEvents", () => {
    it.each(GENERATE_CASES)("matches the TypeScript generator exactly: %s", (_name, options) => {
      expectIdentical(nativeGenerateEvents(options), generateEvents(options));
    });

    it("produces identical JSON text for 100,000 events", () => {
      const options = { seed: 2024, count: 100_000 };
      expect(JSON.stringify(nativeGenerateEvents(options))).toBe(JSON.stringify(generateEvents(options)));
    });

    it("returns the pinned golden events for seed 42", () => {
      expect(nativeGenerateEvents({ seed: 42, count: 2 })).toEqual([
        { id: 1, timestamp: 1_700_000_000_000, eventType: "click", category: "home", value: 726.69 },
        { id: 2, timestamp: 1_700_000_001_000, eventType: "view", category: "home", value: 277.29 },
      ]);
    });

    it("is repeatable and supports zero events", () => {
      const a = nativeGenerateEvents({ seed: 5, count: 300 });
      expectIdentical(nativeGenerateEvents({ seed: 5, count: 300 }), a);
      expect(nativeGenerateEvents({ seed: 5, count: 0 })).toEqual([]);
    });
  });

  describe("computeAnalytics: parity with the TypeScript engine", () => {
    it.each(COMPUTE_INLINE)("inline dataset %s", (_name, events, bins) => {
      expectIdentical(nativeComputeAnalytics(events, { histogramBins: bins }), computeAnalytics(events, { histogramBins: bins }));
    });

    it.each(COMPUTE_GENERATED)("generated dataset %s", (_name, options, bins) => {
      const events = generateEvents(options);
      const native = nativeComputeAnalytics(events, { histogramBins: bins });
      expectIdentical(native, computeAnalytics(events, { histogramBins: bins }));
      expect(JSON.stringify(native)).toBe(JSON.stringify(computeAnalytics(events, { histogramBins: bins })));
    });

    it("uses 10 histogram bins by default, like TypeScript", () => {
      const events = generateEvents({ seed: 3, count: 50 });
      expectIdentical(nativeComputeAnalytics(events), computeAnalytics(events));
      expect(nativeComputeAnalytics(events).histogram.binCount).toBe(10);
    });
  });

  describe("computeAnalytics: hand-verified results (independent of the TypeScript engine)", () => {
    const small = [ev(1, "books", "view", 10), ev(2, "books", "click", 20), ev(3, "books", "view", 30), ev(4, "toys", "purchase", 5), ev(5, "toys", "view", 15)];

    it("computes every metric for the small dataset", () => {
      expect(nativeComputeAnalytics(small, { histogramBins: 5 })).toEqual({
        summary: { count: 5, sum: 80, average: 16, min: 5, max: 30 },
        countsByCategoryAndType: [
          { category: "books", eventType: "click", count: 1 },
          { category: "books", eventType: "view", count: 2 },
          { category: "toys", eventType: "purchase", count: 1 },
          { category: "toys", eventType: "view", count: 1 },
        ],
        byCategory: [
          { category: "books", count: 3, sum: 60, average: 20 },
          { category: "toys", count: 2, sum: 20, average: 10 },
        ],
        histogram: { binCount: 5, min: 5, max: 30, edges: [5, 10, 15, 20, 25, 30], counts: [1, 1, 1, 1, 1] },
        percentiles: { p50: 15, p95: 30, p99: 30 },
      });
    });

    it("treats the histogram minimum, interior edges and the closed maximum correctly", () => {
      expect(nativeComputeAnalytics(small, { histogramBins: 2 }).histogram).toEqual({
        binCount: 2,
        min: 5,
        max: 30,
        edges: [5, 17.5, 30],
        counts: [3, 2],
      });
      const edge = [0, 5, 10].map((v, i) => ev(i + 1, "a", "x", v));
      expect(nativeComputeAnalytics(edge, { histogramBins: 2 }).histogram.counts).toEqual([1, 2]);
      const equal = [7, 7, 7].map((v, i) => ev(i + 1, "a", "x", v));
      expect(nativeComputeAnalytics(equal, { histogramBins: 4 }).histogram.counts).toEqual([3, 0, 0, 0]);
    });

    it("uses nearest-rank percentiles, including duplicates", () => {
      const seq = Array.from({ length: 100 }, (_, i) => ev(i + 1, "a", "x", i + 1));
      expect(nativeComputeAnalytics(seq).percentiles).toEqual({ p50: 50, p95: 95, p99: 99 });
      const dup = [1, 1, 1, 1, 100].map((v, i) => ev(i + 1, "a", "x", v));
      expect(nativeComputeAnalytics(dup).percentiles).toEqual({ p50: 1, p95: 100, p99: 100 });
      expect(nativeComputeAnalytics(seq.slice(0, 2)).percentiles).toEqual({ p50: 1, p95: 2, p99: 2 });
    });

    it("returns null/zero values for an empty dataset", () => {
      const result = nativeComputeAnalytics([], { histogramBins: 3 });
      expect(result).toEqual({
        summary: { count: 0, sum: 0, average: null, min: null, max: null },
        countsByCategoryAndType: [],
        byCategory: [],
        histogram: { binCount: 3, min: null, max: null, edges: [], counts: [0, 0, 0] },
        percentiles: { p50: null, p95: null, p99: null },
      });
      expect(JSON.stringify(result)).toContain('"average":null');
    });

    it("preserves negative zero like TypeScript", () => {
      const events = [0, 0, -0, -0].map((v, i) => ev(i + 1, "a", "x", v));
      const { percentiles } = nativeComputeAnalytics(events);
      expect(Object.is(percentiles.p50, -0)).toBe(true);
      expect(Object.is(percentiles.p95, 0)).toBe(true);
    });

    it("sums sequentially in input order (0.1 + 0.2 + 0.3)", () => {
      const events = [0.1, 0.2, 0.3].map((v, i) => ev(i + 1, "a", "x", v));
      expect(nativeComputeAnalytics(events).summary.sum).toBe(0.1 + 0.2 + 0.3);
    });
  });

  describe("boundary values", () => {
    it("accepts the extreme valid id, timestamp and value and returns identical results", () => {
      const events: AnalyticsEvent[] = [
        { id: Number.MAX_SAFE_INTEGER, timestamp: 8_640_000_000_000_000, eventType: "A-z_0.9", category: "Z".repeat(64), value: 1e12 },
        { id: 0, timestamp: 0, eventType: "x", category: "a", value: -1e12 },
      ];
      expectIdentical(nativeComputeAnalytics(events), computeAnalytics(events));
    });

    it("round-trips the maximum id and timestamp through generation", () => {
      const options = { seed: 1, count: 2, startTimestamp: 8_639_999_999_999_999, intervalMs: 1 };
      const events = nativeGenerateEvents(options);
      expect(events[1]?.timestamp).toBe(8_640_000_000_000_000);
      expectIdentical(events, generateEvents(options));
    });

    it("ignores extra properties on events and does not modify its input", () => {
      const input = [{ ...good, extra: { nested: true } }];
      const copy = structuredClone(input);
      expect(nativeComputeAnalytics(input).summary.count).toBe(1);
      expect(input).toEqual(copy);
    });

    it("gives identical results across repeated calls", () => {
      const events = generateEvents({ seed: 9, count: 500 });
      const first = nativeComputeAnalytics(events, { histogramBins: 7 });
      for (let i = 0; i < 3; i++) expectIdentical(nativeComputeAnalytics(events, { histogramBins: 7 }), first);
    });
  });

  describe("validation errors match the TypeScript engine (same message, same ordering)", () => {
    it.each(ERROR_CASES.map(([name, run]) => [name, run] as const))("fixture error case %s", (_name, run) => {
      const ts = outcome(() => run(TS_ENGINE));
      const native = outcome(() => run(NATIVE_ENGINE));
      expect(ts).toHaveProperty("error");
      expect(native).toEqual({ error: (ts as { error: string }).error, name: "ValidationError" });
    });

    const badEvents: Array<[string, unknown]> = [
      ["undefined events", undefined],
      ["null events", null],
      ["string events", "events"],
      ["object events", {}],
      ["number events", 5],
      ["null element", [null]],
      ["array element", [[]]],
      ["string element", ["x"]],
      ["number element", [1]],
      ["sparse array", [, good]],
      ["empty object", [{}]],
      ["string id", [{ ...good, id: "1" }]],
      ["fractional id", [{ ...good, id: 1.5 }]],
      ["null id", [{ ...good, id: null }]],
      ["boolean id", [{ ...good, id: true }]],
      ["huge id", [{ ...good, id: 1e300 }]],
      ["id beyond int64", [{ ...good, id: 2 ** 63 }]],
      ["NaN id", [{ ...good, id: NaN }]],
      ["string timestamp", [{ ...good, timestamp: "1000" }]],
      ["numeric eventType", [{ ...good, eventType: 3 }]],
      ["null category", [{ ...good, category: null }]],
      ["missing category", [{ id: 1, timestamp: 1, eventType: "a", value: 1 }]],
      ["string value", [{ ...good, value: "1" }]],
      ["undefined value", [{ ...good, value: undefined }]],
      ["bigint value", [{ ...good, value: 1n }]],
      ["lone surrogate category", [{ ...good, category: "\ud800" }]],
      ["NUL in eventType", [{ ...good, eventType: "a\u0000b" }]],
      ["range error before later type error", [{ ...good, id: -1 }, { ...good, value: "x" }]],
      ["type error before later range error", [{ ...good, value: "x" }, { ...good, id: -1 }]],
      ["earlier field range error wins within one event", [{ ...good, id: -1, timestamp: "x" }]],
      ["earlier field type error wins within one event", [{ ...good, id: "x", timestamp: -1 }]],
      ["valid prefix then bad element", [good, good, null]],
    ];
    it.each(badEvents)("compute: %s", (_name, events) => {
      expectSameOutcome((api) => api.computeAnalytics(events as AnalyticsEvent[]));
    });

    it("rejects more than the maximum number of events before looking at them", () => {
      const tooMany = new Array<unknown>(MAX_EVENTS + 1);
      expectSameOutcome((api) => api.computeAnalytics(tooMany as AnalyticsEvent[]));
      expect(outcome(() => nativeComputeAnalytics(tooMany))).toMatchObject({
        error: `events must contain at most ${MAX_EVENTS} items`,
      });
    });

    const badOptions: Array<[string, unknown]> = [
      ["string bins", { histogramBins: "10" }],
      ["null bins", { histogramBins: null }],
      ["fractional bins", { histogramBins: 1.5 }],
      ["NaN bins", { histogramBins: NaN }],
      ["Infinity bins", { histogramBins: Infinity }],
      ["huge bins", { histogramBins: 1e300 }],
      ["bins beyond int64", { histogramBins: 2 ** 63 }],
      ["zero bins", { histogramBins: 0 }],
      ["too many bins", { histogramBins: 1025 }],
      ["null options", null],
      ["array options", []],
      ["string options", "x"],
      ["number options", 5],
    ];
    it.each(badOptions)("compute options: %s", (_name, options) => {
      expectSameOutcome((api) => api.computeAnalytics([good], options as never));
      // events are validated before options, in both engines
      expectSameOutcome((api) => api.computeAnalytics([{ ...good, value: NaN }], options as never));
    });

    const badGenerate: Array<[string, unknown]> = [
      ["undefined options", undefined],
      ["null options", null],
      ["array options", []],
      ["string options", "x"],
      ["missing seed", { count: 1 }],
      ["missing count", { seed: 1 }],
      ["string seed", { seed: "1", count: 1 }],
      ["fractional count", { seed: 1, count: 2.5 }],
      ["seed beyond int64", { seed: 2 ** 63, count: 1 }],
      ["null startTimestamp", { seed: 1, count: 1, startTimestamp: null }],
      ["string intervalMs", { seed: 1, count: 1, intervalMs: "5" }],
      ["fractional startTimestamp", { seed: 1, count: 1, startTimestamp: 1.5 }],
      ["type error beats a later overflow", { seed: 1, count: 3, startTimestamp: 8_640_000_000_000_000, intervalMs: "x" }],
      ["overflow", { seed: 1, count: 3, startTimestamp: 8_640_000_000_000_000, intervalMs: 1 }],
      ["earlier range error wins", { seed: -1, count: "x" }],
      ["earlier type error wins", { seed: "x", count: -1 }],
    ];
    it.each(badGenerate)("generate: %s", (_name, options) => {
      expectSameOutcome((api) => api.generateEvents(options as never));
    });

    it("raw addon errors are Error instances carrying a stable code", () => {
      const addon = getNativeAddon();
      let thrown: unknown;
      try {
        addon.computeAnalytics([{ ...good, value: NaN }]);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { code?: string }).code).toBe("HPA_VALIDATION_ERROR");
    });

    it("surfaces native validation failures as the shared ValidationError class", () => {
      expect(() => nativeComputeAnalytics([{ ...good, value: NaN }])).toThrow(ValidationError);
    });

    it("propagates JavaScript exceptions thrown while reading input", () => {
      const hostile = {
        get id(): number {
          throw new RangeError("boom");
        },
      };
      expect(() => nativeComputeAnalytics([hostile])).toThrow("boom");
    });
  });
});
