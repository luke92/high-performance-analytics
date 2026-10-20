import { Router } from "express";
import {
  computeAnalytics,
  generateEvents,
  resolveGenerateOptions,
  ValidationError,
  type AnalyticsEvent,
  type ComputeOptions,
  type GenerateOptions,
} from "./analytics/index.js";
import { getNativeStatus } from "./native/loader.js";
import { nativeComputeAnalytics } from "./native/nativeEngine.js";

/** Per-request event cap for both endpoints (the core itself allows more). */
export const MAX_API_EVENTS = 100_000;
/** ~100 bytes per event * MAX_API_EVENTS, with headroom. */
export const COMPUTE_BODY_LIMIT = "16mb";

/** Engines selectable on /compute. Closed list: clients never name functions or code. */
export const ENGINES = ["typescript", "native"] as const;
export type EngineName = (typeof ENGINES)[number];
/** Response header naming the engine that actually produced the result. */
export const ENGINE_HEADER = "X-Analytics-Engine";

function parseEngine(value: unknown): EngineName {
  if (value === undefined) return "typescript"; // the default is unchanged
  if (typeof value === "string" && (ENGINES as readonly string[]).includes(value)) return value as EngineName;
  throw new ValidationError(`engine must be one of: ${ENGINES.join(", ")}`);
}

export class PayloadTooLargeError extends Error {
  override readonly name = "PayloadTooLargeError";
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new ValidationError(`unknown field(s): ${unknown.join(", ")}`);
}

export function analyticsRouter(): Router {
  const router = Router();

  router.post("/generate", (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownKeys(body, ["seed", "count", "startTimestamp", "intervalMs"]);
    const options = body as unknown as GenerateOptions;
    const resolved = resolveGenerateOptions(options); // throws ValidationError
    if (resolved.count > MAX_API_EVENTS) {
      throw new ValidationError(`count must be at most ${MAX_API_EVENTS} for this endpoint`);
    }
    res.json({ options: resolved, events: generateEvents(resolved) });
  });

  router.post("/compute", (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownKeys(body, ["events", "histogramBins", "engine"]);
    const engine = parseEngine(body["engine"]);
    const { events } = body;
    if (Array.isArray(events) && events.length > MAX_API_EVENTS) {
      throw new PayloadTooLargeError(`events must contain at most ${MAX_API_EVENTS} items`);
    }
    const options: ComputeOptions = {};
    if (body["histogramBins"] !== undefined) {
      options.histogramBins = body["histogramBins"] as number; // type-checked by the core
    }
    // Untrusted input: both engines validate every event before use. The header is set only
    // after the chosen engine succeeded, so it can never claim an engine that did not run.
    const result =
      engine === "native"
        ? nativeComputeAnalytics(events, options)
        : computeAnalytics(events as AnalyticsEvent[], options);
    res.set(ENGINE_HEADER, engine).json(result);
  });

  router.get("/engines", (_req, res) => {
    res.json({ engines: { typescript: { available: true }, native: getNativeStatus() } });
  });

  return router;
}
