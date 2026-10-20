// Public entry of the WebAssembly engine for the web app.
//
//   const client = createWasmAnalyticsClient();
//   const { engine, result } = await client.computeEvents(events); // engine === "wasm"
//
// Memory: the module's heap starts at 32 MiB and can grow to 1 GiB. One compute call needs roughly
// 85 bytes per event inside WebAssembly (columns 28 B + 48 B of core event objects + 8 B of sorted values),
// plus the same columns again on the main thread and, while a request is in flight, in the worker's
// message; the default limit is 1,000,000 events (about 85 MiB in WebAssembly). Results are small.
import { WasmAnalyticsClient, type ClientOptions } from "./client.js";

export { WasmAnalyticsClient, WasmEngineError, type ClientErrorKind, type ClientOptions, type ComputeOutcome, type GenerateOutcome, type ReadyOutcome, type WorkerLike } from "./client.js";
export { packColumns, unpackColumns } from "./packColumns.js";
export type { ErrorKind, WorkerRequest, WorkerResponse } from "./protocol.js";
export { DEFAULT_MAX_EVENTS } from "./hpaCore.js";
export { WASM_ENGINE, type AnalyticsResult, type Columns, type ComputeOptions, type EngineName, type GenerateOptions, type HpaCoreInfo } from "./types.js";

/** Creates a client backed by a dedicated module Web Worker (bundled by Vite). */
export function createWasmAnalyticsClient(options?: ClientOptions): WasmAnalyticsClient {
  return new WasmAnalyticsClient(() => new Worker(new URL("./analytics.worker.ts", import.meta.url), { type: "module" }), options);
}
