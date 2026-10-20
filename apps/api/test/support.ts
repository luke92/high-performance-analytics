import { describe, expect } from "vitest";
import { getNativeStatus } from "../src/native/loader.js";

/** CI sets HPA_REQUIRE_NATIVE=1: a missing addon then fails the suite instead of skipping it. */
export const nativeRequired = process.env["HPA_REQUIRE_NATIVE"] === "1";

/** Like `describe`, for tests that need the compiled addon. Skips loudly, or fails when required. */
export function describeNative(name: string, fn: () => void): void {
  const available = getNativeStatus().available;
  if (!available && !nativeRequired) {
    console.warn(
      `[native tests] SKIPPED "${name}": addon not built. Run \`npm run native:build\`, ` +
        "or set HPA_REQUIRE_NATIVE=1 to treat this as a failure.",
    );
  }
  describe.skipIf(!available && !nativeRequired)(name, fn);
}

/**
 * Deep equality that is stricter than toEqual: numbers are compared with Object.is
 * (so -0 differs from 0), and object key order must match (so JSON text is identical).
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
    expect(typeof actual === "object" && actual !== null && !Array.isArray(actual), `${path} should be an object`).toBe(
      true,
    );
    expect(Object.keys(actual as object), `${path} keys`).toEqual(Object.keys(expected));
    for (const key of Object.keys(expected)) {
      expectIdentical((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

/** Runs `fn` and reports the outcome in a comparable form. */
export function outcome(fn: () => unknown): { ok: unknown } | { error: string; name: string } {
  try {
    return { ok: fn() };
  } catch (err) {
    const e = err as Error;
    return { error: e.message, name: e.name };
  }
}
