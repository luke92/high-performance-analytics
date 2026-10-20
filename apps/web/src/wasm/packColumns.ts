import type { AnalyticsEvent } from "../../../api/src/analytics/types.js";
import type { Columns } from "./types.js";

/** Packs event objects into columns in one pass. Throws RangeError beyond 65536 distinct names. */
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

/** Materialises event objects from columns (for display or tests). */
export function unpackColumns(columns: Columns): AnalyticsEvent[] {
  const n = columns.ids.length;
  const events = new Array<AnalyticsEvent>(n);
  for (let i = 0; i < n; i++) {
    events[i] = {
      id: columns.ids[i]!,
      timestamp: columns.timestamps[i]!,
      eventType: columns.eventTypes[columns.eventTypeCodes[i]!]!,
      category: columns.categories[columns.categoryCodes[i]!]!,
      value: columns.values[i]!,
    };
  }
  return events;
}
