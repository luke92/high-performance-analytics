import { describe, expect, it } from "vitest";
import {
  COMPUTE_GENERATED,
  COMPUTE_INLINE,
  ERROR_CASES,
  TS_ENGINE,
  type EngineApi,
} from "../../scripts/parityFixture.js";
import { computeAnalytics, generateEvents, MAX_EVENTS, type AnalyticsEvent } from "../../src/analytics/index.js";
import { expectIdentical, outcome } from "../../test/support.js";
import {
  experimentalComputeColumnar,
  experimentalComputeObjects,
  loadExperimental,
  packColumns,
  unpackColumns,
  type Columns,
} from "./columnar.js";

// These tests need `npm run native:experimental:build`. They skip loudly when it is missing and fail
// under HPA_REQUIRE_EXPERIMENTAL=1.
const available = loadExperimental() !== undefined;
const required = process.env["HPA_REQUIRE_EXPERIMENTAL"] === "1";
if (!available && !required) {
  console.warn("[experimental tests] SKIPPED: experimental addon not built (npm run native:experimental:build).");
}

const OBJECTS: EngineApi = {
  generateEvents: () => {
    throw new Error("not supported");
  },
  computeAnalytics: (events, options) => experimentalComputeObjects(events, options),
};
const COLUMNAR: EngineApi = {
  generateEvents: () => {
    throw new Error("not supported");
  },
  computeAnalytics: (events, options) => experimentalComputeColumnar(packColumns(events), options),
};

const good: AnalyticsEvent = { id: 1, timestamp: 1000, eventType: "view", category: "books", value: 10 };
const ev = (id: number, category: string, eventType: string, value: number): AnalyticsEvent => ({
  id,
  timestamp: 1000 * id,
  eventType,
  category,
  value,
});

/** Same call on TypeScript and the variant: identical result or identical error message. */
function expectSame(run: (api: EngineApi) => unknown, variant: EngineApi): void {
  const ts = outcome(() => run(TS_ENGINE));
  const other = outcome(() => run(variant));
  if ("error" in ts) expect(other).toEqual({ error: ts.error, name: "ValidationError" });
  else {
    expect("ok" in other, JSON.stringify(other)).toBe(true);
    expectIdentical((other as { ok: unknown }).ok, ts.ok);
  }
}

const computeErrorCases = ERROR_CASES.filter(([name]) => !name.startsWith("generate_"));

describe.skipIf(!available && !required)("experimental marshalling variants", () => {
  it.runIf(required)("are built when HPA_REQUIRE_EXPERIMENTAL=1", () => {
    expect(loadExperimental()).toBeDefined();
  });

  describe.each([
    ["objects (HandleScope + single-call reads)", OBJECTS],
    ["columnar (typed arrays + dictionaries)", COLUMNAR],
  ] as const)("%s", (_label, variant) => {
    it.each(COMPUTE_INLINE)("matches TypeScript exactly: inline %s", (_n, events, bins) => {
      expectIdentical(variant.computeAnalytics(events, { histogramBins: bins }), computeAnalytics(events, { histogramBins: bins }));
    });

    it.each(COMPUTE_GENERATED)("matches TypeScript exactly: generated %s", async (_n, options, bins) => {
      const { generateEvents } = await import("../../src/analytics/index.js");
      const events = generateEvents(options);
      const result = variant.computeAnalytics(events, { histogramBins: bins });
      expectIdentical(result, computeAnalytics(events, { histogramBins: bins }));
      expect(JSON.stringify(result)).toBe(JSON.stringify(computeAnalytics(events, { histogramBins: bins })));
    });

    it.each(computeErrorCases.map(([name, run]) => [name, run] as const))("same error as TypeScript: %s", (_n, run) => {
      expectSame(run, variant);
    });

    it("preserves negative zero and the extreme valid values", () => {
      const events: AnalyticsEvent[] = [
        ev(0, "a", "x", -0),
        { id: Number.MAX_SAFE_INTEGER, timestamp: 8_640_000_000_000_000, eventType: "x", category: "a", value: 1e12 },
        ev(3, "a", "x", -1e12),
        ev(4, "a", "x", 0),
      ];
      expectIdentical(variant.computeAnalytics(events), computeAnalytics(events));
    });

    it("is repeatable and does not change after repeated calls", () => {
      const events = [ev(1, "b", "y", 1.5), ev(2, "a", "x", 2.5)];
      const first = variant.computeAnalytics(events, { histogramBins: 3 });
      for (let i = 0; i < 3; i++) expectIdentical(variant.computeAnalytics(events, { histogramBins: 3 }), first);
    });

    it.each([
      ["fractional id", { ...good, id: 1.5 }],
      ["NaN id", { ...good, id: NaN }],
      ["id beyond int64", { ...good, id: 2 ** 63 }],
      ["id 2^53", { ...good, id: 2 ** 53 }],
      ["negative timestamp", { ...good, timestamp: -1 }],
      ["Infinity timestamp", { ...good, timestamp: Infinity }],
      ["NaN value", { ...good, value: NaN }],
      ["65-character category", { ...good, category: "a".repeat(65) }],
      ["multi-byte category over 64 bytes", { ...good, category: "é".repeat(33) }],
      ["64-character category (valid)", { ...good, category: "a".repeat(64) }],
      ["empty eventType", { ...good, eventType: "" }],
    ])("single invalid event behaves like TypeScript: %s", (_n, event) => {
      expectSame((api) => api.computeAnalytics([event as AnalyticsEvent]), variant);
    });

    it("reports the first invalid event, not a later one", () => {
      const events = [good, { ...good, value: NaN }, { ...good, id: -1 }];
      expectSame((api) => api.computeAnalytics(events), variant);
    });

    it.each([["string bins", "10"], ["zero", 0], ["too many", 1025], ["fractional", 1.5], ["null", null]])(
      "histogramBins %s behaves like TypeScript",
      (_n, bins) => {
        expectSame((api) => api.computeAnalytics([good], { histogramBins: bins as number }), variant);
      },
    );

    it("validates events before options, like TypeScript", () => {
      expectSame((api) => api.computeAnalytics([{ ...good, value: NaN }], null as never), variant);
      expectSame((api) => api.computeAnalytics([good], null as never), variant);
    });
  });

  describe("objects variant: input shapes", () => {
    const bad: Array<[string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["string", "events"],
      ["object", {}],
      ["null element", [null]],
      ["array element", [[]]],
      ["number element", [1]],
      ["sparse array", [, good]],
      ["string id", [{ ...good, id: "1" }]],
      ["null category", [{ ...good, category: null }]],
      ["string value", [{ ...good, value: "1" }]],
      ["bigint value", [{ ...good, value: 1n }]],
      ["range error before later type error", [{ ...good, id: -1 }, { ...good, value: "x" }]],
      ["type error before later range error", [{ ...good, value: "x" }, { ...good, id: -1 }]],
      ["valid prefix then bad element", [good, good, null]],
    ];
    it.each(bad)("%s behaves like TypeScript", (_n, events) => {
      expectSame((api) => api.computeAnalytics(events as AnalyticsEvent[]), OBJECTS);
    });

    it("rejects more than the maximum number of events before reading them", () => {
      expectSame((api) => api.computeAnalytics(new Array(MAX_EVENTS + 1) as AnalyticsEvent[]), OBJECTS);
    });

    it("propagates exceptions thrown by property getters", () => {
      const hostile = {
        get id(): number {
          throw new RangeError("boom");
        },
      };
      expect(() => experimentalComputeObjects([hostile])).toThrow("boom");
    });
  });

  describe("columnar variant: layout and length validation", () => {
    const columns = (): Columns => packColumns([ev(1, "a", "x", 1), ev(2, "b", "y", 2), ev(3, "a", "x", 3)]);
    const message = (cols: unknown) => outcome(() => experimentalComputeColumnar(cols));
    const error = (cols: unknown): string => (message(cols) as { error: string }).error;

    it("accepts an empty dataset and matches TypeScript", () => {
      expectIdentical(experimentalComputeColumnar(packColumns([]), { histogramBins: 3 }), computeAnalytics([], { histogramBins: 3 }));
    });

    it("rejects a non-object columns argument", () => {
      for (const c of [undefined, null, [], "x", 5]) expect(error(c)).toBe("columns must be an object");
    });

    it.each([
      ["ids", { ids: [1, 2, 3] }, "columns.ids must be a Float64Array"],
      ["ids as Float32Array", { ids: new Float32Array(3) }, "columns.ids must be a Float64Array"],
      ["timestamps missing", { timestamps: undefined }, "columns.timestamps must be a Float64Array"],
      ["values as Int32Array", { values: new Int32Array(3) }, "columns.values must be a Float64Array"],
      ["eventTypeCodes as Uint8Array", { eventTypeCodes: new Uint8Array(3) }, "columns.eventTypeCodes must be a Uint16Array"],
      ["categoryCodes as plain array", { categoryCodes: [0, 0, 0] }, "columns.categoryCodes must be a Uint16Array"],
      ["eventTypes not an array", { eventTypes: "x" }, "columns.eventTypes must be an array of strings"],
      ["categories entry not a string", { categories: ["a", 5] }, "columns.categories[1] must be a string"],
    ])("rejects %s", (_n, patch, expected) => {
      expect(error({ ...columns(), ...patch })).toBe(expected);
    });

    it("rejects columns of different lengths", () => {
      const c = columns();
      for (const key of ["timestamps", "values"] as const) {
        expect(error({ ...c, [key]: new Float64Array(2) })).toBe("columns must all have the same length");
        expect(error({ ...c, [key]: new Float64Array(4) })).toBe("columns must all have the same length");
      }
      for (const key of ["eventTypeCodes", "categoryCodes"] as const) {
        expect(error({ ...c, [key]: new Uint16Array(2) })).toBe("columns must all have the same length");
      }
      expect(error({ ...c, ids: new Float64Array(4) })).toBe("columns must all have the same length");
    });

    it("rejects more than the maximum number of events", () => {
      const c = columns();
      expect(error({ ...c, ids: new Float64Array(MAX_EVENTS + 1) })).toBe(`events must contain at most ${MAX_EVENTS} items`);
    });

    it("rejects codes outside their dictionary and names the column, index and size", () => {
      const c = columns();
      c.categoryCodes[2] = 2; // dictionary has 2 entries
      expect(error(c)).toBe("columns.categoryCodes[2] is out of range (dictionary has 2 entries)");
      const d = columns();
      d.eventTypeCodes[1] = 65535;
      expect(error(d)).toBe("columns.eventTypeCodes[1] is out of range (dictionary has 2 entries)");
    });

    it("reports an earlier invalid event before a later bad code", () => {
      const c = columns();
      c.values[0] = Number.NaN;
      c.categoryCodes[2] = 99;
      const expected = outcome(() => computeAnalytics([{ ...good, value: NaN }])) as { error: string };
      expect(error(c)).toBe(expected.error); // "events[0].value must be a finite number ..."
    });

    it("validates dictionary names per event, not per entry", () => {
      const c = packColumns([ev(1, "ok", "x", 1), ev(2, "a b", "x", 2)]);
      expectSame((api) => api.computeAnalytics([ev(1, "ok", "x", 1), ev(2, "a b", "x", 2)]), COLUMNAR);
      expect(error(c)).toContain("events[1].category");
      const unused = { ...columns(), categories: [...columns().categories, "not valid!"] };
      expect(() => experimentalComputeColumnar(unused)).not.toThrow(); // never referenced by any event
    });

    it("reads typed-array views with a byte offset correctly", () => {
      const events = Array.from({ length: 50 }, (_, i) => ev(i + 1, i % 2 ? "a" : "b", "x", i * 1.5));
      const c = packColumns(events);
      const pad = <T extends Float64Array | Uint16Array>(a: T, make: (n: number) => T): T => {
        const big = make(a.length + 8);
        big.set(a as never, 4);
        return big.subarray(4, 4 + a.length) as T;
      };
      const shifted = {
        ...c,
        ids: pad(c.ids, (n) => new Float64Array(n)),
        timestamps: pad(c.timestamps, (n) => new Float64Array(n)),
        values: pad(c.values, (n) => new Float64Array(n)),
        eventTypeCodes: pad(c.eventTypeCodes, (n) => new Uint16Array(n)),
        categoryCodes: pad(c.categoryCodes, (n) => new Uint16Array(n)),
      };
      expect(shifted.ids.byteOffset).toBeGreaterThan(0);
      expectIdentical(experimentalComputeColumnar(shifted), computeAnalytics(events));
    });

    it("packColumns and unpackColumns round-trip exactly", () => {
      const events = generateEvents({ seed: 3, count: 500 });
      expect(unpackColumns(packColumns(events))).toEqual(events);
      expect(unpackColumns(packColumns([]))).toEqual([]);
    });

    it("does not modify the columns it reads", () => {
      const c = columns();
      const copy = { ids: c.ids.slice(), values: c.values.slice(), codes: c.categoryCodes.slice() };
      experimentalComputeColumnar(c);
      expect(c.ids).toEqual(copy.ids);
      expect(c.values).toEqual(copy.values);
      expect(c.categoryCodes).toEqual(copy.codes);
    });

    it("rejects more than 65536 dictionary entries and packs up to 65536 names", () => {
      const names = Array.from({ length: 65537 }, (_, i) => `n${i}`);
      expect(error({ ...columns(), categories: names })).toBe("columns.categories must have at most 65536 entries");
      const events = names.slice(0, 65536).map((n, i) => ev(i + 1, n, "x", i));
      expectIdentical(experimentalComputeColumnar(packColumns(events)), computeAnalytics(events));
      expect(() => packColumns([...events, ev(99999, "one-too-many", "x", 0)])).toThrow(RangeError);
    }, 60_000); // 65536 groups make the TypeScript reference slow
  });
});
