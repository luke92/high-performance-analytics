import { packColumns } from "./packColumns.js";
import type { ErrorKind, WorkerRequest, WorkerResponse } from "./protocol.js";
import { WASM_ENGINE, type AnalyticsResult, type Columns, type ComputeOptions, type EngineName, type GenerateOptions, type HpaCoreInfo } from "./types.js";
import type { AnalyticsEvent } from "../../../api/src/analytics/types.js";

/** The part of the Worker interface the client uses (also implemented by test doubles). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  // The event type differs between browsers, Node worker_threads and test doubles, hence `any`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
}

/** Why a request failed on the client side, in addition to the worker's own ErrorKind values. */
export type ClientErrorKind =
  | ErrorKind
  /** No Worker could be created (unsupported environment or blocked). */
  | "worker_unavailable"
  /** The worker raised an error event or sent an undeserialisable message; it was discarded. */
  | "worker_error"
  /** No response within the timeout; the worker was terminated and will be recreated on demand. */
  | "timeout"
  /** The client was terminated. */
  | "terminated"
  /** The worker sent something that is not a valid response from the WebAssembly engine. */
  | "protocol";

/** Every failure names the engine it concerns; nothing falls back to another engine. */
export class WasmEngineError extends Error {
  override readonly name = "WasmEngineError";
  readonly engine: EngineName = WASM_ENGINE;
  constructor(
    readonly kind: ClientErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  /** Per-request timeout in milliseconds (default 60000). */
  requestTimeoutMs?: number;
}

export interface ComputeOutcome {
  engine: EngineName;
  result: AnalyticsResult;
}
export interface GenerateOutcome {
  engine: EngineName;
  columns: Columns;
}
export interface ReadyOutcome {
  engine: EngineName;
  info: HpaCoreInfo;
}

interface Pending {
  resolve(response: WorkerResponse): void;
  reject(error: WasmEngineError): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Main-thread client of the WebAssembly worker. The worker is created lazily and recreated after a
 * crash or timeout; requests are matched to responses by id, so they may overlap. All methods are
 * asynchronous and never block the UI thread.
 */
export class WasmAnalyticsClient {
  private worker: WorkerLike | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private terminated = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly createWorker: () => WorkerLike,
    options: ClientOptions = {},
  ) {
    this.timeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  /** Loads the module in the worker now (optional: the other methods do it on demand). */
  async init(): Promise<ReadyOutcome> {
    const response = await this.request({ type: "init" });
    if (response.type !== "ready") throw this.protocolError(response);
    return { engine: response.engine, info: response.info };
  }

  /**
   * Computes analytics for columns. The columns' ArrayBuffers are TRANSFERRED to the worker and become
   * unusable (byteLength 0) here when a view covers its whole buffer; a view onto part of a larger buffer
   * is copied first, so the rest of that buffer stays intact.
   */
  async compute(columns: Columns, options?: ComputeOptions): Promise<ComputeOutcome> {
    const { owned, transfer } = takeOwnership(columns);
    const response = await this.request({ type: "compute", columns: owned, ...(options ? { options } : {}) }, transfer);
    if (response.type !== "result") throw this.protocolError(response);
    return { engine: response.engine, result: response.result };
  }

  /** Convenience: packs event objects into columns on this thread, then computes. */
  computeEvents(events: readonly AnalyticsEvent[], options?: ComputeOptions): Promise<ComputeOutcome> {
    return this.compute(packColumns(events), options);
  }

  /** Generates a seeded dataset in the worker; the returned columns' buffers are transferred to the caller. */
  async generate(options: GenerateOptions): Promise<GenerateOutcome> {
    const response = await this.request({ type: "generate", options });
    if (response.type !== "generated") throw this.protocolError(response);
    return { engine: response.engine, columns: response.columns };
  }

  /** Stops the worker. Pending and later requests reject with kind "terminated". */
  terminate(): void {
    this.terminated = true;
    this.discardWorker(new WasmEngineError("terminated", "the WebAssembly client was terminated"));
  }

  // ---- internals ----

  private request(body: DistributiveOmit<WorkerRequest, "requestId">, transfer: Transferable[] = []): Promise<WorkerResponse> {
    if (this.terminated) return Promise.reject(new WasmEngineError("terminated", "the WebAssembly client was terminated"));
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      return Promise.reject(new WasmEngineError("worker_unavailable", `could not start the WebAssembly worker: ${describe(err)}`));
    }
    const requestId = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A stuck computation cannot be cancelled inside a worker: discard the whole worker.
        this.discardWorker(new WasmEngineError("timeout", `no response from the WebAssembly worker within ${this.timeoutMs} ms; it was terminated`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        worker.postMessage({ ...body, requestId } as WorkerRequest, transfer);
      } catch (err) {
        this.settle(requestId)?.reject(new WasmEngineError("worker_error", `could not send the request: ${describe(err)}`));
      }
    });
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.addEventListener("message", (event: { data: unknown }) => this.onMessage(worker, event.data));
    worker.addEventListener("error", (event: { message?: string } | undefined) => {
      this.discardWorkerIf(worker, new WasmEngineError("worker_error", `the WebAssembly worker failed: ${event?.message ?? "unknown error"}`));
    });
    worker.addEventListener("messageerror", () => {
      this.discardWorkerIf(worker, new WasmEngineError("worker_error", "the WebAssembly worker sent a message that could not be deserialised"));
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(from: WorkerLike, data: unknown): void {
    if (from !== this.worker) return; // late message from a discarded worker
    const response = data as Partial<WorkerResponse> | null;
    const valid =
      typeof response === "object" && response !== null && response.engine === WASM_ENGINE && typeof response.requestId === "number" && typeof response.type === "string";
    if (!valid) {
      this.discardWorker(new WasmEngineError("protocol", "the worker sent a message that is not a valid response of the WebAssembly engine"));
      return;
    }
    const pending = this.settle(response.requestId as number);
    if (!pending) return; // unknown id (for example already timed out): ignore
    if (response.type === "error") {
      pending.reject(new WasmEngineError(response.kind as ErrorKind, response.message as string));
    } else {
      pending.resolve(response as WorkerResponse);
    }
  }

  private settle(requestId: number): Pending | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    return pending;
  }

  private discardWorkerIf(worker: WorkerLike, reason: WasmEngineError): void {
    if (worker === this.worker) this.discardWorker(reason);
  }

  /** Terminates the current worker and rejects everything in flight; the next request starts a new one. */
  private discardWorker(reason: WasmEngineError): void {
    const worker = this.worker;
    this.worker = undefined;
    try {
      worker?.terminate();
    } catch {
      /* already gone */
    }
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(reason);
  }

  private protocolError(response: WorkerResponse): WasmEngineError {
    return new WasmEngineError("protocol", `unexpected response type '${response.type}'`);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decides, per typed array, whether its buffer can be transferred. A view that covers its whole buffer is
 * transferred (zero-copy). A view onto part of a larger buffer is copied into a fresh exact-size buffer
 * first, so we neither detach nor clone the unrelated rest of the caller's buffer.
 */
function takeOwnership(columns: Columns): { owned: Columns; transfer: ArrayBuffer[] } {
  const transfer = new Set<ArrayBuffer>();
  const own = <T extends Float64Array | Uint16Array>(view: T): T => {
    const covers = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength;
    const result = covers ? view : (view.slice() as T);
    transfer.add(result.buffer as ArrayBuffer);
    return result;
  };
  const owned: Columns = {
    ids: own(columns.ids),
    timestamps: own(columns.timestamps),
    values: own(columns.values),
    eventTypeCodes: own(columns.eventTypeCodes),
    categoryCodes: own(columns.categoryCodes),
    eventTypes: columns.eventTypes,
    categories: columns.categories,
  };
  return { owned, transfer: [...transfer] };
}
