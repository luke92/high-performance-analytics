/**
 * TypeScript baseline benchmark. Usage:
 *   npm run bench -- [--sizes=10000,100000,1000000] [--warmup=2] [--runs=5] [--seed=42] [--json]
 *
 * Correctness is verified for every size BEFORE any timing is recorded.
 * Timings use performance.now() (monotonic, sub-millisecond resolution).
 * Only the TypeScript implementation exists at this stage: there is nothing to compare against.
 */
import os from "node:os";
import { performance } from "node:perf_hooks";
import { computeAnalytics, generateEvents, type AnalyticsEvent, type AnalyticsResult } from "../src/analytics/index.js";

interface Args {
  sizes: number[];
  warmup: number;
  runs: number;
  seed: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sizes: [10_000, 100_000, 1_000_000], warmup: 2, runs: 5, seed: 42, json: false };
  for (const arg of argv) {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    if (key === "json") args.json = true;
    else if (key === "sizes") args.sizes = value.split(",").map(Number);
    else if (key === "warmup") args.warmup = Number(value);
    else if (key === "runs") args.runs = Number(value);
    else if (key === "seed") args.seed = Number(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const ok =
    args.sizes.length > 0 &&
    args.sizes.every((n) => Number.isInteger(n) && n > 0 && n <= 5_000_000) &&
    Number.isInteger(args.warmup) && args.warmup >= 0 &&
    Number.isInteger(args.runs) && args.runs >= 1 &&
    Number.isInteger(args.seed) && args.seed >= 0 && args.seed <= 4_294_967_295;
  if (!ok) throw new Error("Invalid arguments: sizes in 1..5000000, warmup >= 0, runs >= 1, seed uint32");
  return args;
}

/** Independent, deliberately naive oracle (sort with comparator, Array.reduce, linear bin search). */
function verify(events: AnalyticsEvent[], result: AnalyticsResult, bins: number): void {
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

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { minMs: sorted[0]!, medianMs: median, maxMs: sorted[sorted.length - 1]!, samplesMs: samples };
}

function time<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

const args = parseArgs(process.argv.slice(2));
const BINS = 10;

const environment = {
  node: process.version,
  v8: process.versions.v8,
  platform: `${process.platform} ${os.release()}`,
  arch: process.arch,
  cpu: os.cpus()[0]?.model.trim() ?? "unknown",
  logicalCpus: os.cpus().length,
  totalMemoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
};

const results = [];
for (const size of args.sizes) {
  const generation = { ms: 0, events: [] as AnalyticsEvent[] };
  const g = time(() => generateEvents({ seed: args.seed, count: size }));
  generation.ms = g.ms;
  generation.events = g.value;
  const events = generation.events;

  const first = computeAnalytics(events, { histogramBins: BINS });
  verify(events, first, BINS); // correctness before timing

  for (let i = 0; i < args.warmup; i++) computeAnalytics(events, { histogramBins: BINS });

  const samples: number[] = [];
  for (let i = 0; i < args.runs; i++) samples.push(time(() => computeAnalytics(events, { histogramBins: BINS })).ms);

  const generateSamples: number[] = [];
  for (let i = 0; i < args.runs; i++) {
    generateSamples.push(time(() => generateEvents({ seed: args.seed, count: size })).ms);
  }

  results.push({
    events: size,
    verified: true,
    compute: stats(samples),
    generate: stats(generateSamples),
  });
}

const report = {
  implementation: "typescript",
  note: "includes input validation; no C++/WASM implementation exists yet, so no speedups are reported",
  config: { seed: args.seed, histogramBins: BINS, warmupRuns: args.warmup, measuredRuns: args.runs },
  environment,
  results,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`TypeScript baseline (seed=${args.seed}, bins=${BINS}, warmup=${args.warmup}, runs=${args.runs})`);
  console.log(`Node ${environment.node} (V8 ${environment.v8}), ${environment.platform} ${environment.arch}`);
  console.log(`CPU: ${environment.cpu} x${environment.logicalCpus}, ${environment.totalMemoryGiB} GiB RAM`);
  console.log("Correctness verified before timing. compute() includes input validation.\n");
  const f = (x: number) => x.toFixed(2).padStart(10);
  console.log("events".padStart(10), "op".padEnd(9), "min ms".padStart(10), "median ms".padStart(10), "max ms".padStart(10));
  for (const r of results) {
    for (const [op, s] of [["compute", r.compute], ["generate", r.generate]] as const) {
      console.log(String(r.events).padStart(10), op.padEnd(9), f(s.minMs), f(s.medianMs), f(s.maxMs));
    }
  }
}
