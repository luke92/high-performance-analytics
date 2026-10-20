/**
 * Messages between the UI thread and the WebAssembly worker.
 *
 * Every request carries an integer `requestId` that the worker echoes in its response, so concurrent
 * requests cannot be mixed up. Every response says which engine produced it (`engine: "wasm"`); there
 * is no other engine behind this worker and no silent fallback.
 *
 * Ownership: ArrayBuffers listed as transferable move to the receiver and become unusable
 * (byteLength 0) in the sender.
 */
import type { AnalyticsResult, Columns, ComputeOptions, EngineName, GenerateOptions, HpaCoreInfo } from "./types.js";

export type WorkerRequest =
  /** Loads the module (idempotent). Other requests also trigger loading, so this is optional. */
  | { type: "init"; requestId: number }
  | { type: "compute"; requestId: number; columns: Columns; options?: ComputeOptions }
  | { type: "generate"; requestId: number; options: GenerateOptions };

export type ErrorKind =
  /** The WebAssembly module could not be loaded or instantiated (sticky for this worker). */
  | "init_failed"
  /** The input is invalid; `message` equals the TypeScript engine's message where the same check exists. */
  | "validation"
  /** The input is larger than the worker's event limit. */
  | "limit"
  /** The message itself is malformed (unknown type, missing requestId, ...). */
  | "bad_request"
  /** Anything unexpected inside the module or the worker. */
  | "internal";

export type WorkerResponse =
  | { type: "ready"; requestId: number; engine: EngineName; info: HpaCoreInfo }
  | { type: "result"; requestId: number; engine: EngineName; result: AnalyticsResult }
  | { type: "generated"; requestId: number; engine: EngineName; columns: Columns }
  | { type: "error"; requestId: number; engine: EngineName; kind: ErrorKind; message: string };

/** requestId used in an error response when the request had no valid id. */
export const UNKNOWN_REQUEST_ID = -1;
