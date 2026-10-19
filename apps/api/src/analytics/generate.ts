import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_START_TIMESTAMP,
} from "./limits.js";
import { createRng } from "./prng.js";
import type { AnalyticsEvent, GenerateOptions, ResolvedGenerateOptions } from "./types.js";
import { validateGenerateOptions } from "./validate.js";

/** Order is part of the contract: the RNG picks by index. */
export const CATEGORIES = ["books", "clothing", "electronics", "home", "toys"] as const;
export const EVENT_TYPES = ["view", "click", "add_to_cart", "purchase"] as const;

export function resolveGenerateOptions(options: GenerateOptions): ResolvedGenerateOptions {
  validateGenerateOptions(options);
  return {
    seed: options.seed,
    count: options.count,
    startTimestamp: options.startTimestamp ?? DEFAULT_START_TIMESTAMP,
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
  };
}

/**
 * Deterministic: the same options always yield the same events.
 *
 * For event i (0-based), with one mulberry32 stream seeded by `seed`, three
 * draws are taken in this order:
 *   r1 -> category  = CATEGORIES[floor(r1 * 5)]
 *   r2 -> eventType = EVENT_TYPES[floor(r2 * 4)]
 *   r3 -> value     = floor(r3 * r3 * 100000) / 100    (0.00 .. 999.99)
 * id = i + 1; timestamp = startTimestamp + i * intervalMs.
 */
export function generateEvents(options: GenerateOptions): AnalyticsEvent[] {
  const { seed, count, startTimestamp, intervalMs } = resolveGenerateOptions(options);
  const rng = createRng(seed);
  const events: AnalyticsEvent[] = new Array<AnalyticsEvent>(count);
  for (let i = 0; i < count; i++) {
    const category = CATEGORIES[Math.floor(rng() * CATEGORIES.length)] as string;
    const eventType = EVENT_TYPES[Math.floor(rng() * EVENT_TYPES.length)] as string;
    const r = rng();
    events[i] = {
      id: i + 1,
      timestamp: startTimestamp + i * intervalMs,
      eventType,
      category,
      value: Math.floor(r * r * 100000) / 100,
    };
  }
  return events;
}
