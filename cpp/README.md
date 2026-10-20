# C++ analytics core

A portable C++20 implementation of the analytics engine in `apps/api/src/analytics/`. **The TypeScript engine is the behavioral reference**: the C++ results must match it bit-for-bit, including error messages. A thin Node-API addon (`addon/`) exposes it to Node.js, and a thin Emscripten binding (`wasm/`) compiles the same code to WebAssembly for the browser.

The core library has no dependencies beyond the C++ standard library. It includes nothing from Node.js, V8, Express, browsers or Emscripten (the WebAssembly build only adds compiler flags for it, see below). GoogleTest is fetched only for the tests; node-addon-api and Node-API headers are used only by `addon/`.

## Layout

```
cpp/
  CMakeLists.txt            top level: options, core, tests
  CMakePresets.json         msvc (Visual Studio 2022) and linux (Ninja) presets
  core/
    CMakeLists.txt          static library hpa_core (alias hpa::core)
    include/hpa/            public headers
      limits.hpp  types.hpp  errors.hpp  prng.hpp
      validate.hpp  generate.hpp  compute.hpp
    src/                    validate.cpp  generate.cpp  compute.cpp
  addon/
    CMakeLists.txt          target hpa_addon (hpa_addon.node); only configured by cmake-js
    src/addon.cpp           module registration, exception -> JS error translation
    src/marshal.{hpp,cpp}   JS <-> hpa conversion (the whole boundary)
  wasm/
    CMakeLists.txt          target hpa_wasm -> hpa_core.{js,wasm} (Emscripten only)
    src/wasm_api.cpp        C ABI: columns in, one call, JSON out (no analytics logic)
    src/result_json.{hpp,cpp}  result -> JSON with 17-digit doubles
    build.mjs  EMSCRIPTEN_VERSION   `npm run wasm:build` / `wasm:test:cpp` and the pinned version
  tests/
    fixtures/parity.txt     GENERATED from the TypeScript engine (do not edit)
    fixture.{hpp,cpp}       parity.txt loader
    test_support.hpp        bit-exact comparison helpers
    test_generate.cpp  test_compute.cpp  test_validation.cpp  test_parity.cpp
```

Public API (namespace `hpa`):

```cpp
std::vector<Event>  generate_events(const GenerateOptions&);
AnalyticsResult     compute_analytics(std::span<const Event>, const ComputeOptions& = {});
void validate_events(std::span<const Event>);        // also: validate_generate_options, validate_compute_options
// Failures throw hpa::ValidationError (message identical to the TypeScript one).
```

## Build and test

Prerequisites: CMake >= 3.24 and a C++20 compiler (MSVC 19.4x from VS 2022; GCC >= 11 or Clang >= 14 are expected to work but have **not** been verified yet). The first configure downloads GoogleTest 1.17.0 (URL + SHA-256 pinned in `tests/CMakeLists.txt`); for offline use pass `-DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=<path to an extracted googletest-1.17.0>`.

Run everything from `cpp/`.

**Windows (Visual Studio 2022 with the "Desktop development with C++" workload).** If `cmake` is not on `PATH`, use the one bundled with Visual Studio (`C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin`) or a "Developer PowerShell for VS 2022".

```powershell
cmake --preset msvc
cmake --build --preset msvc-release
ctest --preset msvc-release
# Debug as well (recommended: optimizers can hide floating-point corner cases)
cmake --build --preset msvc-debug
ctest --preset msvc-debug
```

**Linux (GCC or Clang, Ninja):**

```bash
cmake --preset linux && cmake --build --preset linux && ctest --preset linux                       # Release
cmake --preset linux-debug && cmake --build --preset linux-debug && ctest --preset linux-debug      # Debug
```

For a clean build, delete `cpp/build/` first (it is git-ignored, as are all binaries). Useful options: `-DHPA_BUILD_TESTS=OFF` (library only), `-DHPA_WARNINGS_AS_ERRORS=ON` (for CI).

## Node-API addon

```bash
# from the repository root; cmake must be on PATH
npm install
npm run native:build      # -> cpp/build/addon/lib/hpa_addon.node (same path on every platform/generator)
npm run native:check      # load + compare with TypeScript
```

**Build approach.** `cmake-js` 8.0.0 and `node-addon-api` 8.9.2 are pinned (exact versions in `apps/api/package.json`, resolved in `package-lock.json`). cmake-js configures `cpp/CMakeLists.txt` with `-DHPA_BUILD_ADDON=ON -DHPA_BUILD_TESTS=OFF` in `cpp/build/addon/`, which downloads the Node.js headers (and `node.lib` on Windows) for the running Node version from nodejs.org on first use and caches them under `~/.cmake-js`; the first build therefore needs network access (CI retries it and caches the directory). `cpp/addon/CMakeLists.txt` refuses to configure outside cmake-js and locates node-addon-api through `require.resolve`, so no absolute path is hard-coded. The addon links the existing `hpa::core` target (built with the same strict floating-point flags as for the tests) and compiles with `NAPI_VERSION=8` and C++ exceptions enabled. Nothing downloaded or compiled is committed (`cpp/build/` is git-ignored; cmake-js caches under the user's home directory).

**Exports** (`require("hpa_addon.node")`):

| Export | Notes |
| --- | --- |
| `generateEvents(options)` | `{ seed, count, startTimestamp?, intervalMs? }` -> events with the TypeScript key order |
| `computeAnalytics(events, options?)` | `options = { histogramBins? }` -> result with the TypeScript shape and key order; absent values are `null` |
| `coreVersion`, `napiVersion` | from CMake's project version and `NAPI_VERSION` |

Application code should not call the addon directly: `apps/api/src/native/` loads it lazily, maps errors, and never falls back to TypeScript.

**Boundary rules** (`marshal.cpp`):

- Arrays and objects are converted to `std::vector<hpa::Event>` once. Integers must be integral JS numbers that fit `int64_t`; fractional, non-finite and out-of-range values are never truncated or cast silently.
- The array length is checked before any element is read. Exceptions raised by JS getters propagate unchanged.
- Validation is **not** re-implemented. When a field has the wrong JS type it is replaced with a sentinel the core rejects (for example `id = -1`, `value = NaN`, `eventType = ""`), so the core itself throws the exact TypeScript message, in TypeScript's field order. A few messages that only exist at the boundary (`events must be an array`, `events[i] must be an object`, `options must be an object`) are produced in `marshal.cpp`, and tests compare every one against the TypeScript engine.
- Errors thrown to JS are `Error` objects with `code`: `HPA_VALIDATION_ERROR` (invalid input; the API turns it into the shared `ValidationError` and HTTP 400) or `HPA_INTERNAL_ERROR`.

**Experimental addon.** `addon/experimental/` builds a second, separate module (`npm run native:experimental:build`, output `cpp/build/addon-experimental/lib/hpa_addon_experimental.node`) with alternative input representations (columnar typed arrays; a cheaper object reader). It reuses `src/marshal.cpp`'s result writer and the unchanged core, is never loaded by the API, and exists only for the benchmark in `apps/api/bench/marshalling.ts`. See the root README for the results and why production keeps the object API.

Limitations: calls are synchronous and run on the main thread; the addon is built per Node.js install (Node-API makes it ABI-stable across Node versions, but the binary is platform and architecture specific); verified locally on Windows x64 / MSVC and by GitHub Actions on Windows and Ubuntu.

## WebAssembly

`wasm/` compiles the unchanged core to WebAssembly with Emscripten. It is a plain C ABI (`src/wasm_api.cpp`, ABI version 1) that copies caller-provided columns into `hpa::Event` values, calls `hpa::generate_events` / `hpa::compute_analytics`, and returns the result as JSON (`src/result_json.cpp`); it contains no validation, generation, sorting, aggregation or histogram logic. The JavaScript side (wrapper, Web Worker, protocol, client and tests) lives in `apps/web/src/wasm/`; see the root README for the interface, memory and error model.

**Toolchain: Emscripten 6.0.13** (pinned in `wasm/EMSCRIPTEN_VERSION`; this target cannot be built with MSVC, GCC or Clang directly). Minimal setup, then build and test from the repository root:

```bash
git clone https://github.com/emscripten-core/emsdk.git && cd emsdk
./emsdk install 6.0.13 && ./emsdk activate 6.0.13
source ./emsdk_env.sh            # PowerShell: .\emsdk_env.ps1 ; CMake (>= 3.24) and Ninja must be on PATH too

npm run wasm:build               # emcmake cmake ... -DHPA_BUILD_WASM=ON -> cpp/build/wasm/wasm/hpa_core.{js,wasm}, copied to apps/web/src/wasm/generated
npm run wasm:test:cpp            # emcmake ... -DHPA_BUILD_TESTS=ON: the 49-test GoogleTest suite compiled to WebAssembly, run by ctest under Node.js
```

`wasm/build.mjs` checks for Emscripten before doing anything and exits non-zero with these steps if it is missing, not activated, or a different version (override with `HPA_ALLOW_EMSCRIPTEN_MISMATCH=1`, results then unverified). Equivalent manual commands: `emcmake cmake -S cpp -B cpp/build/wasm -G Ninja -DCMAKE_BUILD_TYPE=Release -DHPA_BUILD_WASM=ON -DHPA_BUILD_TESTS=OFF && cmake --build cpp/build/wasm`.

Build settings that matter for parity: `-fwasm-exceptions` for the whole project (the core throws `ValidationError`, caught in `wasm_api.cpp`), and the core's usual `-ffp-contract=off -fno-fast-math` (WebAssembly itself has no fused multiply-add). Output is an ES module (`-sMODULARIZE -sEXPORT_ES6`) usable from browsers, workers and Node.js; the heap starts at 32 MiB and may grow to 1 GiB, `FILESYSTEM=0`, `hpa_core.wasm` is about 63 kB (27 kB gzipped). Differences from the native build: `sizeof(hpa::Event)` is 48 bytes in wasm32 (88 natively) and `size_t` is 32-bit. The test suite additionally links with `NODERAWFS` so the parity fixture can be read from disk.

The whole suite passing as WebAssembly (including the bit-for-bit fixtures) is what supports the bit-exact claim for this build; it was run on V8 (Node.js) only.

## Parity with TypeScript

What is guaranteed to match, and how it is enforced:

| Aspect | How |
| --- | --- |
| mulberry32, generated events | uint32 arithmetic (`prng.hpp`); six `GENERATE` fixtures (including seed 0, seed 42 and the maximum uint32 seed) compared field by field |
| Sums, averages, edges, percentiles, min/max | `COMPUTE` fixtures (21 inline and 4 generated datasets, up to 100,000 events) compared **by IEEE-754 bit pattern**, so `-0` vs `0` and last-bit differences fail the tests; no tolerance, no rounding |
| Sum order | sequential from `+0.0` in input order, no compensation |
| Percentiles | nearest rank, integer arithmetic; `-0.0` sorts before `+0.0` like `Float64Array.sort` |
| Histogram | same width, bin index, closed last bin, edges and empty-input shape |
| Validation | same checks in the same order; **exact message text** compared against messages produced by the TypeScript code (29 `ERROR` fixtures) |

The fixture file is produced by the TypeScript implementation: `npm run fixtures:parity` (repo root). A TypeScript test fails if the committed file no longer matches what the TypeScript code produces, so behavior changes must be made in both languages and the fixture regenerated.

Floating-point requirements: the core is compiled with `/fp:strict` (MSVC) or `-ffp-contract=off -fno-fast-math` (GCC/Clang). Fast-math or fused multiply-add contraction would change the last bit of sums and of `floor(r*r*100000)/100`.

### Known differences from TypeScript (all by design)

- **Types, not runtime checks.** C++ fields are typed, so "wrong JSON type" errors (a string where a number is expected, `null`, non-object event) cannot occur. Integers are `int64_t` so that every out-of-range *number* TypeScript rejects is also rejected here.
- **Messages use the TypeScript field names** (`events[1].value`, `histogramBins`, `startTimestamp`), not the C++ member names, so the strings are identical.
- **Absent values** are `std::optional<double>` instead of `null`.
- **Timing:** the core is not tuned. `bench/hpa_bench.cpp` (target `hpa_bench`, `npm run bench:core:build`, option `HPA_BUILD_BENCH`) times generate, validate and compute directly, without Node.js; `npm run bench:compare` combines it with the TypeScript and addon measurements. See the root README for methodology and results.
- **Linux/GCC/Clang:** the code is written to be portable but has only been built and tested with MSVC so far.
