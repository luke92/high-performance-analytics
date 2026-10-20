# high-performance-analytics

A full-stack analytics platform powered by React, Node.js, native C++ and WebAssembly.

A portfolio project demonstrating practical C++ integration in a web product. It will process synthetic event data and compare three implementations of the same computationally intensive analytics:

1. **TypeScript** baseline (Node.js API).
2. **Native C++ engine** called from Node.js through Node-API (`node-addon-api`).
3. **WebAssembly** build of the same portable C++ core, executed in the browser.

> **Status: Stage 4 complete.** A deterministic TypeScript engine (the behavioral reference), a standalone C++20 core with bit-exact parity tests, a Node-API addon that exposes the core to the Express API (`engine: "native"`), and a WebAssembly build of the same core that runs in a Web Worker (see [WebAssembly](#webassembly-stage-4)) exist. **A fair TypeScript-vs-native benchmark exists (see [Benchmark: TypeScript vs native](#benchmark-typescript-vs-native-c)); on the one machine measured, the native engine called through Node-API is currently *slower* than TypeScript, even though the C++ core alone is faster.** No WebAssembly benchmark exists, so no WebAssembly performance claim is made. GitHub Actions passes for the C++ core and the Node-API addon on Windows and Ubuntu (Node 22 and 24) and for the WebAssembly build on Ubuntu (Emscripten 6.0.13). There is no dashboard UI yet.

## Architecture

```
apps/
  api/   Express + TypeScript. HTTP concerns, validation, orchestration of engines.
         src/analytics/  framework-independent TypeScript reference engine (no Express imports)
         bench/          benchmark script
  web/   React + Vite + TypeScript. UI and visualization only.
         src/native/     lazy addon loader + thin wrapper (no fallback to TypeScript)
cpp/     core/  portable C++20 library (no Node/V8/browser/Emscripten dependencies)
         addon/ Node-API binding (node-addon-api) over hpa::core, built with cmake-js
         tests/ GoogleTest suite + parity fixture generated from the TypeScript engine
         wasm/  Emscripten binding of the same core (C ABI; no analytics logic) -> hpa_core.wasm
apps/web/src/wasm/  WebAssembly wrapper, Web Worker, message protocol and client (no UI)
```

Principles:

- The C++ **core** is independent of Node.js, browser APIs and Emscripten. The addon and WASM targets are thin bindings over the same code.
- The API owns business logic and HTTP; React owns UI.
- No database, auth or cloud infrastructure in the MVP.

## Prerequisites

| Tool | Needed for | Version |
| --- | --- | --- |
| Node.js + npm | everything now | Node >= 22.12 (see `.nvmrc`) |
| C++20 compiler + CMake >= 3.24 | the C++ core and its tests (Stage 2+) | MSVC (VS 2022 "Desktop development with C++"; verified), GCC or Clang (not yet verified) |
| CMake on `PATH` + a C++ toolchain | building the Node-API addon (`npm run native:build`) | same as above; [cmake-js](https://github.com/cmake-js/cmake-js) drives the build. **It downloads Node's headers and (on Windows) `node.lib` from nodejs.org on first use** and caches them in `~/.cmake-js`, so the first build needs network access |
| Emscripten SDK | the WebAssembly module (`npm run wasm:build`, `npm run wasm:test:cpp`) | exactly 6.0.13 (`cpp/wasm/EMSCRIPTEN_VERSION`); also needs Ninja |

## Commands

Run from the repository root.

```bash
npm install          # install all workspace dependencies
npm run dev          # API on http://localhost:3001 and web on http://localhost:5173
npm run typecheck    # strict TypeScript check in all workspaces
npm test             # Vitest in all workspaces
npm run build        # build API (tsc -> apps/api/dist) and web (vite -> apps/web/dist)
npm run bench        # TypeScript baseline benchmark (see below)
npm run fixtures:parity   # regenerate cpp/tests/fixtures/parity.txt from the TypeScript engine
```

### C++ core (from `cpp/`)

```powershell
# Windows, Visual Studio 2022 (use a Developer PowerShell, or put the CMake bundled with VS on PATH)
cmake --preset msvc
cmake --build --preset msvc-release
ctest --preset msvc-release
cmake --build --preset msvc-debug; ctest --preset msvc-debug   # also run Debug
```

```bash
# Linux (GCC/Clang + Ninja) - written for portability, not yet verified
cmake --preset linux && cmake --build --preset linux && ctest --preset linux
```

The first configure downloads GoogleTest 1.17.0 (pinned by SHA-256). Build output goes to the git-ignored `cpp/build/`. Details and parity guarantees: [`cpp/README.md`](cpp/README.md).

### Native addon (from the repository root)

```bash
npm install
npm run native:build     # cmake-js -> cpp/build/addon/lib/hpa_addon.node (Release)
npm run native:check     # loads the addon, compares it with TypeScript on 1000 events
npm run native:rebuild   # clean build
```

`cmake` must be on `PATH` (Windows: use a Developer PowerShell for VS 2022, or the CMake bundled with Visual Studio). The artifact path is the same on every platform and is git-ignored. Without a built addon the API still runs; `engine: "native"` then returns HTTP 503. See [`cpp/README.md`](cpp/README.md) for the architecture.

**Parity workflow:** the TypeScript engine is the source of truth. `npm run fixtures:parity` writes `cpp/tests/fixtures/parity.txt` (generated events, analytics results, and validation error messages); the C++ tests compare every double by bit pattern. `npm test` fails if the committed fixture is stale.

Single workspace: `npm run dev:api`, `npm run dev:web`, or `npm test -w @hpa/api`.

The Vite dev server proxies `/api` to the API at `localhost:3001`. Set `PORT` to change the API port (then update the proxy in `apps/web/vite.config.ts`).

Health check: `GET /api/health` returns `{"status":"ok","uptimeSeconds":<number>}`.

## Event schema

All data is JSON-compatible. Types live in `apps/api/src/analytics/types.ts`, limits in `limits.ts`.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | number | Integer, 0 .. 2^53-1. Uniqueness is not enforced. |
| `timestamp` | number | Integer **milliseconds since the Unix epoch, UTC**, 0 .. 8.64e15. No timezone, no leap seconds. Validated and carried through; not used by any Stage 1 metric. |
| `eventType` | string | 1-64 chars from `[A-Za-z0-9_.-]` (ASCII only, so byte and UTF-16 ordering agree). |
| `category` | string | Same rules as `eventType`. |
| `value` | number | Finite double with absolute value <= 1e12. `NaN`, `±Infinity` and out-of-range values are rejected (JSON cannot encode them anyway; `null` is rejected as not a number). |

Extra properties on an event are ignored. A dataset holds at most 5,000,000 events in the core and 100,000 per API request.

## Algorithm definitions

These definitions are normative: the future C++ core must match them exactly.

- **Counts**: number of events per (`category`, `eventType`), sorted by category then eventType in code-unit order (uppercase before lowercase). Only groups that occur are listed.
- **Sum / average per category**: doubles added **sequentially in input order** starting from 0, with no compensation or reordering; average = `sum / count`. For non-integer values the sum can depend on input order; counts, histograms and percentiles never do. Dataset-level `summary` (count, sum, average, min, max) uses the same rule.
- **Percentiles (p50, p95, p99)**: **nearest-rank**. With `n` values sorted ascending, result = `sorted[rank - 1]` where `rank = max(1, ceil(p * n / 100))`, computed in integer arithmetic. The result is always an observed value (no interpolation), so duplicates are handled naturally. Example: 1..10 gives p50 = 5, p95 = 10.
- **Histogram**: `histogramBins` (integer 1..1024, default 10) equal-width bins over the observed `[min, max]`; `width = (max - min) / bins`. Bin `i` is `[min + i*width, min + (i+1)*width)` and the **last bin is closed**, so the maximum is counted. The normative index is `min(bins - 1, floor((v - min) / width))`; if `width` is 0 (all values equal) everything lands in bin 0. `edges` (`bins + 1` numbers, last one exactly `max`) is informational.
- **Empty dataset**: counts and groups are empty; `sum` is 0; `average`, `min`, `max` and percentiles are `null`; the histogram has `min`/`max` null, no edges and `bins` zero counts.
- **Invalid input** (wrong types, non-finite or out-of-range values, bad bin count, ...) throws `ValidationError` naming the offending field, e.g. `events[1].value must be a finite number ...`. The API maps it to HTTP 400.

### Deterministic generator

`generateEvents({ seed, count, startTimestamp?, intervalMs? })` uses **mulberry32** (uint32 arithmetic only, portable to C++). For event `i` (0-based) it draws three numbers `r1, r2, r3` in `[0, 1)` and sets: `category = [books, clothing, electronics, home, toys][floor(r1*5)]`, `eventType = [view, click, add_to_cart, purchase][floor(r2*4)]`, `value = floor(r3*r3*100000)/100`, `id = i + 1`, `timestamp = startTimestamp + i*intervalMs` (defaults: 1700000000000 and 1000). `seed` is a uint32. Golden values for seeds 0 and 42 are pinned in the tests and were cross-checked against an independent implementation.

## API

`GET /api/health` is unchanged. Errors are JSON: `{"error": "<code>", "message": "..."}` (`validation_error` → 400, `payload_too_large` → 413, `bad_request` for malformed JSON, `not_found`, `internal_error`).

**Generate** (max 100,000 events; unknown fields are rejected):

```bash
curl -s -X POST http://localhost:3001/api/analytics/generate \
  -H "content-type: application/json" -d '{"seed":42,"count":2}'
```
```json
{"options":{"seed":42,"count":2,"startTimestamp":1700000000000,"intervalMs":1000},
 "events":[{"id":1,"timestamp":1700000000000,"eventType":"click","category":"home","value":726.69},
           {"id":2,"timestamp":1700000001000,"eventType":"view","category":"home","value":277.29}]}
```

**Compute** (max 100,000 events and a 16 MB body; `histogramBins` optional):

```bash
curl -s -X POST http://localhost:3001/api/analytics/compute \
  -H "content-type: application/json" \
  -d '{"histogramBins":2,"events":[
        {"id":1,"timestamp":1000,"eventType":"view","category":"books","value":10},
        {"id":2,"timestamp":2000,"eventType":"click","category":"books","value":20},
        {"id":3,"timestamp":3000,"eventType":"view","category":"toys","value":30}]}'
```
```json
{"summary":{"count":3,"sum":60,"average":20,"min":10,"max":30},
 "countsByCategoryAndType":[{"category":"books","eventType":"click","count":1},
   {"category":"books","eventType":"view","count":1},{"category":"toys","eventType":"view","count":1}],
 "byCategory":[{"category":"books","count":2,"sum":30,"average":15},
   {"category":"toys","count":1,"sum":30,"average":30}],
 "histogram":{"binCount":2,"min":10,"max":30,"edges":[10,20,30],"counts":[1,2]},
 "percentiles":{"p50":20,"p95":30,"p99":30}}
```

### Engine selection

`/compute` accepts an optional `engine` field: `"typescript"` (default) or `"native"` (the C++ core through the Node-API addon). The response **body is identical** for both engines; the engine that actually produced it is reported in the `X-Analytics-Engine` response header (absent on errors). There is no fallback: if the addon is not built or cannot be loaded, `engine: "native"` returns `503 {"error":"native_engine_unavailable"}`.

```bash
curl -si -X POST http://localhost:3001/api/analytics/compute -H "content-type: application/json"   -d '{"engine":"native","events":[{"id":1,"timestamp":1000,"eventType":"view","category":"books","value":10}]}'
# HTTP/1.1 200 OK
# X-Analytics-Engine: native
# {"summary":{"count":1,"sum":10,"average":10,"min":10,"max":10},...}

curl -s -X POST http://localhost:3001/api/analytics/compute -H "content-type: application/json" -d '{"engine":"gpu","events":[]}'
# HTTP 400 {"error":"validation_error","message":"engine must be one of: typescript, native"}

curl -s http://localhost:3001/api/analytics/engines
# {"engines":{"typescript":{"available":true},"native":{"available":true,"coreVersion":"0.2.0","napiVersion":8}}}
# when not built: "native":{"available":false,"reason":"not_built"}   (or "load_failed")
```

Validation errors are the same from both engines: same HTTP status, same message, and the same first-error ordering. The 100,000-event limit and the 16 MB body limit apply to both.

Invalid request:

```bash
curl -s -X POST http://localhost:3001/api/analytics/generate -H "content-type: application/json" -d '{"seed":1,"count":-5}'
# HTTP 400 {"error":"validation_error","message":"count must be an integer between 0 and 5000000"}
```

## Tests and benchmark

```bash
npm test                      # all workspaces
npm test -w @hpa/api          # API + analytics engine only
npm run bench                 # defaults: sizes 10000,100000,1000000, 2 warm-up runs, 5 measured runs, seed 42
npm run bench -- --sizes=10000,100000 --runs=10 --warmup=3 --seed=7
npm run bench -- --json       # machine-readable output including every sample
```

Native tests need the built addon. Without it they are **skipped with a visible warning**; set `HPA_REQUIRE_NATIVE=1` (CI does) to make a missing or unloadable addon a failure instead:

```bash
npm run native:build
HPA_REQUIRE_NATIVE=1 npm test       # PowerShell: $env:HPA_REQUIRE_NATIVE = "1"; npm test
```

The native suite replays the parity cases and a table of malformed inputs through both engines and requires identical results (compared with `Object.is`, so `-0` differs from `0`, and with equal key order) or identical error messages.

The benchmark first verifies each dataset against an independent naive oracle (sort with comparator, linear bin assignment) and checks determinism; it aborts if anything differs, **before** recording timings. Timing uses `performance.now()` (monotonic) around `computeAnalytics` (which includes input validation) and `generateEvents`, after warm-up runs. It prints the Node/V8 version, OS, CPU, RAM, and min/median/max per size. Results are specific to the machine and are not committed; run it yourself. `npm run bench` measures only the TypeScript engine; the cross-engine comparison is `npm run bench:compare` (next section).

## Benchmark: TypeScript vs native C++

```bash
npm run native:build         # the Node-API addon (once)
npm run bench:core:build     # cpp/build/bench/bin/hpa_bench, the direct C++ core benchmark (once; needs cmake on PATH)
npm run bench:compare        # ~1 minute; prints a summary and writes bench-results/compare-<timestamp>.json (git-ignored)
npm run bench:compare -- --sizes=10000 --runs=30 --skip-http --json   # options: see the header of apps/api/bench/compare.ts
```

**What is measured** (the JSON report repeats these definitions, plus the raw samples of every run):

| Section | Sizes | What it covers |
| --- | --- | --- |
| 1. In-process | 10,000 and 100,000 | Direct calls of `computeAnalytics` (TypeScript) and the addon on the *same pre-generated array of JS objects*. The native number includes JS→C++ conversion of every event, core validation, core compute and building the JS result. A probe call (`histogramBins: 0`, which fails after conversion and validation) splits the native time into input conversion vs compute + result. |
| 2. HTTP | 10,000 and 100,000 | `POST /api/analytics/compute` against the real Express app on loopback, same body for both engines. Includes request JSON parsing and response serialisation, which are identical for both engines, so differences are diluted. |
| 3. Direct core | 10,000, 100,000 and 1,000,000 | The TypeScript engine vs `hpa::core` called directly from a C++ executable: no JS↔C++ boundary, no HTTP. The 1,000,000-event case exists only here (the API accepts at most 100,000). Generate / validate / compute are timed separately. |

**Method.** Every size of every section runs in a *fresh process* (V8 heap/JIT state left by one size changed another size's allocation-heavy timings by 10x when I tried a single process). Within a process: warm-up iterations, then timed runs (20 / 10 / 10), engine order alternating each iteration, an untimed garbage collection before every sample, monotonic timers. Before any timing is accepted, both engines must return **identical** results (`Object.is` on every number, same key order; the C++ executable prints its full result with 17 significant digits), and the TypeScript result must also match an independent naive oracle; a mismatch aborts the run and writes no report (I verified this by deliberately breaking the addon). Reported per metric: median, p25/p75, min/max, MAD, CV and raw samples. A verdict of "faster/slower" requires the 95% bootstrap interval (seeded, 2000 resamples) of the median ratio to exclude 1 *and* an effect of at least 5%; otherwise it says "inconclusive". The environment (OS, CPU, RAM, Node/V8, compilers and build configuration of the addon and the benchmark executable, commit, dirty flag, seed, warm-ups, runs) is recorded in the report.

**Results** from one machine (Windows 10, Intel i5-7400 @ 3.0 GHz x4, 16 GiB, Node 22.21, MSVC 19.43 Release), seed 42, 10 bins. Medians in ms. Across three separate invocations the in-process compute medians varied by less than 4%; HTTP and the noisier direct-core cases varied by up to about 8-11%.

| Level | Events | TypeScript | Native / C++ | Verdict |
| --- | ---: | ---: | ---: | --- |
| In-process compute | 10,000 | 3.28 | 12.39 (addon) | native 3.8x **slower** |
| In-process compute | 100,000 | 36.24 | 124.5 (addon) | native 3.4x **slower** |
| HTTP request | 10,000 | 17.08 | 24.98 (native) | native 1.5x **slower** |
| HTTP request | 100,000 | 169.9 | 258.9 (native) | native 1.5x **slower** |
| Direct core compute | 100,000 | 36.28 | 24.64 (C++) | C++ core 1.5x faster |
| Direct core compute | 1,000,000 | 386.1 | 257.0 (C++) | C++ core 1.5x faster |
| Direct core validation | 1,000,000 | 153.9 | 33.34 (C++) | C++ core 4.6x faster |

(10,000-event direct-core compute: 3.84 vs 2.25, ratio 1.7, but the TypeScript run was noisy, CV 17%; see the report for every size.)

**What the numbers say, and what they do not:**

- With the current Node-API design, calling the native engine is slower than staying in TypeScript for request-sized inputs. In the in-process split, about 10.3 ms of the 12.4 ms (10,000 events) and 100 ms of the 124.5 ms (100,000 events) is converting the JS objects to C++ (roughly 1 µs per event); compute plus building the result is about 1.8 ms / 21 ms. These are differences of medians from separate probes, so treat them as estimates.
- The C++ core alone is faster, but only by roughly 1.4-1.7x for compute. Most of that comes from validation (about 4.6x faster); the grouping, sums, sort and histogram part is roughly equal in both languages (derived estimate at 1,000,000 events: TypeScript 232 ms vs C++ 224 ms). The hand-written C++ is not tuned; this says nothing about what a tuned core could do.
- Generation (not exposed natively through HTTP) is not a reliable comparison: TypeScript generation time depends on V8 heap/JIT history (10,000 events took 3.7 ms in a fresh process but 0.28 ms after a 100,000-event run; the 100,000-event case is bimodal). Native generation through the addon is slower because it builds JS objects.
- Possible follow-ups that this benchmark could evaluate (none implemented or measured): reducing per-event boundary cost (for example columnar or typed-array input), and moving work off the main thread.
- Limits: one machine, no CPU-frequency or background-load control, synthetic data from one generator, in-process loopback HTTP. Re-run `npm run bench:compare` on your hardware before drawing conclusions; do not quote these figures as general speedups.

## Marshalling experiment (Stage 3.2)

The benchmark above showed that converting JS event objects to C++ is most of the native engine's cost. This experiment asks whether a cheaper input representation changes the conclusion. **The production code was not changed**: the experiment lives in a separate addon (`cpp/addon/experimental/`, never loaded by the API) and in `apps/api/bench/`.

```bash
npm run native:build                 # production addon (the baseline)
npm run native:experimental:build    # experimental addon -> cpp/build/addon-experimental/lib/
npm run bench:marshalling -- --sizes=10000,100000,1000000   # ~8 minutes with 1M; writes bench-results/marshalling-*.json
HPA_REQUIRE_EXPERIMENTAL=1 npm test  # without that variable the 167 experimental tests are skipped with a warning
```

**Where the production cost comes from** (`cpp/addon/src/marshal.cpp`): about 23 Node-API calls per event (`get_element`, `typeof` + `is_array`, five `get_property`, repeated `typeof` checks, `get_value_double` x3, two UTF-8 reads per string that each call twice), roughly 7 handles per event that are only released when the whole array has been read, and two `std::string` copies per event. Measured, that is about 1.1 µs per event.

**Alternatives** (all use the unchanged `hpa::core`, the same result writer, and the same validation, so error messages and ordering match the object API; 167 parity, error and boundary tests plus mutation checks guard that):

- *objects*: same object input, but one `HandleScope` per event and one call per field (strings read once into a stack buffer).
- *columnar*: `Float64Array` for id, timestamp and value, `Uint16Array` codes plus small string dictionaries for category and eventType. No Node-API call per event. Length checks, wrong column types and out-of-range codes are validated; the core still validates every value.

**Results** (medians, ms; one machine; each size in a fresh process; every variant verified identical to TypeScript before timing):

| 100,000 events | TypeScript | native: production | native: objects | native: columnar, columns already built | native: columnar, packed from objects |
| --- | ---: | ---: | ---: | ---: | ---: |
| Engine call | 36.0 | 131.6 | 119.2 | 31.5 | 37.1 (pack: 7.6) |
| of which convert + validate | - | 109.8 | 99.5 | 10.5 | 10.5 (+ pack) |
| vs TypeScript | | 3.7x slower | 3.3x slower | 1.14x faster | inconclusive (0.97) |

Other sizes: engine call with columns already built is 1.07x faster than TypeScript at 10,000 events and 1.10x at 1,000,000 (in-process only); packing from objects makes it 0.92x (slower) at 10,000 and inconclusive at 100,000 and 1,000,000. The *objects* variant is 1.07x / 1.10x / 1.23x faster than production at 10,000 / 100,000 / 1,000,000 events but remains about 3.3x slower than TypeScript. Convert + validate is about 10x cheaper with columns at every size.

**Whole-request view** (`JSON.parse(body)` → engine → `JSON.stringify(result)`, no HTTP server, includes every conversion):

| Events | TypeScript | production native | columnar from objects | TypeScript on the *same columnar body* | native on the columnar body |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 10.65 | 19.77 (1.9x slower) | 10.99 (inconclusive) | 5.84 | 5.47 (1.07x faster than TS on the same body) |
| 100,000 | 119.1 | 229.9 (1.9x slower) | 107.9 (1.10x faster) | 67.29 | 60.68 (1.11x faster) |
| 1,000,000 | 1587.7 | 2924 (1.8x slower) | 1276.9 (1.24x faster) | 691.6 | 603.7 (1.15x faster) |

Memory: the event objects occupy about 104 B/event on the V8 heap versus 28 B/event for the columns (3.7x less); every native variant additionally builds a transient `std::vector<hpa::Event>` of 88 B/event for the core, which the columnar layout does not avoid (the core API takes that vector).

**Conclusion: the experiment does not justify a production change, and the simpler object-based design is kept.**

- The columnar layout does make the conversion about 10x cheaper, which removes the overhead. But the best case (columns already built) is only 1.07-1.14x faster than TypeScript, and packing the objects that the API actually receives costs about as much as it saves.
- The large end-to-end gains for a columnar *request body* (about 2x) come mostly from `JSON.parse` being cheaper on arrays of numbers (26 ms vs 65 ms at 100,000 events), a saving the TypeScript engine would also get. With the same columnar body, native is only 1.07-1.15x faster than TypeScript. A columnar wire format may still be worth having for its smaller bodies (3.2x) and faster parsing, but that is a product/API decision, not a reason to use C++.
- The cheaper-object-reader variant is 7-23% faster than production but still much slower than TypeScript, so on its own it does not change the picture.
- Caveats: the columnar wire format is hypothetical (the API accepts only event objects); the whole-request TypeScript time is higher than parse + engine measured separately (about 119 ms vs 70 + 36 ms at 100,000 events) and I did not isolate why; 1,000,000 events exceeds the API limit and is in-process only; one machine, no control of CPU frequency or background load. Re-run `npm run bench:marshalling` before relying on any figure.

## WebAssembly (Stage 4)

The same `cpp/core` is compiled to WebAssembly with Emscripten and runs in a dedicated Web Worker, so heavy analytics never block the React UI. **There is no second implementation**: `cpp/wasm/` is a thin C binding (copy columns in, call the core, serialise the result) and contains no validation, generation, sorting, aggregation or histogram logic. The Node-API addon and the experimental marshalling code are unchanged and not used by the browser module. No dashboard or UI was added.

**Prerequisite: Emscripten 6.0.13** (pinned in `cpp/wasm/EMSCRIPTEN_VERSION`; MSVC/GCC cannot build this target), plus CMake >= 3.24 and Ninja.

```bash
git clone https://github.com/emscripten-core/emsdk.git && cd emsdk
./emsdk install 6.0.13 && ./emsdk activate 6.0.13
source ./emsdk_env.sh            # Windows PowerShell: .\emsdk_env.ps1   (cmake and ninja must be on PATH too)

npm run wasm:build               # -> apps/web/src/wasm/generated/hpa_core.{js,wasm} (git-ignored; ~63 kB, ~27 kB gzipped)
npm run wasm:test:cpp            # the whole C++ core suite, compiled to WebAssembly and run under Node.js
HPA_REQUIRE_WASM=1 npm test -w @hpa/web   # parity, worker messaging, real worker thread (skipped with a warning if not built)
```

`npm run wasm:build` also deletes `node_modules/.vitest-cache`: Vitest caches the result of `import.meta.glob` on disk, so a cache written while the module did not exist would keep reporting "not built" after you build it. It detects Emscripten first; if it is missing, not activated, or a different version, it prints the setup steps above and exits non-zero instead of pretending to build.

**Interface** (`apps/web/src/wasm/`):

```ts
const client = createWasmAnalyticsClient();                         // worker + module load are lazy and asynchronous
const { engine, result } = await client.computeEvents(events, { histogramBins: 10 });   // engine === "wasm"
const { columns } = await client.generate({ seed: 42, count: 1000 });                   // seeded generator of the core
```

- **Input is columnar**, to avoid per-event boundary cost: five typed arrays (`ids`, `timestamps`, `values` as `Float64Array`; `eventTypeCodes`, `categoryCodes` as `Uint16Array`) plus two small string dictionaries. A whole dataset is copied into the WebAssembly heap in a few bulk `memcpy`-style copies and processed by **one** call. Typed-array views are copied by their `byteOffset`/`byteLength`, never the whole underlying buffer.
- **C ABI** (`cpp/wasm/src/wasm_api.cpp`, version 1): `hpa_alloc/free`, `hpa_compute_columnar`, `hpa_generate`, `hpa_result_ptr/size` and the `hpa_generated_*` column getters. Results come back as JSON text with doubles printed with 17 significant digits (exact round trip, `-0` preserved).
- **Worker protocol** (`protocol.ts`): `init | compute | generate` requests with an integer `requestId`; `ready | result | generated | error` responses that always carry `engine: "wasm"`. Error kinds: `init_failed`, `validation`, `limit`, `bad_request`, `internal`; the client adds `worker_unavailable`, `worker_error`, `timeout`, `terminated`, `protocol`. Validation messages are the TypeScript engine's, and arbitrary function names cannot be requested.
- **Failures are reported, never hidden**: if the module cannot be loaded (missing file, bad ABI, compile error) every request fails with `init_failed` and the cause; if the worker crashes or stops answering, pending requests reject, the worker is discarded and a fresh one starts on the next request. **There is no fallback to another engine**, and every success names the engine that ran.
- **Ownership**: `compute()` transfers the columns' ArrayBuffers to the worker (they become unusable in the caller) when a view covers its whole buffer; a view onto part of a larger buffer is copied first.
- **Memory**: the heap starts at 32 MiB and can grow to 1 GiB. A call needs roughly 85 bytes per event inside WebAssembly (28 B copied columns, 48 B `hpa::Event` in wasm32, 8 B for the values the core sorts in place), plus the columns on the main thread (28 B) while in flight. The default limit is **1,000,000 events per call** (about 85 MiB in WebAssembly); above the core's own 5,000,000 the core's message is reported. The heap never shrinks. Results are small.

**Correctness evidence** (what was actually run; Windows 10, Node 22.21 / emsdk's Node 24.19, Emscripten 6.0.13 / clang, `-O3`, `-ffp-contract=off -fno-fast-math`, WebAssembly has no fused multiply-add):

- The C++ core test suite, **49 tests, passes compiled to WebAssembly**, including the bit-for-bit TypeScript parity fixtures (doubles compared by bit pattern, 100,000-event dataset, exact error messages). This is the basis for the bit-exact claim, and it holds for the WebAssembly engine of V8 (Node.js). Firefox and Safari engines were not tested.
- 84 tests call the real module and compare with the TypeScript engine (`Object.is`, key order): the shared parity cases (6 generator, 25 compute datasets), 29 validation-error cases, floating-point edge cases (`-0` ordering, 0.1+0.2+0.3, extreme ids), percentile and histogram boundaries for many sizes and bin counts, error ordering, columnar layout checks, typed-array views with offsets surrounded by poison values, heap growth, and a leak check (heap flat over 100 calls).
- 62 tests cover the worker: the handler (lazy single initialisation, sticky load failure, malformed requests, error mapping), the client against a loopback worker with real `structuredClone` transfer semantics (concurrency, out-of-order replies, crashes, timeouts, protocol violations), and a real `worker_threads` thread (real transfer, failure modes, and proof that the calling thread keeps running during a 400,000-event computation).
- 10 deliberate mutations of the binding and wrapper (wrong column, ignored offsets, 15-digit output, leaking, ...) are all caught.
- The module was also loaded in a **real browser worker** (Edge 155 / Chromium, headless, built with Vite in application mode) and returned the hand-verified results with `engine: "wasm"` and the TypeScript validation message. That check was manual and is not part of the test suite or CI.

Vite does not recognise Emscripten's own `new URL("hpa_core.wasm", import.meta.url)`, so `loadModule.ts` resolves the `.wasm` URL with Vite's `?url` and passes it as `locateFile` in browsers/workers (Node.js, used by the tests, reads the file itself). Vite warns that `node:module` is externalised for the browser; that import sits behind Emscripten's Node.js check and is never reached in a browser. Not claimed: any performance figure (no WebAssembly benchmark exists yet), Firefox/Safari behaviour, or support for browsers without native WebAssembly exception handling.

## Known limitations

- Reference implementation only: single-threaded, whole dataset in memory, no streaming.
- The API accepts at most 100,000 events per request; larger workloads are exercised through the core and the benchmark, not over HTTP.
- Float sums are order-dependent (sequential addition); there is no compensated summation. Cross-implementation parity for sums relies on the C++ core using the same order, plain IEEE doubles and no fast-math.
- Percentiles are only computed over the whole dataset (not per category).
- Histogram range is always the observed min/max; custom ranges are not supported. If `(max - min) / bins` underflows to 0, all values go to bin 0.
- `timestamp` is validated but not used by any metric yet; `id` uniqueness is not checked.
- No rate limiting or authentication (out of scope for the MVP).
- No UI for these endpoints yet.
- The native engine runs synchronously on the Node.js main thread (no worker threads), like the TypeScript engine, and it validates and converts the whole request before computing. Conversion copies the events once; large requests therefore cost memory proportional to the dataset.
- `/generate` always uses the TypeScript generator; engine selection exists for `/compute` only. The addon exposes `generateEvents` and it is tested, but it is not routed.
- The addon is built for the installed Node.js with Node-API version 8 and the local platform/architecture only; there are no prebuilt binaries. Verified locally on Windows x64 / MSVC and by GitHub Actions on Windows and Ubuntu.
- WebAssembly: the input must be columnar (`packColumns` converts event objects, costing a pass on the main thread); default limit 1,000,000 events per call, one request at a time per worker, the heap never shrinks, a stuck computation can only be stopped by terminating the worker, and a load failure is sticky until a new worker is created. Verified on V8 (Node.js and one Chromium-based browser); Firefox and Safari were not tested. The WebAssembly CI job (Ubuntu) passes, but it runs under Node.js: the real-browser check was manual. Nothing in the app uses the WebAssembly client yet.

## Roadmap

- [x] **Stage 0** – Monorepo scaffold, health endpoint, placeholder UI, tests.
- [x] **Stage 1** – Synthetic event generator, analytics spec, TypeScript baseline, API endpoints with input validation, benchmark baseline.
- [x] **Stage 2** – C++20 core + GoogleTest, CMake build, bit-exact parity tests against the TypeScript baseline (MSVC verified; GCC/Clang pending CI).
- [x] **Stage 3** – Node-API addon exposing the core to the API (`engine: "native"`), differential tests against TypeScript, CI workflow for Windows and Ubuntu (passing on GitHub Actions; MSVC also verified locally).
- [x] **Stage 3.1** – Reproducible TypeScript-vs-native benchmark (in-process, HTTP and direct-core levels, verified before timing).
- [x] **Stage 3.2** – Marshalling experiment: columnar and optimised-object input in a separate experimental addon, benchmarked against production and TypeScript. Result: not adopted (see above).
- [x] **Stage 4** – WebAssembly build of the core (Emscripten 6.0.13), Web Worker with an explicit message protocol, parity and worker tests, WebAssembly CI job. Verified locally (core suite inside WebAssembly, 146 web tests, one manual real-browser run) and by the WebAssembly CI job on Ubuntu. No UI and no WebAssembly benchmark.
- [ ] **Stage 5** – Reproducible benchmarks and comparison UI.
- [ ] **Stage 6** – Dockerfile; confirm Linux (GCC/Clang) results from CI and harden the workflow.

## License

MIT
