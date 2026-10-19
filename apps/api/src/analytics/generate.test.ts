import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  EVENT_TYPES,
  generateEvents,
  MAX_EVENTS,
  ValidationError,
  validateEvents,
  type GenerateOptions,
} from "./index.js";

describe("generateEvents: determinism", () => {
  it("returns identical events for the same seed and options", () => {
    const options = { seed: 123, count: 500, startTimestamp: 5000, intervalMs: 7 };
    expect(generateEvents(options)).toEqual(generateEvents({ ...options }));
  });

  it("returns different events for different seeds", () => {
    expect(generateEvents({ seed: 1, count: 50 })).not.toEqual(generateEvents({ seed: 2, count: 50 }));
  });

  it("treats a smaller count as a prefix of a larger one", () => {
    const small = generateEvents({ seed: 9, count: 10 });
    const large = generateEvents({ seed: 9, count: 100 });
    expect(large.slice(0, 10)).toEqual(small);
  });

  // Golden values, independently cross-checked with a separate mulberry32
  // implementation. The C++ core must reproduce these exactly.
  it("matches pinned golden events for seed 42", () => {
    expect(generateEvents({ seed: 42, count: 3 })).toEqual([
      { id: 1, timestamp: 1_700_000_000_000, eventType: "click", category: "home", value: 726.69 },
      { id: 2, timestamp: 1_700_000_001_000, eventType: "view", category: "home", value: 277.29 },
      { id: 3, timestamp: 1_700_000_002_000, eventType: "add_to_cart", category: "clothing", value: 749.04 },
    ]);
  });

  it("matches pinned golden events for seed 0", () => {
    expect(generateEvents({ seed: 0, count: 2 })).toEqual([
      { id: 1, timestamp: 1_700_000_000_000, eventType: "view", category: "clothing", value: 49.85 },
      { id: 2, timestamp: 1_700_000_001_000, eventType: "click", category: "books", value: 297.07 },
    ]);
  });
});

describe("generateEvents: output shape", () => {
  const events = generateEvents({ seed: 5, count: 2000, startTimestamp: 1000, intervalMs: 50 });

  it("produces the requested number of valid events", () => {
    expect(events).toHaveLength(2000);
    expect(() => validateEvents(events)).not.toThrow();
  });

  it("assigns sequential ids and evenly spaced timestamps", () => {
    expect(events[0]).toMatchObject({ id: 1, timestamp: 1000 });
    expect(events[1999]).toMatchObject({ id: 2000, timestamp: 1000 + 1999 * 50 });
  });

  it("uses only the documented categories, types and value range", () => {
    for (const e of events) {
      expect(CATEGORIES).toContain(e.category);
      expect(EVENT_TYPES).toContain(e.eventType);
      expect(e.value).toBeGreaterThanOrEqual(0);
      expect(e.value).toBeLessThan(1000);
    }
  });

  it("covers every category and event type over many events", () => {
    expect(new Set(events.map((e) => e.category)).size).toBe(CATEGORIES.length);
    expect(new Set(events.map((e) => e.eventType)).size).toBe(EVENT_TYPES.length);
  });

  it("supports zero events", () => {
    expect(generateEvents({ seed: 1, count: 0 })).toEqual([]);
  });

  it("accepts the maximum seed", () => {
    expect(generateEvents({ seed: 4_294_967_295, count: 1 })).toHaveLength(1);
  });
});

describe("generateEvents: invalid options", () => {
  const bad = (o: unknown) => () => generateEvents(o as GenerateOptions);

  it.each([
    ["negative seed", { seed: -1, count: 1 }],
    ["seed above uint32", { seed: 4_294_967_296, count: 1 }],
    ["fractional seed", { seed: 1.5, count: 1 }],
    ["NaN seed", { seed: NaN, count: 1 }],
    ["missing seed", { count: 1 }],
    ["missing count", { seed: 1 }],
    ["negative count", { seed: 1, count: -1 }],
    ["fractional count", { seed: 1, count: 2.5 }],
    ["count above maximum", { seed: 1, count: MAX_EVENTS + 1 }],
    ["string count", { seed: 1, count: "10" }],
    ["zero interval", { seed: 1, count: 1, intervalMs: 0 }],
    ["interval above one day", { seed: 1, count: 1, intervalMs: 86_400_001 }],
    ["negative start", { seed: 1, count: 1, startTimestamp: -5 }],
    ["timestamps overflowing the range", { seed: 1, count: 3, startTimestamp: 8_640_000_000_000_000, intervalMs: 1 }],
    ["null options", null],
    ["array options", []],
  ])("rejects %s", (_name, options) => {
    expect(bad(options)).toThrow(ValidationError);
  });

  it("accepts a last timestamp exactly at the range limit", () => {
    const events = generateEvents({ seed: 1, count: 3, startTimestamp: 8_639_999_999_999_998, intervalMs: 1 });
    expect(events[2]?.timestamp).toBe(8_640_000_000_000_000);
  });
});
