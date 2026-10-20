/** Helpers shared by the benchmark scripts (run.ts, compare.ts). Not used by any request path. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { computeAnalytics, type AnalyticsEvent, type AnalyticsResult } from "../src/analytics/index.js";
import { createRng } from "../src/analytics/prng.js";

/** Monotonic high-resolution timer around a single call. */
export function time<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

export function baseEnvironment() {
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform} ${os.release()}`,
    arch: process.arch,
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    logicalCpus: os.cpus().length,
    totalMemoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
  };
}

/** Reads compiler id/version from a CMake build directory's generated compiler info (best effort). */
export function cmakeCompilerInfo(buildDir: string): { compiler: string; version: string } {
  try {
    const cmakeFiles = join(buildDir, "CMakeFiles");
    const dir = readdirSync(cmakeFiles).find((d) => /^\d+\.\d+/.test(d));
    const text = readFileSync(join(cmakeFiles, dir ?? "", "CMakeCXXCompiler.cmake"), "utf8");
    const id = /set\(CMAKE_CXX_COMPILER_ID "([^"]*)"\)/.exec(text)?.[1] ?? "unknown";
    const version = /set\(CMAKE_CXX_COMPILER_VERSION "([^"]*)"\)/.exec(text)?.[1] ?? "unknown";
    return { compiler: id, version };
  } catch {
    return { compiler: "unknown", version: "unknown" };
  }
}

/** Best-effort commit id and whether the working tree had uncommitted changes. */
export function gitInfo(): { commit: string; dirty: boolean } | { commit: "unknown"; dirty: false } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

/** Independent, deliberately naive oracle (sort with comparator, Array.reduce, linear bin search). */
export function verify(events: AnalyticsEvent[], result: AnalyticsResult, bins: number): void {
  const fail = (msg: string): never => {
    throw new Error(`Correctness check failed for n=${events.length}: ${msg}`);
  };
  const n = events.length;
  const sorted = events.map((e) => e.value).sort((a, b) => a - b);
  const sum = events.reduce((s, e) => s + e.value, 0);
  if (result.summary.count !== n) fail("summary.count");
  if (result.summary.sum !== sum) fail("summary.sum");
  if (result.summary.min !== sorted[0] || result.summary.max !== sorted[n - 1]) fail("min/max");
  for (const [p, got] of [[50, result.percentiles.p50], [95, result.percentiles.p95], [99, result.percentiles.p99]] as const) {
    const rank = Math.ceil((p * n) / 100);
    if (got !== sorted[rank - 1]) fail(`p${p}`);
  }
  if (result.countsByCategoryAndType.reduce((s, g) => s + g.count, 0) !== n) fail("group counts");
  if (result.byCategory.reduce((s, g) => s + g.count, 0) !== n) fail("category counts");
  const h = result.histogram;
  if (h.counts.length !== bins || h.counts.reduce((a, b) => a + b, 0) !== n) fail("histogram total");
  const { min, max } = result.summary as { min: number; max: number };
  const width = (max - min) / bins;
  const expected = new Array<number>(bins).fill(0);
  for (const v of sorted) expected[width === 0 ? 0 : Math.min(bins - 1, Math.floor((v - min) / width))]!++;
  if (expected.some((c, i) => c !== h.counts[i])) fail("histogram bins");
  if (JSON.stringify(computeAnalytics(events, { histogramBins: bins })) !== JSON.stringify(result)) {
    fail("non-deterministic result");
  }
}

/**
 * Returns the path of the first difference between two JSON-like values, or undefined if they are
 * identical. Numbers are compared with Object.is (so -0 differs from 0) and key order must match.
 */
export function firstDifference(actual: unknown, expected: unknown, path = "$"): string | undefined {
  if (typeof expected === "number" || typeof actual === "number") {
    return Object.is(actual, expected) ? undefined : `${path}: ${String(actual)} !== ${String(expected)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array`;
    if (actual.length !== expected.length) return `${path}.length: ${actual.length} !== ${expected.length}`;
    for (let i = 0; i < expected.length; i++) {
      const d = firstDifference(actual[i], expected[i], `${path}[${i}]`);
      if (d) return d;
    }
    return undefined;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return `${path}: expected an object`;
    const ak = Object.keys(actual);
    const ek = Object.keys(expected);
    if (ak.join() !== ek.join()) return `${path}: keys [${ak.join()}] !== [${ek.join()}]`;
    for (const key of ek) {
      const d = firstDifference((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
      if (d) return d;
    }
    return undefined;
  }
  return actual === expected ? undefined : `${path}: ${String(actual)} !== ${String(expected)}`;
}

// ---- Statistics -----------------------------------------------------------------------------

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface Summary {
  n: number;
  minMs: number;
  p25Ms: number;
  medianMs: number;
  p75Ms: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  /** Median absolute deviation: a robust spread measure. */
  madMs: number;
  /** Coefficient of variation (stddev / mean), as a fraction. */
  cv: number;
  samplesMs: number[];
}

export function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  const median = quantile(sorted, 0.5);
  const variance = n > 1 ? sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const mad = quantile(sorted.map((x) => Math.abs(x - median)).sort((a, b) => a - b), 0.5);
  return {
    n,
    minMs: sorted[0]!,
    p25Ms: quantile(sorted, 0.25),
    medianMs: median,
    p75Ms: quantile(sorted, 0.75),
    maxMs: sorted[n - 1]!,
    meanMs: mean,
    stddevMs: Math.sqrt(variance),
    madMs: mad,
    cv: mean === 0 ? 0 : Math.sqrt(variance) / mean,
    samplesMs: samples,
  };
}

export interface Comparison {
  baseline: string;
  candidate: string;
  /** median(baseline) / median(candidate): above 1 means the candidate is faster. */
  medianRatio: number;
  /** 95% bootstrap interval (seeded, 2000 resamples) for that ratio of medians. */
  ratioCi95: [number, number];
  verdict: "candidate faster" | "candidate slower" | "inconclusive";
  note: string;
}

function median(xs: number[]): number {
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

/**
 * Compares two sample sets. The verdict is "faster"/"slower" only if the whole 95% interval of
 * the median ratio lies on one side of 1 AND the effect is at least 5%; otherwise "inconclusive".
 * Deterministic: the bootstrap uses a fixed-seed PRNG.
 */
export function compare(baselineName: string, baseline: number[], candidateName: string, candidate: number[]): Comparison {
  const ratio = median(baseline) / median(candidate);
  const rng = createRng(0x5eed);
  const resample = (xs: number[]) => xs.map(() => xs[Math.floor(rng() * xs.length)]!);
  const ratios: number[] = [];
  for (let i = 0; i < 2000; i++) ratios.push(median(resample(baseline)) / median(resample(candidate)));
  ratios.sort((a, b) => a - b);
  const lo = quantile(ratios, 0.025);
  const hi = quantile(ratios, 0.975);
  let verdict: Comparison["verdict"] = "inconclusive";
  if (lo > 1 && ratio >= 1.05) verdict = "candidate faster";
  else if (hi < 1 && ratio <= 1 / 1.05) verdict = "candidate slower";
  const note =
    verdict === "inconclusive"
      ? "interval includes 1 or the effect is below 5%"
      : `${candidateName} median is ${ratio >= 1 ? ratio.toFixed(2) + "x faster" : (1 / ratio).toFixed(2) + "x slower"} than ${baselineName}`;
  return { baseline: baselineName, candidate: candidateName, medianRatio: ratio, ratioCi95: [lo, hi], verdict, note };
}
