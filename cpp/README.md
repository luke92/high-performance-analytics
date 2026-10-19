# C++ analytics core

A portable C++20 implementation of the analytics engine in `apps/api/src/analytics/`. **The TypeScript engine is the behavioral reference**: the C++ results must match it bit-for-bit, including error messages. There is no Node-API addon and no WebAssembly build yet (Stages 3 and 4).

The library has no dependencies beyond the C++ standard library. It includes nothing from Node.js, V8, Express, browsers or Emscripten. GoogleTest is fetched only for the tests.

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
cmake --preset linux
cmake --build --preset linux
ctest --preset linux
```

For a clean build, delete `cpp/build/` first (it is git-ignored, as are all binaries). Useful options: `-DHPA_BUILD_TESTS=OFF` (library only), `-DHPA_WARNINGS_AS_ERRORS=ON` (for CI).

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
- **Timing:** nothing here is benchmarked or optimized yet; this stage is about correctness.
- **Linux/GCC/Clang:** the code is written to be portable but has only been built and tested with MSVC so far.
