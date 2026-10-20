/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { computeAnalytics, generateEvents } from "../../../api/src/analytics/index.js";
import { WasmAnalyticsClient, WasmEngineError, type WorkerLike } from "./client.js";
import type { HpaCore } from "./hpaCore.js";
import { packColumns } from "./packColumns.js";
import { WASM_ENGINE, type Columns, type HpaCoreInfo } from "./types.js";
import { createWorkerHandler, type WorkerHandler } from "./workerHandler.js";
import { describeWasm, expectIdentical, getCore } from "./support.testing.js";

type Listener = (event: unknown) => void;

/**
 * A worker double that runs a WorkerHandler in-process but keeps the real postMessage semantics:
 * messages are structured-cloned and listed buffers are TRANSFERRED (detached in the sender).
 */
class LoopbackWorker implements WorkerLike {
  readonly listeners: Record<string, Listener[]> = { message: [], error: [], messageerror: [] };
  terminated = false;
  readonly received: unknown[] = [];
  constructor(
    private readonly handler: WorkerHandler,
    private readonly delayMs: (message: { requestId: number }) => number = () => 0,
  ) {}

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    const cloned = structuredClone(message, { transfer }) as { requestId: number };
    this.received.push(cloned);
    setTimeout(() => {
      if (this.terminated) return;
      void this.handler.handle(cloned).then(({ response, transfer: back }) => {
        if (this.terminated) return;
        this.emit("message", { data: structuredClone(response, { transfer: back }) });
      });
    }, this.delayMs(cloned));
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: "message" | "error" | "messageerror", listener: Listener): void {
    this.listeners[type]!.push(listener);
  }
  emit(type: "message" | "error" | "messageerror", event: unknown): void {
    for (const l of this.listeners[type]!) l(event);
  }
}

/** A worker that never answers on its own; tests drive it by hand. */
class SilentWorker extends LoopbackWorker {
  constructor() {
    super({ handle: async () => new Promise(() => undefined) });
  }
}

const INFO: HpaCoreInfo = { coreVersion: "1.2.3", abiVersion: 1, eventStructBytes: 48, maxEvents: 1_000_000 };
const fakeCore = (compute: (columns: Columns, options?: unknown) => unknown = () => ({ marker: "ok" })): HpaCore =>
  ({ info: INFO, compute, generate: () => packColumns(generateEvents({ seed: 1, count: 4 })) }) as unknown as HpaCore;

const clientFor = (core: HpaCore, options?: { requestTimeoutMs?: number }) =>
  new WasmAnalyticsClient(() => new LoopbackWorker(createWorkerHandler({ loadCore: async () => core })), options);

describe("WasmAnalyticsClient: normal operation", () => {
  it("initialises and reports the engine and module info", async () => {
    const client = clientFor(fakeCore());
    expect(await client.init()).toEqual({ engine: WASM_ENGINE, info: INFO });
  });

  it("creates the worker lazily, on the first request", async () => {
    const create = vi.fn(() => new LoopbackWorker(createWorkerHandler({ loadCore: async () => fakeCore() })));
    const client = new WasmAnalyticsClient(create);
    expect(create).not.toHaveBeenCalled();
    await client.init();
    await client.compute(packColumns([]));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("always reports which engine produced a result", async () => {
    const client = clientFor(fakeCore());
    const outcome = await client.compute(packColumns([]));
    expect(outcome).toEqual({ engine: "wasm", result: { marker: "ok" } });
    expect((await client.generate({ seed: 1, count: 4 })).engine).toBe("wasm");
  });

  it("matches every response to its own request when requests overlap and finish out of order", async () => {
    // The fake core reports how many events it received; later requests answer first.
    const core = fakeCore((columns) => ({ count: columns.ids.length }));
    const client = new WasmAnalyticsClient(
      () => new LoopbackWorker(createWorkerHandler({ loadCore: async () => core }), (m) => (20 - m.requestId) * 3),
    );
    await client.init();
    const sizes = Array.from({ length: 12 }, (_, i) => i + 1);
    const outcomes = await Promise.all(sizes.map((n) => client.compute(packColumns(generateEvents({ seed: n, count: n })))));
    expect(outcomes.map((o) => (o.result as unknown as { count: number }).count)).toEqual(sizes);
  });

  it("packs event objects for computeEvents", async () => {
    const seen: Columns[] = [];
    const client = clientFor(fakeCore((columns) => { seen.push(columns); return {}; }));
    await client.computeEvents(generateEvents({ seed: 3, count: 6 }));
    expect(seen[0]!.ids).toHaveLength(6);
    expect(seen[0]!.categories.length).toBeGreaterThan(0);
  });
});

describe("WasmAnalyticsClient: ownership of typed arrays", () => {
  it("transfers buffers that a view covers entirely (the caller's arrays are detached)", async () => {
    const client = clientFor(fakeCore((columns) => ({ received: columns.ids.length })));
    const columns = packColumns(generateEvents({ seed: 1, count: 25 }));
    const { ids, values } = columns;
    const outcome = await client.compute(columns);
    expect((outcome.result as unknown as { received: number }).received).toBe(25); // the worker got the data
    expect(ids.byteLength).toBe(0);
    expect(values.byteLength).toBe(0);
  });

  it("copies a partial view instead of detaching or sending its whole buffer", async () => {
    let receivedBytes = -1;
    const client = clientFor(fakeCore((columns) => { receivedBytes = columns.ids.buffer.byteLength; return {}; }));
    const base = packColumns(generateEvents({ seed: 1, count: 10 }));
    const big = new Float64Array(1000).fill(7);
    big.set(base.ids, 100);
    const view = big.subarray(100, 110);
    await client.compute({ ...base, ids: view });
    expect(big.byteLength).toBe(8000); // the caller's large buffer is untouched, not detached
    expect(big[0]).toBe(7);
    expect(receivedBytes).toBe(80); // only the viewed 10 doubles travelled
  });

  it("handles two views of one buffer without a duplicate-transfer error", async () => {
    const client = clientFor(fakeCore());
    const base = packColumns(generateEvents({ seed: 1, count: 4 }));
    const shared = new Float64Array(4);
    await expect(client.compute({ ...base, ids: shared, timestamps: shared, values: shared })).resolves.toMatchObject({ engine: "wasm" });
  });
});

describe("WasmAnalyticsClient: failures", () => {
  it("reports an initialisation failure as an error naming the wasm engine, for init and later requests", async () => {
    const loader = vi.fn(async (): Promise<HpaCore> => { throw new Error("hpa_core.wasm failed to compile"); });
    const client = new WasmAnalyticsClient(() => new LoopbackWorker(createWorkerHandler({ loadCore: loader })));
    const failure = await client.init().then(() => undefined, (e: unknown) => e);
    expect(failure).toBeInstanceOf(WasmEngineError);
    expect(failure).toMatchObject({ engine: "wasm", kind: "init_failed" });
    expect((failure as Error).message).toContain("hpa_core.wasm failed to compile");
    await expect(client.compute(packColumns([]))).rejects.toMatchObject({ kind: "init_failed", engine: "wasm" });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["validation", "events[0].id must be an integer between 0 and 9007199254740991"],
    ["limit", "events must contain at most 1000000 items for the WebAssembly engine"],
    ["internal", "out of WebAssembly memory"],
  ] as const)("surfaces a %s error from the worker with its message", async (kind, message) => {
    const worker = new LoopbackWorker({ handle: async (m) => ({ response: { type: "error", requestId: (m as { requestId: number }).requestId, engine: "wasm", kind, message }, transfer: [] }) });
    const client = new WasmAnalyticsClient(() => worker);
    await expect(client.compute(packColumns([]))).rejects.toMatchObject({ kind, message, engine: "wasm" });
  });

  it("rejects pending requests when the worker raises an error event, then starts a fresh worker", async () => {
    const workers: LoopbackWorker[] = [];
    const client = new WasmAnalyticsClient(() => {
      const w = workers.length === 0 ? new SilentWorker() : new LoopbackWorker(createWorkerHandler({ loadCore: async () => fakeCore() }));
      workers.push(w);
      return w;
    });
    const first = client.compute(packColumns([]));
    const second = client.init();
    workers[0]!.emit("error", { message: "wasm trap: unreachable" });
    await expect(first).rejects.toMatchObject({ kind: "worker_error", message: expect.stringContaining("wasm trap: unreachable") });
    await expect(second).rejects.toMatchObject({ kind: "worker_error" });
    expect(workers[0]!.terminated).toBe(true);
    expect((await client.compute(packColumns([]))).engine).toBe("wasm");
    expect(workers).toHaveLength(2);
  });

  it("treats an undeserialisable message as a worker failure", async () => {
    const worker = new SilentWorker();
    const client = new WasmAnalyticsClient(() => worker);
    const pending = client.init();
    worker.emit("messageerror", {});
    await expect(pending).rejects.toMatchObject({ kind: "worker_error" });
  });

  it("times out, terminates the stuck worker and recovers on the next request", async () => {
    const workers: LoopbackWorker[] = [];
    const client = new WasmAnalyticsClient(
      () => {
        const w = workers.length === 0 ? new SilentWorker() : new LoopbackWorker(createWorkerHandler({ loadCore: async () => fakeCore() }));
        workers.push(w);
        return w;
      },
      { requestTimeoutMs: 40 },
    );
    await expect(client.compute(packColumns([]))).rejects.toMatchObject({ kind: "timeout", engine: "wasm" });
    expect(workers[0]!.terminated).toBe(true);
    expect((await client.compute(packColumns([]))).engine).toBe("wasm");
  });

  it("ignores a late response from a worker it already discarded", async () => {
    const workers: LoopbackWorker[] = [];
    const client = new WasmAnalyticsClient(() => {
      const w = workers.length === 0 ? new SilentWorker() : new LoopbackWorker(createWorkerHandler({ loadCore: async () => fakeCore(() => ({ from: "second" })) }));
      workers.push(w);
      return w;
    });
    const stuck = client.compute(packColumns([]));
    workers[0]!.emit("error", { message: "crash" });
    await expect(stuck).rejects.toMatchObject({ kind: "worker_error" });
    const next = client.compute(packColumns([]));
    workers[0]!.emit("message", { data: { type: "result", requestId: 0, engine: "wasm", result: { from: "zombie" } } });
    expect((await next).result).toEqual({ from: "second" });
  });

  it("terminate() rejects what is in flight and everything afterwards", async () => {
    const client = new WasmAnalyticsClient(() => new SilentWorker());
    const inFlight = client.init();
    client.terminate();
    await expect(inFlight).rejects.toMatchObject({ kind: "terminated" });
    await expect(client.compute(packColumns([]))).rejects.toMatchObject({ kind: "terminated" });
  });

  it("reports an unavailable Worker implementation", async () => {
    const client = new WasmAnalyticsClient(() => { throw new Error("Worker is not defined"); });
    await expect(client.init()).rejects.toMatchObject({ kind: "worker_unavailable", engine: "wasm", message: expect.stringContaining("Worker is not defined") });
  });

  it("rejects when the request cannot be posted (for example it cannot be cloned)", async () => {
    const worker = new SilentWorker();
    worker.postMessage = () => { throw new DOMException("could not be cloned", "DataCloneError"); };
    const client = new WasmAnalyticsClient(() => worker);
    await expect(client.init()).rejects.toMatchObject({ kind: "worker_error", message: expect.stringContaining("could not be cloned") });
  });

  it.each([
    ["a response from another engine", { type: "result", requestId: 0, engine: "typescript", result: {} }],
    ["a response without an engine", { type: "result", requestId: 0, result: {} }],
    ["null", null],
    ["a string", "hello"],
    ["a response without a type", { requestId: 0, engine: "wasm" }],
  ])("treats %s as a protocol violation, rejects and discards the worker", async (_name, garbage) => {
    const worker = new SilentWorker();
    const client = new WasmAnalyticsClient(() => worker);
    const pending = client.init();
    worker.emit("message", { data: garbage });
    await expect(pending).rejects.toMatchObject({ kind: "protocol", engine: "wasm" });
    expect(worker.terminated).toBe(true);
  });

  it("rejects a response of the wrong type for the request", async () => {
    const worker = new LoopbackWorker({ handle: async (m) => ({ response: { type: "ready", requestId: (m as { requestId: number }).requestId, engine: "wasm", info: INFO }, transfer: [] }) });
    const client = new WasmAnalyticsClient(() => worker);
    await expect(client.compute(packColumns([]))).rejects.toMatchObject({ kind: "protocol" });
  });

  it("ignores a response with an unknown request id", async () => {
    const worker = new SilentWorker();
    const client = new WasmAnalyticsClient(() => worker, { requestTimeoutMs: 60 });
    const pending = client.init();
    worker.emit("message", { data: { type: "ready", requestId: 999, engine: "wasm", info: INFO } });
    await expect(pending).rejects.toMatchObject({ kind: "timeout" }); // it was not mistaken for our answer
  });
});

describeWasm("WasmAnalyticsClient with the real module behind the handler", () => {
  it("computes and generates through the full message path with exact parity", async () => {
    const core = await getCore();
    const client = clientFor(core);
    const events = generateEvents({ seed: 11, count: 5000 });
    const outcome = await client.computeEvents(events, { histogramBins: 9 });
    expect(outcome.engine).toBe("wasm");
    expectIdentical(outcome.result, computeAnalytics(events, { histogramBins: 9 }));

    const generated = await client.generate({ seed: 11, count: 5000 });
    expect(generated.columns.ids.length).toBe(5000);
    expect(generated.columns.ids.buffer.byteLength).toBe(5000 * 8); // transferred, intact
  });

  it("returns the TypeScript engine's validation message through the client", async () => {
    const client = clientFor(await getCore());
    const columns = packColumns([{ id: 1, timestamp: 1, eventType: "a", category: "b", value: Number.NaN }]);
    await expect(client.compute(columns)).rejects.toMatchObject({
      kind: "validation",
      message: "events[0].value must be a finite number with absolute value <= 1000000000000",
    });
  });
});
