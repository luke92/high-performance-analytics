import { describe, expect, it } from "vitest";
import { compare, firstDifference, summarize } from "./common.js";

describe("summarize", () => {
  it("computes quantiles, spread and keeps raw samples (odd count)", () => {
    const s = summarize([5, 1, 3, 2, 4]);
    expect(s).toMatchObject({ n: 5, minMs: 1, p25Ms: 2, medianMs: 3, p75Ms: 4, maxMs: 5, meanMs: 3, madMs: 1 });
    expect(s.stddevMs).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(s.cv).toBeCloseTo(Math.sqrt(2.5) / 3, 12);
    expect(s.samplesMs).toEqual([5, 1, 3, 2, 4]); // original order preserved
  });

  it("interpolates the median for an even count and handles a single sample", () => {
    expect(summarize([1, 2, 3, 4]).medianMs).toBe(2.5);
    expect(summarize([7])).toMatchObject({ n: 1, medianMs: 7, stddevMs: 0, madMs: 0, cv: 0 });
  });
});

describe("compare", () => {
  const noisy = (center: number, n = 20) => Array.from({ length: n }, (_, i) => center * (1 + ((i % 5) - 2) * 0.01));

  it("reports a clearly faster candidate", () => {
    const c = compare("a", noisy(10), "b", noisy(5));
    expect(c.verdict).toBe("candidate faster");
    expect(c.medianRatio).toBeCloseTo(2, 1);
    expect(c.ratioCi95[0]).toBeGreaterThan(1);
  });

  it("reports a clearly slower candidate", () => {
    const c = compare("a", noisy(5), "b", noisy(10));
    expect(c.verdict).toBe("candidate slower");
    expect(c.ratioCi95[1]).toBeLessThan(1);
  });

  it("is inconclusive for identical distributions and for tiny effects", () => {
    expect(compare("a", noisy(10), "b", noisy(10)).verdict).toBe("inconclusive");
    expect(compare("a", noisy(10), "b", noisy(9.8)).verdict).toBe("inconclusive"); // 2% < 5%
  });

  it("is inconclusive when the samples are too noisy to separate", () => {
    const wide = [1, 20, 2, 18, 3, 25, 1.5, 22];
    expect(compare("a", wide, "b", [...wide].reverse().map((x) => x * 1.1)).verdict).toBe("inconclusive");
  });

  it("is deterministic", () => {
    const x = noisy(10);
    const y = noisy(7);
    expect(compare("a", x, "b", y)).toEqual(compare("a", x, "b", y));
  });
});

describe("firstDifference", () => {
  it("accepts identical structures", () => {
    expect(firstDifference({ a: [1, 2, { b: null }], c: "x" }, { a: [1, 2, { b: null }], c: "x" })).toBeUndefined();
  });

  it("distinguishes -0 from 0 and reports the path", () => {
    expect(firstDifference({ p: { v: -0 } }, { p: { v: 0 } })).toContain("$.p.v");
  });

  it("detects key order, length and value differences", () => {
    expect(firstDifference({ a: 1, b: 2 }, { b: 2, a: 1 })).toContain("keys");
    expect(firstDifference([1, 2], [1, 2, 3])).toContain("length");
    expect(firstDifference({ a: [1, 2] }, { a: [1, 3] })).toContain("$.a[1]");
    expect(firstDifference({ a: null }, { a: 0 })).toBeDefined();
  });
});
