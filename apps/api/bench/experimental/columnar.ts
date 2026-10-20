/**
 * EXPERIMENTAL helpers for the marshalling study. Not imported by any production code.
 * Loads the experimental addon (cpp/addon/experimental) and packs events into the columnar layout.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ValidationError, type AnalyticsEvent, type AnalyticsResult, type ComputeOptions } from "../../src/analytics/index.js";

export interface Columns {
  ids: Float64Array;
  timestamps: Float64Array;
  values: Float64Array;
  eventTypeCodes: Uint16Array;
  categoryCodes: Uint16Array;
  /** Dictionaries: eventTypeCodes[i] / categoryCodes[i] index into these. */
  eventTypes: string[];
  categories: string[];
}

interface ExperimentalAddon {
  readonly coreVersion: string;
  /** sizeof(hpa::Event): the C++ transient memory per event while the core runs (all variants). */
  readonly eventStructBytes: number;
  computeObjects(events: unknown, options?: unknown): AnalyticsResult;
  computeColumnar(columns: unknown, options?: unknown): AnalyticsResult;
}

const ADDON_URL = new URL("../../../../cpp/build/addon-experimental/lib/hpa_addon_experimental.node", import.meta.url);

let cached: ExperimentalAddon | null | undefined;

/** Returns the experimental addon, or undefined when it has not been built (`npm run native:experimental:build`). */
export function loadExperimental(): ExperimentalAddon | undefined {
  if (cached === undefined) {
    const path = fileURLToPath(ADDON_URL);
    try {
      cached = existsSync(path) ? (createRequire(import.meta.url)(path) as ExperimentalAddon) : null;
    } catch {
      cached = null;
    }
  }
  return cached ?? undefined;
}

function requireAddon(): ExperimentalAddon {
  const addon = loadExperimental();
  if (!addon) throw new Error("experimental addon not built: run `npm run native:experimental:build`");
  return addon;
}

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

export const experimentalComputeObjects = (events: unknown, options?: ComputeOptions): AnalyticsResult => {
  const addon = requireAddon();
  return translate(() => addon.computeObjects(events, options));
};

export const experimentalComputeColumnar = (columns: unknown, options?: ComputeOptions): AnalyticsResult => {
  const addon = requireAddon();
  return translate(() => addon.computeColumnar(columns, options));
};

export const eventStructBytes = (): number => requireAddon().eventStructBytes;

/** Packs events into columns in a single pass. Throws RangeError for more than 65536 distinct names. */
export function packColumns(events: readonly AnalyticsEvent[]): Columns {
  const n = events.length;
  const ids = new Float64Array(n);
  const timestamps = new Float64Array(n);
  const values = new Float64Array(n);
  const eventTypeCodes = new Uint16Array(n);
  const categoryCodes = new Uint16Array(n);
  const eventTypes: string[] = [];
  const categories: string[] = [];
  const typeIndex = new Map<string, number>();
  const categoryIndex = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    ids[i] = e.id;
    timestamps[i] = e.timestamp;
    values[i] = e.value;

    let t = typeIndex.get(e.eventType);
    if (t === undefined) {
      t = eventTypes.length;
      if (t >= 65536) throw new RangeError("more than 65536 distinct event types");
      typeIndex.set(e.eventType, t);
      eventTypes.push(e.eventType);
    }
    eventTypeCodes[i] = t;

    let c = categoryIndex.get(e.category);
    if (c === undefined) {
      c = categories.length;
      if (c >= 65536) throw new RangeError("more than 65536 distinct categories");
      categoryIndex.set(e.category, c);
      categories.push(e.category);
    }
    categoryCodes[i] = c;
  }
  return { ids, timestamps, values, eventTypeCodes, categoryCodes, eventTypes, categories };
}

/** Materialises event objects from columns (what a TypeScript engine would need from the columnar wire format). */
export function unpackColumns(c: Columns): AnalyticsEvent[] {
  const n = c.ids.length;
  const events = new Array<AnalyticsEvent>(n);
  for (let i = 0; i < n; i++) {
    events[i] = {
      id: c.ids[i]!,
      timestamp: c.timestamps[i]!,
      eventType: c.eventTypes[c.eventTypeCodes[i]!]!,
      category: c.categories[c.categoryCodes[i]!]!,
      value: c.values[i]!,
    };
  }
  return events;
}

/** Bytes held by the typed arrays (dictionaries are tiny and excluded). */
export function columnsBytes(c: Columns): number {
  return c.ids.byteLength + c.timestamps.byteLength + c.values.byteLength + c.eventTypeCodes.byteLength + c.categoryCodes.byteLength;
}
