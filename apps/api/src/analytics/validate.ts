import { ValidationError } from "./errors.js";
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_START_TIMESTAMP,
  MAX_ABS_VALUE,
  MAX_EVENTS,
  MAX_HISTOGRAM_BINS,
  MAX_INTERVAL_MS,
  MAX_STRING_LENGTH,
  MAX_TIMESTAMP,
  MAX_UINT32,
  NAME_PATTERN,
} from "./limits.js";
import type { AnalyticsEvent, ComputeOptions, GenerateOptions } from "./types.js";

function fail(message: string): never {
  throw new ValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkIntegerInRange(value: unknown, name: string, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer between ${min} and ${max}`);
  }
}

function checkName(value: unknown, name: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_STRING_LENGTH ||
    !NAME_PATTERN.test(value)
  ) {
    fail(`${name} must be 1-${MAX_STRING_LENGTH} characters from [A-Za-z0-9_.-]`);
  }
}

/** Throws ValidationError unless `events` is an array of valid AnalyticsEvent. */
export function validateEvents(events: unknown): asserts events is AnalyticsEvent[] {
  if (!Array.isArray(events)) fail("events must be an array");
  if (events.length > MAX_EVENTS) fail(`events must contain at most ${MAX_EVENTS} items`);
  for (let i = 0; i < events.length; i++) {
    const event: unknown = events[i];
    if (!isRecord(event)) fail(`events[${i}] must be an object`);
    checkIntegerInRange(event["id"], `events[${i}].id`, 0, Number.MAX_SAFE_INTEGER);
    checkIntegerInRange(event["timestamp"], `events[${i}].timestamp`, 0, MAX_TIMESTAMP);
    checkName(event["eventType"], `events[${i}].eventType`);
    checkName(event["category"], `events[${i}].category`);
    const value = event["value"];
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_ABS_VALUE) {
      fail(`events[${i}].value must be a finite number with absolute value <= ${MAX_ABS_VALUE}`);
    }
  }
}

export function validateGenerateOptions(options: unknown): asserts options is GenerateOptions {
  if (!isRecord(options)) fail("options must be an object");
  checkIntegerInRange(options["seed"], "seed", 0, MAX_UINT32);
  checkIntegerInRange(options["count"], "count", 0, MAX_EVENTS);
  const start = options["startTimestamp"];
  if (start !== undefined) checkIntegerInRange(start, "startTimestamp", 0, MAX_TIMESTAMP);
  const interval = options["intervalMs"];
  if (interval !== undefined) checkIntegerInRange(interval, "intervalMs", 1, MAX_INTERVAL_MS);
  // The last timestamp must stay within range. Both factors are bounded, so the product is exact.
  const count = options["count"] as number;
  const last =
    ((start as number | undefined) ?? DEFAULT_START_TIMESTAMP) +
    Math.max(0, count - 1) * ((interval as number | undefined) ?? DEFAULT_INTERVAL_MS);
  if (last > MAX_TIMESTAMP) {
    fail("startTimestamp + (count - 1) * intervalMs exceeds the maximum timestamp");
  }
}

export function validateComputeOptions(options: unknown): asserts options is ComputeOptions {
  if (!isRecord(options)) fail("options must be an object");
  const bins = options["histogramBins"];
  if (bins !== undefined) checkIntegerInRange(bins, "histogramBins", 1, MAX_HISTOGRAM_BINS);
}
