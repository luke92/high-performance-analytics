import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { AnalyticsResult } from "../analytics/index.js";

/** The raw Node-API module built from cpp/addon. Inputs are untrusted; the addon validates them. */
export interface NativeAddon {
  readonly coreVersion: string;
  readonly napiVersion: number;
  generateEvents(options: unknown): unknown[];
  computeAnalytics(events: unknown, options?: unknown): AnalyticsResult;
}

export type NativeStatus =
  | { available: true; coreVersion: string; napiVersion: number }
  | { available: false; reason: "not_built" | "load_failed" };

export class NativeUnavailableError extends Error {
  override readonly name = "NativeUnavailableError";
}

/** Fixed output location of `npm run native:build`, relative to this file (src/native or dist/native). */
const DEFAULT_ADDON_URL = new URL("../../../../cpp/build/addon/lib/hpa_addon.node", import.meta.url);

interface LoadResult {
  addon?: NativeAddon;
  status: NativeStatus;
}

let cached: LoadResult | undefined;

function load(): LoadResult {
  // HPA_ADDON_PATH lets deployments and tests point at another build; it is read once per process.
  const path = process.env["HPA_ADDON_PATH"] ?? fileURLToPath(DEFAULT_ADDON_URL);
  if (!existsSync(path)) {
    console.warn("[native] addon not found; the native engine is disabled (run `npm run native:build`)");
    return { status: { available: false, reason: "not_built" } };
  }
  try {
    const addon = createRequire(import.meta.url)(path) as NativeAddon;
    if (typeof addon.generateEvents !== "function" || typeof addon.computeAnalytics !== "function") {
      throw new Error("module does not export generateEvents/computeAnalytics");
    }
    return { addon, status: { available: true, coreVersion: addon.coreVersion, napiVersion: addon.napiVersion } };
  } catch (err) {
    // Details stay in the server log; clients only see a generic reason.
    console.error("[native] failed to load addon:", err);
    return { status: { available: false, reason: "load_failed" } };
  }
}

/** Loads the addon on first use. Never throws; failure is reported through the status. */
export function getNativeStatus(): NativeStatus {
  cached ??= load();
  return cached.status;
}

/** Returns the addon or throws NativeUnavailableError. There is deliberately no fallback. */
export function getNativeAddon(): NativeAddon {
  cached ??= load();
  if (cached.addon === undefined) {
    throw new NativeUnavailableError("the native engine is not available on this server");
  }
  return cached.addon;
}
