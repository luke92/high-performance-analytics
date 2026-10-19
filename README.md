# high-performance-analytics

A full-stack analytics platform powered by React, Node.js, native C++ and WebAssembly.

A portfolio project demonstrating practical C++ integration in a web product. It will process synthetic event data and compare three implementations of the same computationally intensive analytics:

1. **TypeScript** baseline (Node.js API).
2. **Native C++ engine** called from Node.js through Node-API (`node-addon-api`).
3. **WebAssembly** build of the same portable C++ core, executed in the browser.

> **Status: scaffold only (Stage 0).** There is no analytics engine yet and no benchmark data. Any performance claims will be added only after being measured and reproducible.

## Architecture

```
apps/
  api/   Express + TypeScript. HTTP concerns, validation, orchestration of engines.
  web/   React + Vite + TypeScript. UI and visualization only.
cpp/     (planned) core/ portable C++20 library, addon/ Node-API binding, wasm/ Emscripten binding, tests/
```

Principles:

- The C++ **core** is independent of Node.js, browser APIs and Emscripten. The addon and WASM targets are thin bindings over the same code.
- The API owns business logic and HTTP; React owns UI.
- No database, auth or cloud infrastructure in the MVP.

## Prerequisites

| Tool | Needed for | Version |
| --- | --- | --- |
| Node.js + npm | everything now | Node >= 22.12 (see `.nvmrc`) |
| C++20 compiler + CMake >= 3.24 | Stage 2+ (not needed yet) | MSVC (VS 2022 "Desktop development with C++"), GCC or Clang |
| Emscripten SDK | Stage 4+ (not needed yet) | latest stable |

## Commands

Run from the repository root.

```bash
npm install          # install all workspace dependencies
npm run dev          # API on http://localhost:3001 and web on http://localhost:5173
npm run typecheck    # strict TypeScript check in all workspaces
npm test             # Vitest in all workspaces
npm run build        # build API (tsc -> apps/api/dist) and web (vite -> apps/web/dist)
```

Single workspace: `npm run dev:api`, `npm run dev:web`, or `npm test -w @hpa/api`.

The Vite dev server proxies `/api` to the API at `localhost:3001`. Set `PORT` to change the API port (then update the proxy in `apps/web/vite.config.ts`).

Health check: `GET /api/health` returns `{"status":"ok","uptimeSeconds":<number>}`.

## Roadmap

- [x] **Stage 0** – Monorepo scaffold, health endpoint, placeholder UI, tests.
- [ ] **Stage 1** – Synthetic event generator, analytics spec, TypeScript baseline, API endpoints with input validation.
- [ ] **Stage 2** – C++20 core + GoogleTest, CMake build, parity tests against the TypeScript baseline.
- [ ] **Stage 3** – Node-API addon exposing the core to the API.
- [ ] **Stage 4** – WebAssembly build (Emscripten) and in-browser execution.
- [ ] **Stage 5** – Reproducible benchmarks and comparison UI.
- [ ] **Stage 6** – Dockerfile and GitHub Actions CI (Linux + Windows).

## License

MIT
