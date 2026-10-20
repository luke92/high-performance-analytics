/// <reference types="node" />
import { beforeAll, describe, expect, it } from "vitest";
import {
  COMPUTE_GENERATED,
  COMPUTE_INLINE,
  ERROR_CASES,
  GENERATE_CASES,
  TS_ENGINE,
  type EngineApi,
} from "../../../api/scripts/parityFixture.js";
import { computeAnalytics, generateEvents } from "../../../api/src/analytics/index.js";
import type { AnalyticsEvent } from "../../../api/src/analytics/types.js";
import type { HpaCore } from "./hpaCore.js";
import { packColumns, unpackColumns } from "./packColumns.js";
import type { Columns } from "./types.js";
import { describeWasm, expectIdentical, getCore, outcome, wasmEngineApi, WasmLimitError, WasmValidationError } from "./support.testing.js";

const good: AnalyticsEvent = { id: 1, timestamp: 1000, eventType: "view", category: "books", value: 10 };
const ev = (id: number, category: string, eventType: string, value: number): AnalyticsEvent => ({ id, timestamp: 1000 * id, eventType, category, value });

describeWasm("WebAssembly core (real module, parity with the TypeScript engine)", () => {
  let core: HpaCore;
  let wasm: EngineApi;
  beforeAll(async () => {
    core = await getCore();
    wasm = wasmEngineApi(core);
  });

  /** Same call on both engines: identical result (Object.is, key order) or identical error message. */
  function expectSame(run: (api: EngineApi) => unknown): void {
    const ts = outcome(() => run(TS_ENGINE));
    const other = outcome(() => run(wasm));
    if ("error" in ts) expect(other).toEqual({ error: ts.error });
    else {
      expect("ok" in other, JSON.stringify(other)).toBe(true);
      expectIdentical((other as { ok: unknown }).ok, ts.ok);
    }
  }

  it("reports its versions and limits", () => {
    expect(core.info.coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(core.info.abiVersion).toBe(1);
    expect(core.info.eventStructBytes).toBeGreaterThan(0);
    expect(core.info.maxEvents).toBe(1_000_000);
  });

  describe("generation", () => {
    it.each(GENERATE_CASES)("matches the TypeScript generator exactly: %s", (_name, options) => {
      expectIdentical(unpackColumns(core.generate(options)), generateEvents(options));
    });

    it("returns copies that survive later calls", () => {
      const first = core.generate({ seed: 5, count: 50 });
      const snapshot = unpackColumns(first);
      core.generate({ seed: 99, count: 5000 }); // reuses the module's buffers
      core.compute(packColumns(generateEvents({ seed: 1, count: 3000 })));
      expectIdentical(unpackColumns(first), snapshot);
    });
  });

  describe("compute", () => {
    it.each(COMPUTE_INLINE)("matches TypeScript exactly: inline %s", (_name, events, bins) => {
      expectIdentical(core.compute(packColumns(events), { histogramBins: bins }), computeAnalytics(events, { histogramBins: bins }));
    });

    it.each(COMPUTE_GENERATED)("matches TypeScript exactly: generated %s", (_name, options, bins) => {
      const events = generateEvents(options);
      const result = core.compute(packColumns(events), { histogramBins: bins });
      expectIdentical(result, computeAnalytics(events, { histogramBins: bins }));
      expect(JSON.stringify(result)).toBe(JSON.stringify(computeAnalytics(events, { histogramBins: bins })));
    });

    it("uses 10 histogram bins by default and handles an empty dataset", () => {
      const events = generateEvents({ seed: 3, count: 40 });
      expectIdentical(core.compute(packColumns(events)), computeAnalytics(events));
      expectIdentical(core.compute(packColumns([]), { histogramBins: 3 }), computeAnalytics([], { histogramBins: 3 }));
    });

    it("preserves negative zero, extreme ids and exact floating-point sums", () => {
      const events: AnalyticsEvent[] = [
        ev(0, "a", "x", -0),
        { id: Number.MAX_SAFE_INTEGER, timestamp: 8_640_000_000_000_000, eventType: "x", category: "a", value: 1e12 },
        ev(3, "a", "x", -1e12),
        ev(4, "a", "x", 0.1),
        ev(5, "a", "x", 0.2),
        ev(6, "a", "x", 0.3),
      ];
      expectIdentical(core.compute(packColumns(events)), computeAnalytics(events));
      const result = core.compute(packColumns([ev(1, "a", "x", 0), ev(2, "a", "x", 0), ev(3, "a", "x", -0), ev(4, "a", "x", -0)]));
      expect(Object.is(result.percentiles.p50, -0)).toBe(true); // -0 sorts before +0, like TypeScript
    });

    it("keeps percentile and histogram boundaries identical to TypeScript", () => {
      for (const n of [1, 2, 3, 10, 99, 100, 101]) {
        const events = Array.from({ length: n }, (_, i) => ev(i + 1, "a", "x", (i * 7) % 13));
        for (const bins of [1, 2, 7, 10, 64]) expectSame((api) => api.computeAnalytics(events, { histogramBins: bins }));
      }
    });
  });

  describe("errors: same messages and ordering as the TypeScript engine", () => {
    it.each(ERROR_CASES.map(([name, run]) => [name, run] as const))("fixture case %s", (_name, run) => {
      const ts = outcome(() => run(TS_ENGINE));
      expect(ts).toHaveProperty("error");
      expect(outcome(() => run(wasm))).toEqual(ts);
    });

    it.each([
      ["fractional id", { ...good, id: 1.5 }],
      ["NaN id", { ...good, id: NaN }],
      ["id beyond int64", { ...good, id: 2 ** 63 }],
      ["Infinity timestamp", { ...good, timestamp: Infinity }],
      ["NaN value", { ...good, value: NaN }],
      ["65-character category", { ...good, category: "a".repeat(65) }],
      ["multi-byte category over 64 bytes", { ...good, category: "é".repeat(33) }],
      ["empty eventType", { ...good, eventType: "" }],
    ])("single invalid event: %s", (_n, event) => {
      expectSame((api) => api.computeAnalytics([event as AnalyticsEvent]));
    });

    it("reports the first invalid event, and events before options", () => {
      expectSame((api) => api.computeAnalytics([good, { ...good, value: NaN }, { ...good, id: -1 }]));
      expectSame((api) => api.computeAnalytics([{ ...good, value: NaN }], { histogramBins: 0 }));
      expectSame((api) => api.computeAnalytics([good], { histogramBins: 1.5 }));
    });
  });

  describe("columnar layout validation", () => {
    const columns = (): Columns => packColumns([ev(1, "a", "x", 1), ev(2, "b", "y", 2), ev(3, "a", "x", 3)]);
    const messageOf = (cols: unknown): string => {
      try {
        core.compute(cols as Columns);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected an error");
    };

    it("rejects wrong column objects, types and dictionaries", () => {
      for (const c of [undefined, null, [], "x", 5]) expect(messageOf(c)).toBe("columns must be an object");
      expect(messageOf({ ...columns(), ids: [1, 2, 3] })).toBe("columns.ids must be a Float64Array");
      expect(messageOf({ ...columns(), values: new Float32Array(3) })).toBe("columns.values must be a Float64Array");
      expect(messageOf({ ...columns(), categoryCodes: new Uint8Array(3) })).toBe("columns.categoryCodes must be a Uint16Array");
      expect(messageOf({ ...columns(), eventTypes: "x" })).toBe("columns.eventTypes must be an array of strings");
      expect(messageOf({ ...columns(), categories: ["a", 5] })).toBe("columns.categories[1] must be a string");
      expect(messageOf({ ...columns(), categories: Array.from({ length: 65537 }, (_, i) => `n${i}`) })).toBe("columns.categories must have at most 65536 entries");
    });

    it("rejects columns of different lengths", () => {
      const c = columns();
      for (const key of ["timestamps", "values"] as const) expect(messageOf({ ...c, [key]: new Float64Array(2) })).toBe("columns must all have the same length");
      for (const key of ["eventTypeCodes", "categoryCodes"] as const) expect(messageOf({ ...c, [key]: new Uint16Array(4) })).toBe("columns must all have the same length");
      expect(messageOf({ ...c, ids: new Float64Array(4) })).toBe("columns must all have the same length");
    });

    it("rejects codes outside their dictionary, after validating earlier events", () => {
      const c = columns();
      c.categoryCodes[2] = 2;
      expect(messageOf(c)).toBe("columns.categoryCodes[2] is out of range (dictionary has 2 entries)");
      const d = columns();
      d.eventTypeCodes[1] = 65535;
      expect(messageOf(d)).toBe("columns.eventTypeCodes[1] is out of range (dictionary has 2 entries)");
      const e = columns();
      e.values[0] = Number.NaN;
      e.categoryCodes[2] = 99;
      expect(messageOf(e)).toBe((outcome(() => computeAnalytics([{ ...good, value: NaN }])) as { error: string }).error);
    });

    it("enforces the per-call event limit but defers to the core's own message above 5,000,000", () => {
      const limited = (n: number): Columns => ({ ...columns(), ids: new Float64Array(n) });
      expect(() => core.compute(limited(core.info.maxEvents + 1))).toThrow(WasmLimitError);
      expect(() => core.compute(limited(5_000_001))).toThrow("events must contain at most 5000000 items");
      expect(() => core.compute(limited(5_000_001))).toThrow(WasmValidationError);
      expect(() => core.generate({ seed: 1, count: core.info.maxEvents + 1 })).toThrow(WasmLimitError);
      expect(() => core.generate({ seed: 1, count: 5_000_001 })).toThrow("count must be an integer between 0 and 5000000");
    });
  });

  describe("typed-array views respect their offsets and lengths", () => {
    const events = Array.from({ length: 64 }, (_, i) => ev(i + 1, i % 3 ? "a" : "b", i % 2 ? "x" : "y", i * 1.25));

    /** Places `source` inside a larger buffer surrounded by poison values and returns the inner view. */
    function embedded<T extends Float64Array | Uint16Array>(source: T, make: (length: number) => T, poison: number): T {
      const big = make(source.length + 20);
      big.fill(poison);
      big.set(source as never, 7);
      return big.subarray(7, 7 + source.length) as T;
    }

    it("reads only the viewed region of each column", () => {
      const c = packColumns(events);
      const shifted: Columns = {
        ...c,
        ids: embedded(c.ids, (n) => new Float64Array(n), Number.NaN),
        timestamps: embedded(c.timestamps, (n) => new Float64Array(n), -1),
        values: embedded(c.values, (n) => new Float64Array(n), Number.NaN),
        eventTypeCodes: embedded(c.eventTypeCodes, (n) => new Uint16Array(n), 65535),
        categoryCodes: embedded(c.categoryCodes, (n) => new Uint16Array(n), 65535),
      };
      expect(shifted.ids.byteOffset).toBeGreaterThan(0);
      expectIdentical(core.compute(shifted), computeAnalytics(events)); // poison would change or fail the result
    });

    it("does not read past a view that is shorter than its buffer", () => {
      const c = packColumns(events);
      const head = (a: Float64Array | Uint16Array, n: number) => a.subarray(0, n);
      const trimmed: Columns = {
        ...c,
        ids: head(c.ids, 10) as Float64Array,
        timestamps: head(c.timestamps, 10) as Float64Array,
        values: head(c.values, 10) as Float64Array,
        eventTypeCodes: head(c.eventTypeCodes, 10) as Uint16Array,
        categoryCodes: head(c.categoryCodes, 10) as Uint16Array,
      };
      expectIdentical(core.compute(trimmed), computeAnalytics(events.slice(0, 10)));
    });

    it("never modifies the arrays it reads", () => {
      const c = packColumns(events);
      const copy = { ids: c.ids.slice(), values: c.values.slice(), codes: c.categoryCodes.slice() };
      core.compute(c);
      expect(c.ids).toEqual(copy.ids);
      expect(c.values).toEqual(copy.values);
      expect(c.categoryCodes).toEqual(copy.codes);
    });
  });

  describe("memory", () => {
    it("handles an input larger than the initial heap and grows it", () => {
      const before = core.heapBytes();
      const events = generateEvents({ seed: 8, count: 450_000 });
      const result = core.compute(packColumns(events));
      expectIdentical(result, computeAnalytics(events));
      expect(core.heapBytes()).toBeGreaterThan(before);
    }, 120_000);

    it("does not leak across calls (heap stays flat after warm-up)", () => {
      const columns = packColumns(generateEvents({ seed: 2, count: 20_000 }));
      for (let i = 0; i < 5; i++) core.compute(columns); // warm-up
      const settled = core.heapBytes();
      for (let i = 0; i < 100; i++) core.compute(columns);
      expect(core.heapBytes()).toBe(settled);
    });

    it("works with the heap's views refreshed after growth (small call after a big one)", () => {
      const small = generateEvents({ seed: 1, count: 100 });
      expectIdentical(core.compute(packColumns(small)), computeAnalytics(small));
    });
  });
});
