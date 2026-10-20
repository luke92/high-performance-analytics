/**
 * EXPERIMENT (Stage 3.2): can the JS<->C++ input conversion be made cheaper? Not part of any request path.
 *
 *   npm run native:build                 # production addon (baseline)
 *   npm run native:experimental:build    # experimental addon with the alternatives
 *   npm run bench:marshalling -- [--sizes=10000,100000] [--warmup=5] [--runs=20] [--seed=42] [--bins=10] [--out=file] [--json]
 *
 * Variants (all compute the same analytics through the same unchanged hpa::core):
 *   typescript            the TypeScript engine (reference and speed to beat)
 *   production            the production addon: array of objects, ~23 Node-API calls per event
 *   objects               experimental: same object input, one HandleScope per event and one call per field
 *   columnar (prepacked)  experimental: typed-array columns that already exist (best case for the layout)
 *   columnar (from objects) experimental: pack the objects into columns in JS *inside the timed region*, then call
 *   pack                  the JS packing step alone
 * For every native variant a probe call (histogramBins = 0) stops after conversion + validation, which splits
 * its time into "convert + validate" and "compute + build result".
 *
 * Methodology as in compare.ts: each size in a fresh process, warm-up then timed runs, rotating order,
 * untimed GC before every sample, identical results required BEFORE timings count (any mismatch aborts).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeAnalytics, generateEvents, ValidationError, type AnalyticsEvent } from "../src/analytics/index.js";
import { getNativeStatus } from "../src/native/loader.js";
import { nativeComputeAnalytics } from "../src/native/nativeEngine.js";
import { baseEnvironment, cmakeCompilerInfo, compare, firstDifference, gitInfo, summarize, time, verify, type Comparison, type Summary } from "./common.js";
import {
  columnsBytes,
  eventStructBytes,
  experimentalComputeColumnar,
  experimentalComputeObjects,
  loadExperimental,
  packColumns,
  unpackColumns,
  type Columns,
} from "./experimental/columnar.js";

interface Args {
  sizes: number[];
  warmup: number;
  runs: number;
  seed: number;
  bins: number;
  out: string | undefined;
  json: boolean;
  child: boolean;
  size: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { sizes: [10_000, 100_000], warmup: 5, runs: 20, seed: 42, bins: 10, out: undefined, json: false, child: false, size: 0 };
  for (const arg of argv) {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    switch (key) {
      case "sizes": a.sizes = value.split(",").map(Number); break;
      case "warmup": a.warmup = Number(value); break;
      case "runs": a.runs = Number(value); break;
      case "seed": a.seed = Number(value); break;
      case "bins": a.bins = Number(value); break;
      case "out": a.out = value; break;
      case "json": a.json = true; break;
      case "child": a.child = true; break;
      case "size": a.size = Number(value); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const ok =
    a.sizes.every((n) => Number.isInteger(n) && n > 0 && n <= 2_000_000) &&
    Number.isInteger(a.warmup) && a.warmup >= 0 &&
    Number.isInteger(a.runs) && a.runs >= 3 &&
    Number.isInteger(a.seed) && a.seed >= 0 && a.seed <= 4_294_967_295 &&
    Number.isInteger(a.bins) && a.bins >= 1 && a.bins <= 1024;
  if (!ok) throw new Error("Invalid arguments: sizes 1..2000000 (in-process; the HTTP API accepts at most 100000), runs >= 3, warmup >= 0, seed uint32, bins 1..1024");
  return a;
}

const log = (msg: string) => process.stderr.write(`${msg}\n`);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const gc = (globalThis as { gc?: () => void }).gc;
let sink = 0;

function sample<T>(fn: () => T): number {
  gc?.();
  const { ms, value } = time(fn);
  sink += typeof value === "object" && value !== null ? 1 : 0;
  return ms;
}

function fail(message: string): never {
  throw new Error(`BENCHMARK ABORTED - ${message}`);
}

function expectIdentical(actual: unknown, expected: unknown, what: string): void {
  const diff = firstDifference(actual, expected);
  if (diff) fail(`${what}: ${diff}`);
}

function expectProbeError(run: () => unknown, what: string): void {
  try {
    run();
  } catch (err) {
    if (err instanceof ValidationError && err.message.startsWith("histogramBins must be")) return;
    fail(`${what}: probe threw the wrong error: ${String(err)}`);
  }
  fail(`${what}: probe did not throw`);
}

function runOne(args: Args, size: number) {
  const options = { histogramBins: args.bins };
  const heapUsed = () => process.memoryUsage().heapUsed;
  const arrayBuffers = () => process.memoryUsage().arrayBuffers;

  // ---- memory of the two input representations (measured before anything else is allocated) ----
  gc?.();
  const heap0 = heapUsed();
  const events: AnalyticsEvent[] = generateEvents({ seed: args.seed, count: size });
  gc?.();
  const objectsHeapBytes = heapUsed() - heap0;
  gc?.();
  const buffers0 = arrayBuffers();
  const columns: Columns = packColumns(events);
  gc?.();
  const columnsMeasuredBytes = arrayBuffers() - buffers0;

  // ---- request-shaped inputs: what an API would receive and have to parse ----
  const objectsJson = JSON.stringify(events); // today's wire format: an array of event objects
  const wireJson = JSON.stringify({
    // hypothetical columnar wire format: plain number arrays, turned into typed arrays after parsing
    ids: Array.from(columns.ids),
    timestamps: Array.from(columns.timestamps),
    values: Array.from(columns.values),
    eventTypeCodes: Array.from(columns.eventTypeCodes),
    categoryCodes: Array.from(columns.categoryCodes),
    eventTypes: columns.eventTypes,
    categories: columns.categories,
  });
  const columnsFromWire = (text: string): Columns => {
    const w = JSON.parse(text) as Record<string, number[] & string[]>;
    return {
      ids: new Float64Array(w["ids"]!),
      timestamps: new Float64Array(w["timestamps"]!),
      values: new Float64Array(w["values"]!),
      eventTypeCodes: new Uint16Array(w["eventTypeCodes"]!),
      categoryCodes: new Uint16Array(w["categoryCodes"]!),
      eventTypes: w["eventTypes"]!,
      categories: w["categories"]!,
    };
  };
  const requestTs = () => JSON.stringify(computeAnalytics(JSON.parse(objectsJson) as AnalyticsEvent[], options));
  const requestProduction = () => JSON.stringify(nativeComputeAnalytics(JSON.parse(objectsJson), options));
  const requestColumnarFromObjects = () =>
    JSON.stringify(experimentalComputeColumnar(packColumns(JSON.parse(objectsJson) as AnalyticsEvent[]), options));
  const requestColumnarWire = () => JSON.stringify(experimentalComputeColumnar(columnsFromWire(wireJson), options));
  // The TypeScript engine on the SAME columnar body: it must materialise event objects first.
  const requestTsColumnarWire = () => JSON.stringify(computeAnalytics(unpackColumns(columnsFromWire(wireJson)), options));

  // ---- verification before any timing ----
  log(`[marshalling] ${size} events: verifying`);
  const checks: string[] = [];
  const tsResult = computeAnalytics(events, options);
  verify(events, tsResult, args.bins);
  checks.push("TypeScript result agrees with the independent naive oracle");
  expectIdentical(nativeComputeAnalytics(events, options), tsResult, "production addon");
  expectIdentical(experimentalComputeObjects(events, options), tsResult, "experimental objects");
  expectIdentical(experimentalComputeColumnar(columns, options), tsResult, "experimental columnar (prepacked)");
  expectIdentical(experimentalComputeColumnar(packColumns(events), options), tsResult, "experimental columnar (from objects)");
  checks.push("all four native variants return results identical to TypeScript (Object.is, key order)");
  expectProbeError(() => nativeComputeAnalytics(events, { histogramBins: 0 }), "production");
  expectProbeError(() => experimentalComputeObjects(events, { histogramBins: 0 }), "objects");
  expectProbeError(() => experimentalComputeColumnar(columns, { histogramBins: 0 }), "columnar");
  checks.push("probes fail only after conversion and validation (histogramBins error)");
  const referenceResponse = requestTs();
  for (const [name, run] of [["production", requestProduction], ["columnar from objects", requestColumnarFromObjects], ["columnar wire format", requestColumnarWire], ["TypeScript on columnar wire format", requestTsColumnarWire]] as const) {
    if (run() !== referenceResponse) fail(`request-shaped pipeline '${name}' produced a different response than TypeScript`);
  }
  checks.push("request-shaped pipelines (parse -> engine -> stringify) produce byte-identical responses");

  // ---- timing ----
  log(`[marshalling] ${size} events: timing (${args.warmup} warm-up + ${args.runs} runs, rotating order)`);
  const m = {
    typescript: [] as number[],
    production: [] as number[],
    objects: [] as number[],
    columnarPrepacked: [] as number[],
    columnarFromObjects: [] as number[],
    pack: [] as number[],
    productionProbe: [] as number[],
    objectsProbe: [] as number[],
    columnarProbe: [] as number[],
    requestTypeScript: [] as number[],
    requestProduction: [] as number[],
    requestColumnarFromObjects: [] as number[],
    requestColumnarWire: [] as number[],
    requestTsColumnarWire: [] as number[],
    parseObjects: [] as number[],
    parseColumnarWire: [] as number[],
  };
  const bad = { histogramBins: 0 };
  const swallow = (fn: () => unknown) => () => {
    try {
      fn();
    } catch {
      /* expected probe failure */
    }
  };
  const steps: Array<[keyof typeof m, () => unknown]> = [
    ["typescript", () => computeAnalytics(events, options)],
    ["production", () => nativeComputeAnalytics(events, options)],
    ["objects", () => experimentalComputeObjects(events, options)],
    ["columnarPrepacked", () => experimentalComputeColumnar(columns, options)],
    ["columnarFromObjects", () => experimentalComputeColumnar(packColumns(events), options)],
    ["pack", () => packColumns(events)],
    ["productionProbe", swallow(() => nativeComputeAnalytics(events, bad))],
    ["objectsProbe", swallow(() => experimentalComputeObjects(events, bad))],
    ["columnarProbe", swallow(() => experimentalComputeColumnar(columns, bad))],
    ["requestTypeScript", requestTs],
    ["requestProduction", requestProduction],
    ["requestColumnarFromObjects", requestColumnarFromObjects],
    ["requestColumnarWire", requestColumnarWire],
    ["requestTsColumnarWire", requestTsColumnarWire],
    ["parseObjects", () => JSON.parse(objectsJson)],
    ["parseColumnarWire", () => columnsFromWire(wireJson)],
  ];
  for (let i = 0; i < args.warmup + args.runs; i++) {
    const timed = i >= args.warmup;
    for (let k = 0; k < steps.length; k++) {
      const [key, fn] = steps[(i + k) % steps.length]!;
      const ms = sample(fn);
      if (timed) m[key].push(ms);
    }
  }

  const s = (key: keyof typeof m): Summary => summarize(m[key]);
  const med = (key: keyof typeof m) => s(key).medianMs;
  const vs = (baseName: string, base: keyof typeof m, name: string, cand: keyof typeof m): Comparison =>
    compare(baseName, m[base], name, m[cand]);
  const split = (total: keyof typeof m, probe: keyof typeof m) => ({
    convertAndValidateMs: med(probe),
    computeAndBuildResultMs: med(total) - med(probe),
  });

  return {
    events: size,
    verification: { passed: true, checks },
    memory: {
      objectsHeapBytes,
      columnsBytes: columnsBytes(columns),
      columnsMeasuredArrayBufferBytes: columnsMeasuredBytes,
      bytesPerEventObjects: objectsHeapBytes / size,
      bytesPerEventColumns: columnsBytes(columns) / size,
      nativeEventVectorBytes: size * eventStructBytes(),
      note:
        "objectsHeapBytes: live V8 heap of the event objects (measured). columnsBytes: the typed arrays (exact). " +
        "nativeEventVectorBytes: transient std::vector<hpa::Event> built by EVERY native variant while the core runs " +
        "(size * sizeof(hpa::Event)); the core API takes that vector, so no variant avoids it.",
    },
    metrics: Object.fromEntries((Object.keys(m) as Array<keyof typeof m>).map((k) => [k, s(k)])),
    splits: {
      production: split("production", "productionProbe"),
      objects: split("objects", "objectsProbe"),
      columnarPrepacked: split("columnarPrepacked", "columnarProbe"),
      columnarFromObjects: {
        packMs: med("pack"),
        ...split("columnarPrepacked", "columnarProbe"),
      },
    },
    requestShaped: {
      note:
        "JSON.parse(request body) -> engine -> JSON.stringify(result), no HTTP server. 'Columnar wire' is a hypothetical " +
        "request format of plain number arrays turned into typed arrays after parsing; today's API accepts only event objects.",
      objectsBodyBytes: Buffer.byteLength(objectsJson),
      columnarWireBodyBytes: Buffer.byteLength(wireJson),
      comparisonsVsTypeScript: {
        production: vs("typescript", "requestTypeScript", "production", "requestProduction"),
        columnarFromObjects: vs("typescript", "requestTypeScript", "columnar-from-objects", "requestColumnarFromObjects"),
        columnarWire: vs("typescript", "requestTypeScript", "columnar-wire", "requestColumnarWire"),
      },
      // Same columnar request body for both engines: isolates native vs TypeScript from the cheaper wire format.
      comparisonSameColumnarWire: vs("typescript-on-columnar-wire", "requestTsColumnarWire", "native-on-columnar-wire", "requestColumnarWire"),
    },
    comparisons: {
      vsTypeScript: {
        production: vs("typescript", "typescript", "production", "production"),
        objects: vs("typescript", "typescript", "objects", "objects"),
        columnarPrepacked: vs("typescript", "typescript", "columnar-prepacked", "columnarPrepacked"),
        columnarFromObjects: vs("typescript", "typescript", "columnar-from-objects", "columnarFromObjects"),
      },
      vsProduction: {
        objects: vs("production", "production", "objects", "objects"),
        columnarPrepacked: vs("production", "production", "columnar-prepacked", "columnarPrepacked"),
        columnarFromObjects: vs("production", "production", "columnar-from-objects", "columnarFromObjects"),
      },
    },
  };
}

type SizeResult = ReturnType<typeof runOne>;

function ms(x: number): string {
  return x >= 100 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toFixed(3);
}
function row(label: string, s: Summary): string {
  return `  ${label.padEnd(26)} median ${ms(s.medianMs).padStart(8)}  IQR ${ms(s.p25Ms)}-${ms(s.p75Ms)}  min ${ms(s.minMs)}  max ${ms(s.maxMs)}  CV ${(s.cv * 100).toFixed(1)}%`;
}
function verdict(c: Comparison): string {
  const [lo, hi] = c.ratioCi95;
  const v = c.verdict.replace("candidate", c.candidate).toUpperCase();
  return `${v} (${c.baseline}/${c.candidate} ${c.medianRatio.toFixed(2)}, 95% CI ${lo.toFixed(2)}-${hi.toFixed(2)})`;
}
const mib = (b: number) => `${(b / 1048576).toFixed(2)} MiB`;

function printSummary(report: { environment: Record<string, any>; config: Args & { warmup: number }; results: SizeResult[]; git: { commit: string; dirty: boolean }; generatedAt: string }): void {
  const p = (s: string) => console.log(s);
  const env = report.environment;
  p("Marshalling experiment: reducing the JS->C++ input cost (Stage 3.2)");
  p(`commit ${report.git.commit}${report.git.dirty ? " (+uncommitted changes)" : ""}, ${report.generatedAt}`);
  p(`Node ${env["node"]} (V8 ${env["v8"]}), ${env["platform"]} ${env["arch"]}; ${env["cpu"]} x${env["logicalCpus"]}; ${env["totalMemoryGiB"]} GiB RAM`);
  p(`addons: ${env["compiler"]}, ${env["config"]}; seed ${report.config.seed}, bins ${report.config.bins}; each size in a fresh process`);
  p("All variants verified identical to the TypeScript result before timing. Times in ms.\n");
  for (const r of report.results) {
    const note = r.events > 100_000 ? "  [in-process only: above the API's 100,000-event limit]" : "";
    p(`== ${r.events} events (${report.config.warmup} warm-up, ${report.config.runs} runs)${note}`);
    const mt = r.metrics as unknown as Record<string, Summary>;
    p(row("TypeScript", mt["typescript"]!));
    p(row("native: production", mt["production"]!));
    p(row("native: objects (new)", mt["objects"]!));
    p(row("native: columnar prepacked", mt["columnarPrepacked"]!));
    p(row("native: columnar from objs", mt["columnarFromObjects"]!));
    p(row("  JS pack step alone", mt["pack"]!));
    p("  convert+validate vs compute+result (medians):");
    for (const [name, sp] of Object.entries(r.splits)) {
      const x = sp as { convertAndValidateMs: number; computeAndBuildResultMs: number; packMs?: number };
      p(`    ${name.padEnd(20)} convert+validate ${ms(x.convertAndValidateMs).padStart(8)}   compute+result ${ms(x.computeAndBuildResultMs).padStart(8)}${x.packMs === undefined ? "" : `   (+ JS pack ${ms(x.packMs)})`}`);
    }
    p("  vs TypeScript:");
    for (const [name, c] of Object.entries(r.comparisons.vsTypeScript)) p(`    ${name.padEnd(20)} ${verdict(c)}`);
    p("  vs production native:");
    for (const [name, c] of Object.entries(r.comparisons.vsProduction)) p(`    ${name.padEnd(20)} ${verdict(c)}`);
    p("  request-shaped (JSON.parse -> engine -> JSON.stringify; no HTTP server):");
    p(row("  TypeScript", mt["requestTypeScript"]!));
    p(row("  native: production", mt["requestProduction"]!));
    p(row("  native: columnar from objs", mt["requestColumnarFromObjects"]!));
    p(row("  native: columnar wire", mt["requestColumnarWire"]!));
    p(row("  TypeScript: columnar wire", mt["requestTsColumnarWire"]!));
    p(row("  (parse objects only)", mt["parseObjects"]!));
    p(row("  (parse columnar wire only)", mt["parseColumnarWire"]!));
    p(`    bodies: objects ${mib(r.requestShaped.objectsBodyBytes)}, columnar wire ${mib(r.requestShaped.columnarWireBodyBytes)}`);
    for (const [name, c] of Object.entries(r.requestShaped.comparisonsVsTypeScript)) p(`    ${name.padEnd(20)} ${verdict(c)}`);
    p(`    same columnar body, native vs TypeScript: ${verdict(r.requestShaped.comparisonSameColumnarWire)}`);
    const mem = r.memory;
    p(`  memory: JS objects ${mib(mem.objectsHeapBytes)} (${mem.bytesPerEventObjects.toFixed(0)} B/event)  vs columns ${mib(mem.columnsBytes)} (${mem.bytesPerEventColumns.toFixed(0)} B/event);` +
      ` native transient vector<Event> ${mib(mem.nativeEventVectorBytes)} in every native variant\n`);
  }
  p("Limitations: one machine, one invocation, no CPU-frequency or background-load control; read the CVs.");
}

function runChild(size: number): SizeResult {
  const forwarded = process.argv.slice(2).filter((a) => !/^--(child|size|out|json)(=|$)/.test(a));
  const run = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), ...forwarded, "--child", `--size=${size}`], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (run.status !== 0) fail(`child for ${size} events exited with ${run.status}`);
  return JSON.parse(run.stdout) as SizeResult;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const status = getNativeStatus();
  if (!status.available) fail(`production addon unavailable (${status.reason}); run \`npm run native:build\``);
  if (!loadExperimental()) fail("experimental addon not built; run `npm run native:experimental:build`");

  if (args.child) {
    process.stdout.write(JSON.stringify(runOne(args, args.size)));
    return;
  }

  const results = args.sizes.map(runChild);
  const compiler = cmakeCompilerInfo(resolve(repoRoot, "cpp/build/addon-experimental"));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    git: gitInfo(),
    environment: {
      ...baseEnvironment(),
      compiler: `${compiler.compiler} ${compiler.version}`,
      config: "Release (cmake-js default; not recorded by the generator)",
      gcExposed: gc !== undefined,
    },
    config: { ...args, child: undefined, size: undefined, isolation: "each size in a fresh process" },
    results,
  };
  const outPath = resolve(args.out ?? resolve(repoRoot, `bench-results/marshalling-${report.generatedAt.replace(/[:.]/g, "-")}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report as never);
  log(`JSON report written to ${outPath}`);
  if (sink < 0) log("unreachable");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
