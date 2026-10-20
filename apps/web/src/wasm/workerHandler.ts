import { HpaCore, WasmInternalError, WasmLimitError, WasmValidationError } from "./hpaCore.js";
import { UNKNOWN_REQUEST_ID, type ErrorKind, type WorkerRequest, type WorkerResponse } from "./protocol.js";
import { WASM_ENGINE, type Columns } from "./types.js";

export interface HandlerResult {
  response: WorkerResponse;
  /** Buffers to transfer (not copy) with the response. */
  transfer: ArrayBuffer[];
}

export interface WorkerHandler {
  /** Never rejects: every outcome, including failures, is a response. */
  handle(message: unknown): Promise<HandlerResult>;
}

/**
 * The worker's logic, independent of the worker global scope so it can be tested directly.
 * The module is loaded lazily on the first message, once; a load failure is remembered and reported
 * on every later request (create a new worker to retry).
 */
export function createWorkerHandler(options: { loadCore: () => Promise<HpaCore> }): WorkerHandler {
  let corePromise: Promise<HpaCore> | undefined;
  let loadFailure: string | undefined;

  const getCore = async (): Promise<HpaCore> => {
    if (loadFailure !== undefined) throw new InitFailure(loadFailure);
    corePromise ??= options.loadCore();
    try {
      return await corePromise;
    } catch (err) {
      loadFailure ??= `could not load the WebAssembly module: ${describe(err)}`;
      throw new InitFailure(loadFailure);
    }
  };

  const error = (requestId: number, kind: ErrorKind, message: string): HandlerResult => ({
    response: { type: "error", requestId, engine: WASM_ENGINE, kind, message },
    transfer: [],
  });

  return {
    async handle(message: unknown): Promise<HandlerResult> {
      if (typeof message !== "object" || message === null) {
        return error(UNKNOWN_REQUEST_ID, "bad_request", "request must be an object");
      }
      const request = message as Partial<WorkerRequest> & Record<string, unknown>;
      const requestId = request.requestId;
      if (typeof requestId !== "number" || !Number.isInteger(requestId) || requestId < 0) {
        return error(UNKNOWN_REQUEST_ID, "bad_request", "requestId must be a non-negative integer");
      }
      if (request.type !== "init" && request.type !== "compute" && request.type !== "generate") {
        return error(requestId, "bad_request", `unknown request type: ${String(request.type)}`);
      }

      try {
        const core = await getCore();
        switch (request.type) {
          case "init":
            return { response: { type: "ready", requestId, engine: WASM_ENGINE, info: core.info }, transfer: [] };
          case "compute": {
            if (request.columns === undefined) return error(requestId, "bad_request", "compute requires columns");
            const result = core.compute(request.columns as Columns, request.options);
            return { response: { type: "result", requestId, engine: WASM_ENGINE, result }, transfer: [] };
          }
          case "generate": {
            const columns = core.generate(request.options as never);
            const transfer = [columns.ids.buffer, columns.timestamps.buffer, columns.values.buffer, columns.eventTypeCodes.buffer, columns.categoryCodes.buffer] as ArrayBuffer[];
            return { response: { type: "generated", requestId, engine: WASM_ENGINE, columns }, transfer };
          }
        }
      } catch (err) {
        if (err instanceof InitFailure) return error(requestId, "init_failed", err.message);
        if (err instanceof WasmValidationError) return error(requestId, "validation", err.message);
        if (err instanceof WasmLimitError) return error(requestId, "limit", err.message);
        if (err instanceof WasmInternalError) return error(requestId, "internal", err.message);
        return error(requestId, "internal", describe(err));
      }
    },
  };
}

class InitFailure extends Error {}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
