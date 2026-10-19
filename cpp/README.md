# C++ engine (not implemented yet)

Planned layout, added in later stages:

- `core/`  – portable C++20 analytics library. No Node.js, browser or Emscripten includes.
- `addon/` – Node-API binding (`node-addon-api`) that wraps `core/`.
- `wasm/`  – Emscripten (embind or a plain C ABI) binding that wraps the same `core/`.
- `tests/` – GoogleTest tests for `core/`.

Prerequisites (not installed on the dev machine at scaffold time): a C++20 compiler
(MSVC via the "Desktop development with C++" workload, or GCC/Clang), CMake >= 3.24,
and the Emscripten SDK for the WASM target.
