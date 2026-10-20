/**
 * TypeScript vs native C++ benchmark. Not part of any request path.
 *
 *   npm run bench:core:build          # once: builds cpp/build/bench/bin/hpa_bench
 *   npm run native:build              # once: builds the Node-API addon
 *   npm run bench:compare -- [options]
 *
 * Options (all optional):
 *   --sizes=10000,100000        in-process engine calls through the addon (<= 100000, the API limit)
 *   --http-sizes=10000,100000   end-to-end HTTP requests against the real Express app (<= 100000)
 *   --core-sizes=10000,100000,1000000   TypeScript engine vs hpa::core called directly from C++
 *   --warmup=5 --runs=20        for the in-process section
 *   --http-warmup=3 --http-runs=10
 *   --core-warmup=3 --core-runs=10
 *   --seed=42 --bins=10
 *   --out=<file>                JSON report path (default bench-results/compare-<timestamp>.json)
 *   --json                      print the JSON report to stdout instead of the readable summary
 *   --skip-http --skip-core     omit a section
 *
 * Isolation: every size of every section runs in its own fresh Node.js process (and the C++ benchmark in its
 * own process per size), so V8 heap/JIT state left by one size cannot influence another.
 *
 * Every section verifies that the engines return identical results BEFORE its timings are accepted;
 * any mismatch aborts the run without writing a report. Progress goes to stderr.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { computeAnalytics, generateEvents, ValidationError, validateEvents } from "../src/analytics/index.js";
import { createApp } from "../src/app.js";
import { getNativeStatus } from "../src/native/loader.js";
import { nativeComputeAnalytics, nativeGenerateEvents } from "../src/native/nativeEngine.js";
import { baseEnvironment, cmakeCompilerInfo, compare, firstDifference, gitInfo, summarize, time, verify, type Comparison, type Summary } from "./common.js";

// ---- Arguments ------------------------------------------------------------------------------

type ChildMode = "inprocess" | "http" | "core";

interface Args {
  sizes: number[];
  httpSizes: number[];
  coreSizes: number[];
  warmup: number;
  runs: number;
  httpWarmup: number;
  httpRuns: number;
  coreWarmup: number;
  coreRuns: number;
  seed: number;
  bins: number;
  out: string | undefined;
  json: boolean;
  skipHttp: boolean;
  skipCore: boolean;
  /** Internal: run one section for one size in this (fresh) process and print its JSON. */
  child: ChildMode | undefined;
  size: number;
}

const API_LIMIT = 100_000;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    sizes: [10_000, 100_000],
    httpSizes: [10_000, 100_000],
    coreSizes: [10_000, 100_000, 1_000_000],
    warmup: 5,
    runs: 20,
    httpWarmup: 3,
    httpRuns: 10,
    coreWarmup: 3,
    coreRuns: 10,
    seed: 42,
    bins: 10,
    out: undefined,
    json: false,
    skipHttp: false,
    skipCore: false,
    child: undefined,
    size: 0,
  };
  const list = (v: string) => v.split(",").map(Number);
  for (const arg of argv) {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    switch (key) {
      case "sizes": a.sizes = list(value); break;
      case "http-sizes": a.httpSizes = list(value); break;
      case "core-sizes": a.coreSizes = list(value); break;
      case "warmup": a.warmup = Number(value); break;
      case "runs": a.runs = Number(value); break;
      case "http-warmup": a.httpWarmup = Number(value); break;
      case "http-runs": a.httpRuns = Number(value); break;
      case "core-warmup": a.coreWarmup = Number(value); break;
      case "core-runs": a.coreRuns = Number(value); break;
      case "seed": a.seed = Number(value); break;
      case "bins": a.bins = Number(value); break;
      case "out": a.out = value; break;
      case "json": a.json = true; break;
      case "skip-http": a.skipHttp = true; break;
      case "skip-core": a.skipCore = true; break;
      case "child": a.child = value as ChildMode; break;
      case "size": a.size = Number(value); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const sizesOk = (xs: number[], max: number) => xs.every((n) => Number.isInteger(n) && n > 0 && n <= max);
  const countOk = (n: number, min: number) => Number.isInteger(n) && n >= min;
  const ok =
    sizesOk(a.sizes, API_LIMIT) &&
    sizesOk(a.httpSizes, API_LIMIT) &&
    sizesOk(a.coreSizes, 5_000_000) &&
    [a.warmup, a.httpWarmup, a.coreWarmup].every((n) => countOk(n, 0)) &&
    [a.runs, a.httpRuns, a.coreRuns].every((n) => countOk(n, 3)) &&
    Number.isInteger(a.seed) && a.seed >= 0 && a.seed <= 4_294_967_295 &&
    Number.isInteger(a.bins) && a.bins >= 1 && a.bins <= 1024 &&
    (a.child === undefined || ["inprocess", "http", "core"].includes(a.child));
  if (!ok) {
    throw new Error(
      "Invalid arguments: in-process/http sizes must be 1..100000 (the API limit), core sizes 1..5000000, " +
        "runs >= 3, warmup >= 0, seed uint32, bins 1..1024",
    );
  }
  return a;
}

const log = (msg: string) => process.stderr.write(`${msg}\n`);

// ---- Environment ----------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function addonBuildInfo() {
  const buildDir = resolve(repoRoot, "cpp/build/addon");
  let cacheType = "";
  try {
    cacheType = /CMAKE_BUILD_TYPE:STRING=(.*)/.exec(readFileSync(resolve(buildDir, "CMakeCache.txt"), "utf8"))?.[1] ?? "";
  } catch {
    /* no cache */
  }
  return {
    ...cmakeCompilerInfo(buildDir),
    // cmake-js builds the Release configuration by default (npm run native:build). Multi-config
    // generators (Visual Studio) do not record the type in the cache, so this is not verifiable from the binary.
    config: cacheType || "Release (cmake-js default; not recorded by the generator)",
  };
}

// ---- Measurement helpers ----------------------------------------------------------------------

const gc = (globalThis as { gc?: () => void }).gc;
let sink = 0; // keeps results observably used so the work cannot be optimised away

/** One timed call, preceded by an (untimed) garbage collection when --expose-gc is available. */
function sample<T>(fn: () => T): number {
  gc?.();
  const { ms, value } = time(fn);
  sink += typeof value === "object" && value !== null ? 1 : 0;
  return ms;
}

async function asyncSample<T>(fn: () => Promise<T>): Promise<number> {
  gc?.();
  const start = performance.now();
  const value = await fn();
  const ms = performance.now() - start;
  sink += value === undefined ? 0 : 1;
  return ms;
}

function fail(message: string): never {
  throw new Error(`BENCHMARK ABORTED - ${message}`);
}

function expectIdentical(actual: unknown, expected: unknown, what: string): void {
  const diff = firstDifference(actual, expected);
  if (diff) fail(`${what}: ${diff}`);
}

const metric = (samples: number[]): Summary => summarize(samples);

// ---- Section 1: in-process engine calls (TypeScript vs the addon), one size per process --------

function nodeLevelOne(args: Args, size: number) {
  log(`[in-process] ${size} events: verifying`);
  const options = { histogramBins: args.bins };
  const events = generateEvents({ seed: args.seed, count: size }); // identical input for both engines

  const checks: string[] = [];
  expectIdentical(nativeGenerateEvents({ seed: args.seed, count: size }), events, "native generateEvents vs TypeScript");
  checks.push("native-generated events identical to TypeScript-generated events");
  const tsResult = computeAnalytics(events, options);
  verify(events, tsResult, args.bins);
  checks.push("TypeScript result agrees with the independent naive oracle");
  expectIdentical(nativeComputeAnalytics(events, options), tsResult, "native computeAnalytics vs TypeScript");
  checks.push("native result identical to TypeScript result (Object.is, key order)");
  try {
    nativeComputeAnalytics(events, { histogramBins: 0 });
    fail("input probe did not throw");
  } catch (err) {
    if (!(err instanceof ValidationError) || !err.message.startsWith("histogramBins must be")) {
      fail(`input probe threw the wrong error: ${String(err)}`);
    }
  }
  checks.push("input probe (histogramBins=0) fails only after events were converted and validated");

  log(`[in-process] ${size} events: timing (${args.warmup} warm-up + ${args.runs} runs, engine order alternates)`);
  const m = {
    tsGen: [] as number[],
    natGen: [] as number[],
    tsValidate: [] as number[],
    tsCompute: [] as number[],
    natCompute: [] as number[],
    natProbe: [] as number[],
  };
  const genOpts = { seed: args.seed, count: size };
  const probe = () => {
    try {
      nativeComputeAnalytics(events, { histogramBins: 0 });
    } catch {
      /* expected */
    }
  };
  for (let i = 0; i < args.warmup + args.runs; i++) {
    const timed = i >= args.warmup;
    const steps: Array<[number[], () => unknown]> = [
      [m.tsGen, () => generateEvents(genOpts)],
      [m.natGen, () => nativeGenerateEvents(genOpts)],
      [m.tsValidate, () => validateEvents(events)],
      [m.tsCompute, () => computeAnalytics(events, options)],
      [m.natCompute, () => nativeComputeAnalytics(events, options)],
      [m.natProbe, probe],
    ];
    // Alternate which engine of each pair goes first so neither always benefits from a warm cache.
    const ordered = i % 2 === 0 ? steps : [steps[1]!, steps[0]!, steps[2]!, steps[4]!, steps[3]!, steps[5]!];
    for (const [bucket, fn] of ordered) {
      const ms = sample(fn);
      if (timed) bucket.push(ms);
    }
  }

  return {
    events: size,
    verification: { passed: true, checks },
    typescript: { generate: metric(m.tsGen), validate: metric(m.tsValidate), compute: metric(m.tsCompute) },
    native: { generate: metric(m.natGen), inputProbe: metric(m.natProbe), compute: metric(m.natCompute) },
    comparisons: {
      compute: compare("typescript", m.tsCompute, "native", m.natCompute),
      generate: compare("typescript", m.tsGen, "native", m.natGen),
    },
  };
}

// ---- Section 2: end-to-end HTTP, one size per process -------------------------------------------

async function httpLevelOne(args: Args, size: number) {
  const server = createApp().listen(0);
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/analytics/compute`;
  try {
    log(`[http] ${size} events: verifying`);
    const events = generateEvents({ seed: args.seed, count: size });
    const bodyFor = (engine: string) => JSON.stringify({ events, histogramBins: args.bins, engine });
    const bodies = { typescript: bodyFor("typescript"), native: bodyFor("native") };
    const post = async (engine: "typescript" | "native") => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: bodies[engine] });
      return { status: res.status, engineHeader: res.headers.get("x-analytics-engine"), text: await res.text() };
    };

    const ts = await post("typescript");
    const native = await post("native");
    if (ts.status !== 200 || native.status !== 200) fail(`HTTP status ts=${ts.status} native=${native.status}`);
    if (ts.engineHeader !== "typescript" || native.engineHeader !== "native") fail("X-Analytics-Engine header mismatch");
    if (ts.text !== native.text) fail("HTTP response bodies differ between engines");
    expectIdentical(
      JSON.parse(native.text),
      JSON.parse(JSON.stringify(computeAnalytics(events, { histogramBins: args.bins }))),
      "HTTP body vs direct TypeScript result",
    );
    const checks = [
      "both engines returned HTTP 200 with the expected X-Analytics-Engine header",
      "response bodies byte-identical",
      "body equals the direct TypeScript result",
    ];

    log(`[http] ${size} events: timing (${args.httpWarmup} warm-up + ${args.httpRuns} runs)`);
    const tsMs: number[] = [];
    const natMs: number[] = [];
    for (let i = 0; i < args.httpWarmup + args.httpRuns; i++) {
      const timed = i >= args.httpWarmup;
      const order: Array<["typescript" | "native", number[]]> =
        i % 2 === 0 ? [["typescript", tsMs], ["native", natMs]] : [["native", natMs], ["typescript", tsMs]];
      for (const [engine, bucket] of order) {
        const ms = await asyncSample(() => post(engine));
        if (timed) bucket.push(ms);
      }
    }
    return {
      events: size,
      requestBytes: Buffer.byteLength(bodies.typescript),
      verification: { passed: true, checks },
      typescript: metric(tsMs),
      native: metric(natMs),
      comparison: compare("typescript", tsMs, "native", natMs),
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ---- Section 3: direct core (TypeScript engine vs hpa::core, no JS boundary) --------------------

const exePath = resolve(repoRoot, `cpp/build/bench/bin/hpa_bench${process.platform === "win32" ? ".exe" : ""}`);

interface CoreRun {
  events: number;
  generateMs: number[];
  validateMs: number[];
  computeMs: number[];
  result: unknown;
}

interface CoreReport {
  build: { compiler: string; compilerVersion: string; config: string; cppStandard: string };
  results: CoreRun[];
}

function runCoreExe(args: Args, size: number): CoreReport {
  if (!existsSync(exePath)) {
    fail("cpp/build/bench/bin/hpa_bench not found. Build it with `npm run bench:core:build` or pass --skip-core.");
  }
  log(`[core] hpa_bench: ${size} events (${args.coreWarmup} warm-up + ${args.coreRuns} runs, own process)`);
  const run = spawnSync(
    exePath,
    [`--sizes=${size}`, `--seed=${args.seed}`, `--bins=${args.bins}`, `--warmup=${args.coreWarmup}`, `--runs=${args.coreRuns}`],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (run.status !== 0) fail(`hpa_bench exited with ${run.status}: ${run.stderr}`);
  return JSON.parse(run.stdout) as CoreReport;
}

function coreLevelOne(args: Args, size: number, cpp: CoreRun) {
  log(`[core] ${size} events: verifying and timing the TypeScript engine`);
  const options = { histogramBins: args.bins };
  const events = generateEvents({ seed: args.seed, count: size });
  const tsResult = computeAnalytics(events, options);
  verify(events, tsResult, args.bins);
  expectIdentical(cpp.result, tsResult, `hpa::core result vs TypeScript for ${size} events`);
  const checks = [
    "TypeScript result agrees with the independent naive oracle",
    "hpa::core result (full, printed with 17 significant digits) identical to the TypeScript result",
  ];

  const tsGen: number[] = [];
  const tsValidate: number[] = [];
  const tsCompute: number[] = [];
  const genOpts = { seed: args.seed, count: size };
  for (let i = 0; i < args.coreWarmup + args.coreRuns; i++) {
    const timed = i >= args.coreWarmup;
    const g = sample(() => generateEvents(genOpts));
    const v = sample(() => validateEvents(events));
    const c = sample(() => computeAnalytics(events, options));
    if (timed) {
      tsGen.push(g);
      tsValidate.push(v);
      tsCompute.push(c);
    }
  }
  return {
    events: size,
    verification: { passed: true, checks },
    typescript: { generate: metric(tsGen), validate: metric(tsValidate), compute: metric(tsCompute) },
    cpp: { generate: metric(cpp.generateMs), validate: metric(cpp.validateMs), compute: metric(cpp.computeMs) },
    // Median(compute) - median(validate): the grouping/sort/histogram part. A difference of medians
    // from separate calls, so an estimate; it shows where the engines differ.
    derivedEstimatesMs: {
      typescriptComputeExcludingValidation: metric(tsCompute).medianMs - metric(tsValidate).medianMs,
      cppComputeExcludingValidation: metric(cpp.computeMs).medianMs - metric(cpp.validateMs).medianMs,
    },
    comparisons: {
      compute: compare("typescript", tsCompute, "cpp-core", cpp.computeMs),
      validate: compare("typescript", tsValidate, "cpp-core", cpp.validateMs),
      generate: compare("typescript", tsGen, "cpp-core", cpp.generateMs),
    },
  };
}

// ---- Report -------------------------------------------------------------------------------------

const DEFINITIONS = {
  protocol:
    "Each size of each section runs in a fresh process (V8 heap/JIT state from one size otherwise changes another's " +
    "allocation-heavy timings by an order of magnitude). Inside a process: warm-up iterations first, then timed runs; the " +
    "order of the two engines alternates every iteration; a garbage collection (untimed) precedes every sample, so samples " +
    "start from a clean heap and exclude GC pauses of earlier work. Timer: performance.now() / std::chrono::steady_clock.",
  inProcess: {
    scope: "Direct JavaScript calls of the engines on one pre-generated array of JS event objects. No HTTP, no JSON.",
    "typescript.generate": "generateEvents(): seeded generation, building the JS objects.",
    "typescript.validate": "validateEvents() alone; it is a subset of typescript.compute.",
    "typescript.compute": "computeAnalytics(): input validation + grouping + sums + histogram + sort/percentiles.",
    "native.generate": "addon generateEvents(): C++ generation plus construction of the JS event objects.",
    "native.compute":
      "addon computeAnalytics(): JS->C++ conversion of every event, core validation, core computation, C++->JS result construction.",
    "native.inputProbe":
      "The same addon call with histogramBins=0: JS->C++ conversion and core event validation, then an exception " +
      "before any computation (includes creating and catching that exception). Used only to split native.compute.",
    derivedEstimatesMs:
      "Differences of medians, so indicative only: computePlusResultMarshalling = native.compute - inputProbe; " +
      "inputConversion = inputProbe - direct core validate; boundaryOverheadVsDirectCore = native.compute - direct core compute. " +
      "The direct-core figures come from a separate process (hpa_bench).",
  },
  http: {
    scope:
      "POST /api/analytics/compute against the real Express app on loopback, client in the same process. Measured from " +
      "fetch() start until the response body is fully read. The request body (JSON string) is built before timing. " +
      "Includes server-side JSON.parse of the request, the engine call and JSON serialisation of the response; those costs are the same for both engines.",
  },
  core: {
    scope:
      "Direct comparison of the TypeScript engine (in-process, JS arrays) and hpa::core (C++ executable, std::vector<Event>). " +
      "No JS<->C++ boundary and no HTTP. Data is generated by each language's own generator (proven identical by the parity tests and re-verified here via identical results).",
    "cpp.generate": "hpa::generate_events (builds std::vector<Event>).",
    "cpp.validate": "hpa::validate_events.",
    "cpp.compute": "hpa::compute_analytics, which includes validation exactly like the TypeScript computeAnalytics.",
    derivedEstimatesMs: "computeExcludingValidation = median(compute) - median(validate) for the same engine; an estimate (separate calls).",
    generateCaveat:
      "Generation timings of the TypeScript engine depend on V8 heap/JIT history: 10,000 events took 3.7 ms in a fresh process " +
      "but 0.28 ms after a 100,000-event run in the same process, and the 100,000-event case is bimodal. Treat generate comparisons as indicative only.",
  },
  statistics:
    "Medians with p25/p75 (interquartile range), MAD, standard deviation and CV over the timed runs; raw samples included. " +
    "'faster/slower' is reported only if the 95% bootstrap interval (2000 seeded resamples) of median(baseline)/median(candidate) excludes 1 and the effect is >= 5%; otherwise 'inconclusive'.",
};

function ms(x: number): string {
  return x >= 100 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toFixed(3);
}

function row(label: string, s: Summary): string {
  return `  ${label.padEnd(28)} median ${ms(s.medianMs).padStart(9)}  IQR ${ms(s.p25Ms)}-${ms(s.p75Ms)}  min ${ms(s.minMs)}  max ${ms(s.maxMs)}  CV ${(s.cv * 100).toFixed(1)}%`;
}

function verdictLine(c: Comparison): string {
  const [lo, hi] = c.ratioCi95;
  const verdict = c.verdict.replace("candidate", c.candidate).toUpperCase();
  return `  => ${verdict}: ${c.baseline}/${c.candidate} median ratio ${c.medianRatio.toFixed(2)} (95% CI ${lo.toFixed(2)}-${hi.toFixed(2)}); ${c.note}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function printSummary(report: Record<string, any>): void {
  const p = (s: string) => console.log(s);
  const env = report["environment"];
  p("TypeScript vs native C++ benchmark");
  p(`commit ${report["git"].commit}${report["git"].dirty ? " (+uncommitted changes)" : ""}, ${report["generatedAt"]}`);
  p(`Node ${env.node} (V8 ${env.v8}), ${env.platform} ${env.arch}; ${env.cpu} x${env.logicalCpus}; ${env.totalMemoryGiB} GiB RAM`);
  p(`addon: ${env.nativeAddon.compiler} ${env.nativeAddon.compilerVersion}, ${env.nativeAddon.config}, core ${env.nativeAddon.coreVersion}, Node-API ${env.nativeAddon.napiVersion}`);
  if (env.coreExecutable) p(`hpa_bench: ${env.coreExecutable.compiler} ${env.coreExecutable.compilerVersion}, ${env.coreExecutable.config}`);
  p(`seed ${report["config"].seed}, bins ${report["config"].bins}; each size in a fresh process; forced GC before each sample: ${env.gcExposed}`);
  p("All engine results verified identical before timing. Times in milliseconds.\n");

  p("== 1. In-process engine calls (pre-generated JS events; includes JS<->C++ marshalling for native) ==");
  for (const r of report["results"].inProcess) {
    p(`\n${r.events} events (${report["config"].warmup} warm-up, ${report["config"].runs} runs)`);
    p(row("compute  TypeScript", r.typescript.compute));
    p(row("compute  native (total)", r.native.compute));
    p(verdictLine(r.comparisons.compute));
    p(row("  native input probe", r.native.inputProbe));
    const d = r.derivedEstimatesMs;
    p(`  derived (estimates): compute+result marshalling ${ms(d.nativeComputePlusResultMarshalling)}` +
      `, input conversion ${d.nativeInputConversion === null ? "n/a" : ms(d.nativeInputConversion)}` +
      `, boundary overhead vs direct core ${d.nativeBoundaryOverheadVsDirectCore === null ? "n/a" : ms(d.nativeBoundaryOverheadVsDirectCore)}`);
    p(row("  TypeScript validate only", r.typescript.validate));
    p(row("generate TypeScript", r.typescript.generate));
    p(row("generate native", r.native.generate));
    p(verdictLine(r.comparisons.generate));
  }

  if (report["results"].http) {
    p("\n== 2. End-to-end HTTP (loopback; includes request JSON parse and response serialisation) ==");
    for (const r of report["results"].http) {
      p(`\n${r.events} events, request ${(r.requestBytes / 1e6).toFixed(1)} MB (${report["config"].httpWarmup} warm-up, ${report["config"].httpRuns} runs)`);
      p(row("POST engine=typescript", r.typescript));
      p(row("POST engine=native", r.native));
      p(verdictLine(r.comparison));
    }
  }

  if (report["results"].core) {
    p("\n== 3. Direct core: TypeScript engine vs hpa::core (no JS<->C++ boundary, no HTTP) ==");
    for (const r of report["results"].core) {
      p(`\n${r.events} events (${report["config"].coreWarmup} warm-up, ${report["config"].coreRuns} runs)`);
      p(row("compute  TypeScript", r.typescript.compute));
      p(row("compute  C++ core", r.cpp.compute));
      p(verdictLine(r.comparisons.compute));
      p(row("validate TypeScript", r.typescript.validate));
      p(row("validate C++ core", r.cpp.validate));
      p(`  derived (estimates): compute excluding validation  TypeScript ${ms(r.derivedEstimatesMs.typescriptComputeExcludingValidation)}  C++ core ${ms(r.derivedEstimatesMs.cppComputeExcludingValidation)}`);
      p(row("generate TypeScript", r.typescript.generate));
      p(row("generate C++ core", r.cpp.generate));
      p(verdictLine(r.comparisons.generate));
    }
  }
  p("\nLimitations: single machine, single run of this script, no CPU-frequency or background-load control; read the CVs.");
  p("TypeScript generate timings depend on V8 heap/JIT history (see definitions.core.generateCaveat); treat them as indicative.");
}

/** Runs this script again in a fresh Node.js process for one section and size; returns its JSON. */
function runChild<T>(mode: ChildMode, size: number, env: Record<string, string> = {}): T {
  const forwarded = process.argv.slice(2).filter((a) => !/^--(child|size|out|json)(=|$)/.test(a));
  const run = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), ...forwarded, `--child=${mode}`, `--size=${size}`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] },
  );
  if (run.status !== 0) fail(`${mode} child for ${size} events exited with ${run.status}`);
  return JSON.parse(run.stdout) as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const status = getNativeStatus();
  if (!status.available) fail(`native addon unavailable (${status.reason}). Build it with \`npm run native:build\`.`);

  // ---- child mode: one section, one size, fresh process ----
  if (args.child === "inprocess") return void process.stdout.write(JSON.stringify(nodeLevelOne(args, args.size)));
  if (args.child === "http") return void process.stdout.write(JSON.stringify(await httpLevelOne(args, args.size)));
  if (args.child === "core") {
    const cpp = JSON.parse(process.env["HPA_BENCH_CPP_RUN"] ?? "null") as CoreRun | null;
    if (!cpp) fail("core child needs HPA_BENCH_CPP_RUN");
    return void process.stdout.write(JSON.stringify(coreLevelOne(args, args.size, cpp)));
  }

  // ---- parent: orchestrate, one fresh process per size ----
  let coreBuild: CoreReport["build"] | undefined;
  const cppRuns = new Map<number, CoreRun>();
  if (!args.skipCore) {
    for (const size of new Set([...args.coreSizes, ...args.sizes])) {
      const report = runCoreExe(args, size);
      coreBuild = report.build;
      cppRuns.set(size, report.results[0]!);
    }
  }

  const inProcess = args.sizes.map((size) => {
    const entry = runChild<ReturnType<typeof nodeLevelOne>>("inprocess", size);
    const cpp = cppRuns.get(size);
    const coreValidate = cpp ? metric(cpp.validateMs).medianMs : undefined;
    const coreCompute = cpp ? metric(cpp.computeMs).medianMs : undefined;
    return {
      ...entry,
      // Differences of medians; the direct-core numbers come from a separate process (hpa_bench). Estimates only.
      derivedEstimatesMs: {
        nativeComputePlusResultMarshalling: entry.native.compute.medianMs - entry.native.inputProbe.medianMs,
        nativeInputConversion: coreValidate === undefined ? null : entry.native.inputProbe.medianMs - coreValidate,
        nativeBoundaryOverheadVsDirectCore: coreCompute === undefined ? null : entry.native.compute.medianMs - coreCompute,
      },
    };
  });
  const http = args.skipHttp ? undefined : args.httpSizes.map((size) => runChild<Awaited<ReturnType<typeof httpLevelOne>>>("http", size));
  const core = args.skipCore
    ? undefined
    : args.coreSizes.map((size) =>
        runChild<ReturnType<typeof coreLevelOne>>("core", size, { HPA_BENCH_CPP_RUN: JSON.stringify(cppRuns.get(size)) }),
      );

  const addon = addonBuildInfo();
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    git: gitInfo(),
    environment: {
      ...baseEnvironment(),
      gcExposed: gc !== undefined,
      nativeAddon: { compiler: addon.compiler, compilerVersion: addon.version, config: addon.config, coreVersion: status.coreVersion, napiVersion: status.napiVersion },
      coreExecutable: coreBuild ? { compiler: coreBuild.compiler, compilerVersion: coreBuild.compilerVersion, config: coreBuild.config } : null,
      notes: "CPU frequency scaling, power plan and background load are not controlled or recorded.",
    },
    config: {
      seed: args.seed, bins: args.bins, warmup: args.warmup, runs: args.runs,
      httpWarmup: args.httpWarmup, httpRuns: args.httpRuns, coreWarmup: args.coreWarmup, coreRuns: args.coreRuns,
      sizes: args.sizes, httpSizes: args.skipHttp ? [] : args.httpSizes, coreSizes: args.skipCore ? [] : args.coreSizes,
      isolation: "each size of each section is measured in a fresh process",
    },
    definitions: DEFINITIONS,
    results: { inProcess, http: http ?? null, core: core ?? null },
  };

  const outPath = resolve(args.out ?? resolve(repoRoot, `bench-results/compare-${report.generatedAt.replace(/[:.]/g, "-")}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
  log(`JSON report written to ${outPath}`);
  if (sink < 0) log("unreachable"); // keeps `sink` observably used
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
