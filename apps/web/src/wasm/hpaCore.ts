import type { AnalyticsResult, Columns, ComputeOptions, GenerateOptions, HpaCoreInfo } from "./types.js";

/** The subset of the Emscripten module instance used here (see cpp/wasm/src/wasm_api.cpp). */
export interface EmscriptenModule {
  /** Re-read after every call that can grow the heap; Emscripten keeps this property current. */
  readonly HEAPU8: Uint8Array;
  _hpa_abi_version(): number;
  _hpa_core_version(): number;
  _hpa_event_struct_bytes(): number;
  _hpa_max_events(): number;
  _hpa_alloc(bytes: number): number;
  _hpa_free(pointer: number): void;
  _hpa_result_ptr(): number;
  _hpa_result_size(): number;
  _hpa_compute_columnar(
    n: number,
    ids: number,
    timestamps: number,
    values: number,
    eventTypeCodes: number,
    categoryCodes: number,
    eventTypeCount: number,
    eventTypeLengths: number,
    eventTypeBytes: number,
    categoryCount: number,
    categoryLengths: number,
    categoryBytes: number,
    histogramBins: number,
    hasHistogramBins: number,
  ): number;
  _hpa_generate(seed: number, count: number, startTimestamp: number, intervalMs: number, hasStart: number, hasInterval: number): number;
  _hpa_generated_ids(): number;
  _hpa_generated_timestamps(): number;
  _hpa_generated_values(): number;
  _hpa_generated_event_type_codes(): number;
  _hpa_generated_category_codes(): number;
}

export type EmscriptenFactory = () => Promise<EmscriptenModule>;

/** ABI version this wrapper was written for. */
export const EXPECTED_ABI_VERSION = 1;

/**
 * Default per-call event limit. Per event the call needs about 28 bytes for the copied columns, 48 for the
 * core's event objects (sizeof(hpa::Event) in wasm32) and 8 for the values it sorts in place: roughly
 * 85 bytes, so 1,000,000 events need about 85 MiB of the module's 1 GiB heap (32 MiB initial, growable).
 */
export const DEFAULT_MAX_EVENTS = 1_000_000;

/** Invalid input (same messages as the TypeScript engine where the same check exists). */
export class WasmValidationError extends Error {
  override readonly name = "WasmValidationError";
}
/** The request exceeds the wrapper's event limit. */
export class WasmLimitError extends Error {
  override readonly name = "WasmLimitError";
}
/** Unexpected failure inside the module or the wrapper (for example out of memory). */
export class WasmInternalError extends Error {
  override readonly name = "WasmInternalError";
}

const MAX_DICTIONARY_ENTRIES = 65536;
const STATUS_OK = 0;
const STATUS_VALIDATION_ERROR = 1;

function isInstance<T>(value: unknown, ctor: abstract new (...args: never[]) => T): value is T {
  return value instanceof ctor;
}

/** Checks the column object exactly like cpp/addon/experimental does, with the same messages. */
function checkColumns(columns: unknown): asserts columns is Columns {
  if (typeof columns !== "object" || columns === null || Array.isArray(columns)) {
    throw new WasmValidationError("columns must be an object");
  }
  const c = columns as Record<string, unknown>;
  for (const name of ["ids", "timestamps", "values"] as const) {
    if (!isInstance(c[name], Float64Array)) throw new WasmValidationError(`columns.${name} must be a Float64Array`);
  }
  for (const name of ["eventTypeCodes", "categoryCodes"] as const) {
    if (!isInstance(c[name], Uint16Array)) throw new WasmValidationError(`columns.${name} must be a Uint16Array`);
  }
  for (const name of ["eventTypes", "categories"] as const) {
    const dictionary = c[name];
    if (!Array.isArray(dictionary)) throw new WasmValidationError(`columns.${name} must be an array of strings`);
    if (dictionary.length > MAX_DICTIONARY_ENTRIES) {
      throw new WasmValidationError(`columns.${name} must have at most ${MAX_DICTIONARY_ENTRIES} entries`);
    }
    dictionary.forEach((entry, k) => {
      if (typeof entry !== "string") throw new WasmValidationError(`columns.${name}[${k}] must be a string`);
    });
  }
}

/** Owns the module instance and turns each call into one bulk copy in, one call, one bulk copy out. */
export class HpaCore {
  private constructor(
    private readonly module: EmscriptenModule,
    readonly info: HpaCoreInfo,
    /** The core's own hard limit (5,000,000); above it the core's message is reported as-is. */
    private readonly coreMaxEvents: number,
  ) {}

  /** Instantiates the module and checks the ABI. Rejects (never falls back) if anything is wrong. */
  static async create(factory: EmscriptenFactory, options: { maxEvents?: number } = {}): Promise<HpaCore> {
    const module = await factory();
    const abiVersion = module._hpa_abi_version();
    if (abiVersion !== EXPECTED_ABI_VERSION) {
      throw new WasmInternalError(`WebAssembly module ABI ${abiVersion} does not match the expected ABI ${EXPECTED_ABI_VERSION}; rebuild it`);
    }
    const heap = module.HEAPU8;
    const versionPointer = module._hpa_core_version();
    let end = versionPointer;
    while (heap[end] !== 0) end++;
    const coreMax = module._hpa_max_events();
    const requested = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    return new HpaCore(module, {
      coreVersion: new TextDecoder().decode(heap.subarray(versionPointer, end)),
      abiVersion,
      eventStructBytes: module._hpa_event_struct_bytes(),
      maxEvents: Math.min(requested, coreMax),
    }, coreMax);
  }

  /** Current size of the WebAssembly heap in bytes (grows on demand, never shrinks). */
  heapBytes(): number {
    return this.module.HEAPU8.length;
  }

  /**
   * Computes the analytics for `columns`. The input arrays are only read (their offsets and lengths are
   * respected; bytes outside each view are never touched). Throws WasmValidationError, WasmLimitError
   * or WasmInternalError.
   */
  compute(columns: Columns, options: ComputeOptions = {}): AnalyticsResult {
    checkColumns(columns);
    const n = columns.ids.length;
    if (n > this.coreMaxEvents) {
      throw new WasmValidationError(`events must contain at most ${this.coreMaxEvents} items`); // the core's message
    }
    if (n > this.info.maxEvents) {
      throw new WasmLimitError(`events must contain at most ${this.info.maxEvents} items for the WebAssembly engine`);
    }
    for (const other of [columns.timestamps, columns.values, columns.eventTypeCodes, columns.categoryCodes]) {
      if (other.length !== n) throw new WasmValidationError("columns must all have the same length");
    }

    const encoder = new TextEncoder();
    const encodeDictionary = (entries: string[]) => {
      const encoded = entries.map((entry) => encoder.encode(entry));
      const lengths = Uint32Array.from(encoded, (e) => e.length);
      const bytes = new Uint8Array(lengths.reduce((a, b) => a + b, 0));
      let offset = 0;
      for (const e of encoded) {
        bytes.set(e, offset);
        offset += e.length;
      }
      return { count: entries.length, lengths, bytes };
    };
    const eventTypes = encodeDictionary(columns.eventTypes);
    const categories = encodeDictionary(columns.categories);

    const allocations: number[] = [];
    try {
      const inputs = [
        columns.ids, columns.timestamps, columns.values, columns.eventTypeCodes, columns.categoryCodes,
        eventTypes.lengths, eventTypes.bytes, categories.lengths, categories.bytes,
      ] as const;
      // Allocate everything first: an allocation can grow the heap, which invalidates earlier views.
      const pointers = inputs.map((view) => {
        const pointer = this.module._hpa_alloc(view.byteLength);
        if (pointer === 0) throw new WasmInternalError("out of WebAssembly memory");
        allocations.push(pointer);
        return pointer;
      });
      const heap = this.module.HEAPU8; // read after the last allocation
      inputs.forEach((view, i) => {
        // Copy exactly the view's bytes: byteOffset/byteLength, never the whole underlying buffer.
        heap.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), pointers[i]!);
      });

      const binsGiven = options.histogramBins !== undefined;
      const bins = typeof options.histogramBins === "number" ? options.histogramBins : Number.NaN;
      const status = this.module._hpa_compute_columnar(
        n, pointers[0]!, pointers[1]!, pointers[2]!, pointers[3]!, pointers[4]!,
        eventTypes.count, pointers[5]!, pointers[6]!, categories.count, pointers[7]!, pointers[8]!,
        bins, binsGiven ? 1 : 0,
      );
      const text = this.readResult();
      if (status === STATUS_OK) return JSON.parse(text) as AnalyticsResult;
      if (status === STATUS_VALIDATION_ERROR) throw new WasmValidationError(text);
      throw new WasmInternalError(text);
    } finally {
      for (const pointer of allocations) this.module._hpa_free(pointer);
    }
  }

  /** Generates events with the core's seeded generator and returns them as columns (copies). */
  generate(options: GenerateOptions): Columns {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new WasmValidationError("options must be an object");
    }
    const o = options as unknown as Record<string, unknown>;
    const num = (value: unknown): number => (typeof value === "number" ? value : Number.NaN);
    if (typeof o["count"] === "number" && o["count"] > this.info.maxEvents && o["count"] <= this.coreMaxEvents) {
      throw new WasmLimitError(`count must be at most ${this.info.maxEvents} for the WebAssembly engine`);
    }
    const status = this.module._hpa_generate(
      num(o["seed"]), num(o["count"]), num(o["startTimestamp"]), num(o["intervalMs"]),
      o["startTimestamp"] !== undefined ? 1 : 0, o["intervalMs"] !== undefined ? 1 : 0,
    );
    const text = this.readResult();
    if (status === STATUS_VALIDATION_ERROR) throw new WasmValidationError(text);
    if (status !== STATUS_OK) throw new WasmInternalError(text);

    const meta = JSON.parse(text) as { count: number; eventTypes: string[]; categories: string[] };
    const n = meta.count;
    const heap = this.module.HEAPU8;
    // slice() copies out of the WebAssembly heap: the module reuses that memory on the next call.
    const f64 = (pointer: number) => new Float64Array(heap.buffer, pointer, n).slice();
    const u16 = (pointer: number) => new Uint16Array(heap.buffer, pointer, n).slice();
    return {
      ids: f64(this.module._hpa_generated_ids()),
      timestamps: f64(this.module._hpa_generated_timestamps()),
      values: f64(this.module._hpa_generated_values()),
      eventTypeCodes: u16(this.module._hpa_generated_event_type_codes()),
      categoryCodes: u16(this.module._hpa_generated_category_codes()),
      eventTypes: meta.eventTypes,
      categories: meta.categories,
    };
  }

  private readResult(): string {
    const pointer = this.module._hpa_result_ptr();
    const size = this.module._hpa_result_size();
    return new TextDecoder().decode(this.module.HEAPU8.subarray(pointer, pointer + size));
  }
}
