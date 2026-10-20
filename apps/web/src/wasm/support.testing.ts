/// <reference types="node" />
// Helpers for the WebAssembly tests. Compiled only by tsconfig.test.json (Node types), never by the app.
import { describe, expect } from "vitest";
import type { EngineApi } from "../../../api/scripts/parityFixture.js";
import { WasmInternalError, WasmLimitError, WasmValidationError, type HpaCore } from "./hpaCore.js";
import { isModuleBuilt, loadHpaCore } from "./loadModule.js";
import { packColumns, unpackColumns } from "./packColumns.js";

/** CI sets HPA_REQUIRE_WASM=1: a missing or unloadable module then fails the suite instead of skipping it. */
export const wasmRequired = process.env["HPA_REQUIRE_WASM"] === "1";
export const wasmBuilt = isModuleBuilt();

/** Like `describe`, for tests that need the compiled module. Skips loudly, or fails when required. */
export function describeWasm(name: string, fn: () => void): void {
  if (!wasmBuilt && !wasmRequired) {
    console.warn(`[wasm tests] SKIPPED "${name}": module not built. Run \`npm run wasm:build\` (needs Emscripten), or set HPA_REQUIRE_WASM=1 to fail instead.`);
  }
  describe.skipIf(!wasmBuilt && !wasmRequired)(name, fn);
}

let sharedCore: Promise<HpaCore> | undefined;
/** One module instance for the whole test file. */
export const getCore = (): Promise<HpaCore> => (sharedCore ??= loadHpaCore());

/**
 * Deep equality stricter than toEqual: numbers compared with Object.is (so -0 differs from 0) and
 * object keys must be in the same order (so JSON text is identical).
 */
export function expectIdentical(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof expected === "number" || typeof actual === "number") {
    expect(Object.is(actual, expected), `${path}: ${String(actual)} vs ${String(expected)}`).toBe(true);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} should be an array`).toBe(true);
    const a = actual as unknown[];
    expect(a.length, `${path}.length`).toBe(expected.length);
    expected.forEach((item, i) => expectIdentical(a[i], item, `${path}[${i}]`));
    return;
  }
  if (typeof expected === "object" && expected !== null) {
    expect(typeof actual === "object" && actual !== null && !Array.isArray(actual), `${path} should be an object`).toBe(true);
    expect(Object.keys(actual as object), `${path} keys`).toEqual(Object.keys(expected));
    for (const key of Object.keys(expected)) {
      expectIdentical((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

/** Result of a call in comparable form: the value, or the error's message. */
export function outcome(fn: () => unknown): { ok: unknown } | { error: string } {
  try {
    return { ok: fn() };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** The WebAssembly engine in the shape the shared parity cases expect (events in, events out). */
export function wasmEngineApi(core: HpaCore): EngineApi {
  return {
    generateEvents: (options) => unpackColumns(core.generate(options)),
    computeAnalytics: (events, options) => core.compute(packColumns(events), options),
  };
}

export { WasmInternalError, WasmLimitError, WasmValidationError };
