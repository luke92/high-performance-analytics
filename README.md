# high-performance-analytics

A full-stack analytics platform powered by React, Node.js, native C++ and WebAssembly.

A portfolio project demonstrating practical C++ integration in a web product. It will process synthetic event data and compare three implementations of the same computationally intensive analytics:

1. **TypeScript** baseline (Node.js API).
2. **Native C++ engine** called from Node.js through Node-API (`node-addon-api`).
3. **WebAssembly** build of the same portable C++ core, executed in the browser.

> **Status: Stage 2 complete.** A deterministic TypeScript analytics engine (the behavioral reference), the API endpoints around it, a TypeScript-only benchmark baseline, and a standalone C++20 core with bit-exact parity tests exist. The Node-API addon and WebAssembly build do **not** exist yet, the C++ core has not been benchmarked, and no speedup is claimed.

## Architecture

```
apps/
  api/   Express + TypeScript. HTTP concerns, validation, orchestration of engines.
         src/analytics/  framework-independent TypeScript reference engine (no Express imports)
         bench/          benchmark script
  web/   React + Vite + TypeScript. UI and visualization only.
cpp/     core/  portable C++20 library (no Node/V8/browser/Emscripten dependencies)
         tests/ GoogleTest suite + parity fixture generated from the TypeScript engine
         (planned) addon/ Node-API binding, wasm/ Emscripten binding
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
| Emscripten SDK | Stage 4+ (not needed yet) | latest stable |

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

The benchmark first verifies each dataset against an independent naive oracle (sort with comparator, linear bin assignment) and checks determinism; it aborts if anything differs, **before** recording timings. Timing uses `performance.now()` (monotonic) around `computeAnalytics` (which includes input validation) and `generateEvents`, after warm-up runs. It prints the Node/V8 version, OS, CPU, RAM, and min/median/max per size. Results are specific to the machine and are not committed; run it yourself. Only the TypeScript implementation exists, so no comparison is made.

## Known limitations

- Reference implementation only: single-threaded, whole dataset in memory, no streaming.
- The API accepts at most 100,000 events per request; larger workloads are exercised through the core and the benchmark, not over HTTP.
- Float sums are order-dependent (sequential addition); there is no compensated summation. Cross-implementation parity for sums relies on the C++ core using the same order, plain IEEE doubles and no fast-math.
- Percentiles are only computed over the whole dataset (not per category).
- Histogram range is always the observed min/max; custom ranges are not supported. If `(max - min) / bins` underflows to 0, all values go to bin 0.
- `timestamp` is validated but not used by any metric yet; `id` uniqueness is not checked.
- No rate limiting or authentication (out of scope for the MVP).
- No UI for these endpoints yet.

## Roadmap

- [x] **Stage 0** – Monorepo scaffold, health endpoint, placeholder UI, tests.
- [x] **Stage 1** – Synthetic event generator, analytics spec, TypeScript baseline, API endpoints with input validation, benchmark baseline.
- [x] **Stage 2** – C++20 core + GoogleTest, CMake build, bit-exact parity tests against the TypeScript baseline (MSVC verified; GCC/Clang pending CI).
- [ ] **Stage 3** – Node-API addon exposing the core to the API.
- [ ] **Stage 4** – WebAssembly build (Emscripten) and in-browser execution.
- [ ] **Stage 5** – Reproducible benchmarks and comparison UI.
- [ ] **Stage 6** – Dockerfile and GitHub Actions CI (Linux + Windows).

## License

MIT
