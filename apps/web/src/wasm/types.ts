// Types shared by the WebAssembly wrapper, the worker and the client.
// The analytics types come from the API's TypeScript engine (type-only import: nothing is bundled).
import type { AnalyticsResult, GenerateOptions } from "../../../api/src/analytics/types.js";

export type { AnalyticsResult, GenerateOptions };

/**
 * Columnar events: the only input format of the WebAssembly engine. A whole dataset crosses the
 * JavaScript/WebAssembly boundary as a few typed arrays (one bulk copy), not as one object per event.
 * All five arrays have the same length n; ids and timestamps must hold integers (anything else is
 * rejected with the TypeScript engine's message); codes index into the dictionaries.
 */
export interface Columns {
  ids: Float64Array;
  timestamps: Float64Array;
  values: Float64Array;
  eventTypeCodes: Uint16Array;
  categoryCodes: Uint16Array;
  /** At most 65536 entries each; entries are validated per event by the core, like event names. */
  eventTypes: string[];
  categories: string[];
}

export interface ComputeOptions {
  /** Histogram bin count; the core validates it (integer 1..1024, default 10). */
  histogramBins?: number;
}

/** Name of the engine reported with every response; there is no fallback to another engine. */
export const WASM_ENGINE = "wasm" as const;
export type EngineName = typeof WASM_ENGINE;

/** Static facts about the loaded module. */
export interface HpaCoreInfo {
  /** hpa::core version string compiled into the module. */
  coreVersion: string;
  /** Version of the C ABI between this wrapper and the module. */
  abiVersion: number;
  /** sizeof(hpa::Event) in the module: transient WebAssembly memory per event while the core runs. */
  eventStructBytes: number;
  /** Per-call event limit enforced by this wrapper (lower than the core's own 5,000,000). */
  maxEvents: number;
}
