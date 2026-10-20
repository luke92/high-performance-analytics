import {
  ValidationError,
  type AnalyticsEvent,
  type AnalyticsResult,
  type ComputeOptions,
  type GenerateOptions,
} from "../analytics/index.js";
import { getNativeAddon } from "./loader.js";

/** Runs a native call, mapping the addon's validation errors to the core's ValidationError. */
function translate<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof Error && (err as { code?: unknown }).code === "HPA_VALIDATION_ERROR") {
      throw new ValidationError(err.message);
    }
    throw err;
  }
}

/**
 * Same contract as the TypeScript computeAnalytics, executed by the C++ core.
 * `events` is untrusted: the addon type-checks and validates it. Throws ValidationError
 * (identical message and order to the TypeScript engine) or NativeUnavailableError.
 */
export function nativeComputeAnalytics(events: unknown, options?: ComputeOptions): AnalyticsResult {
  const addon = getNativeAddon();
  return translate(() => addon.computeAnalytics(events, options));
}

export function nativeGenerateEvents(options: unknown): AnalyticsEvent[] {
  const addon = getNativeAddon();
  return translate(() => addon.generateEvents(options as GenerateOptions)) as AnalyticsEvent[];
}
