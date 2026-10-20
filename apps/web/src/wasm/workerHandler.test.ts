/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { generateEvents } from "../../../api/src/analytics/index.js";
import { computeAnalytics } from "../../../api/src/analytics/index.js";
import { WasmInternalError, WasmLimitError, WasmValidationError, type HpaCore } from "./hpaCore.js";
import { packColumns } from "./packColumns.js";
import type { WorkerResponse } from "./protocol.js";
import type { Columns, HpaCoreInfo } from "./types.js";
import { createWorkerHandler } from "./workerHandler.js";
import { describeWasm, expectIdentical, getCore } from "./support.testing.js";

const INFO: HpaCoreInfo = { coreVersion: "9.9.9", abiVersion: 1, eventStructBytes: 48, maxEvents: 1000 };

/** A stand-in for HpaCore whose behaviour each test controls. */
function fakeCore(overrides: Partial<Record<"compute" | "generate", (...args: never[]) => unknown>> = {}): HpaCore {
  return { info: INFO, compute: overrides.compute ?? (() => ({ fake: "result" })), generate: overrides.generate ?? (() => emptyColumns()) } as unknown as HpaCore;
}
const emptyColumns = (): Columns => packColumns([]);

async function respond(handler: ReturnType<typeof createWorkerHandler>, message: unknown): Promise<WorkerResponse> {
  return (await handler.handle(message)).response;
}

describe("worker handler: initialisation", () => {
  it("loads the module lazily, once, even for concurrent first requests", async () => {
    const loadCore = vi.fn(async () => fakeCore());
    const handler = createWorkerHandler({ loadCore });
    expect(loadCore).not.toHaveBeenCalled(); // creating the worker handler must not start loading
    const responses = await Promise.all([1, 2, 3].map((requestId) => respond(handler, { type: "init", requestId })));
    expect(loadCore).toHaveBeenCalledTimes(1);
    expect(responses.map((r) => r.requestId)).toEqual([1, 2, 3]);
    for (const r of responses) expect(r).toEqual({ type: "ready", requestId: r.requestId, engine: "wasm", info: INFO });
  });

  it("reports a load failure on every request and never retries or falls back", async () => {
    const loadCore = vi.fn(async (): Promise<HpaCore> => {
      throw new Error("404 hpa_core.wasm");
    });
    const handler = createWorkerHandler({ loadCore });
    const messages = [
      { type: "init", requestId: 0 },
      { type: "compute", requestId: 1, columns: emptyColumns() },
      { type: "generate", requestId: 2, options: { seed: 1, count: 1 } },
    ];
    for (const message of messages) {
      const response = await respond(handler, message);
      expect(response).toMatchObject({ type: "error", requestId: message.requestId, engine: "wasm", kind: "init_failed" });
      expect((response as { message: string }).message).toContain("404 hpa_core.wasm");
    }
    expect(loadCore).toHaveBeenCalledTimes(1);
  });

  it("describes a non-Error load failure", async () => {
    const handler = createWorkerHandler({ loadCore: () => Promise.reject("boom") });
    expect(await respond(handler, { type: "init", requestId: 0 })).toMatchObject({ kind: "init_failed", message: expect.stringContaining("boom") });
  });
});

describe("worker handler: request validation", () => {
  const handler = createWorkerHandler({ loadCore: async () => fakeCore() });

  it.each([null, undefined, 5, "init", true])("rejects a non-object message: %j", async (message) => {
    expect(await respond(handler, message)).toEqual({ type: "error", requestId: -1, engine: "wasm", kind: "bad_request", message: "request must be an object" });
  });

  it.each([{}, { type: "init" }, { type: "init", requestId: -1 }, { type: "init", requestId: 1.5 }, { type: "init", requestId: "1" }, { type: "init", requestId: NaN }])(
    "rejects a missing or invalid requestId: %j",
    async (message) => {
      expect(await respond(handler, message)).toMatchObject({ requestId: -1, kind: "bad_request", message: "requestId must be a non-negative integer" });
    },
  );

  it("rejects unknown request types but still echoes the requestId", async () => {
    expect(await respond(handler, { type: "format-disk", requestId: 7 })).toMatchObject({ requestId: 7, kind: "bad_request", message: "unknown request type: format-disk" });
    expect(await respond(handler, { type: undefined, requestId: 8 })).toMatchObject({ requestId: 8, kind: "bad_request" });
  });

  it("rejects compute without columns", async () => {
    expect(await respond(handler, { type: "compute", requestId: 3 })).toMatchObject({ requestId: 3, kind: "bad_request", message: "compute requires columns" });
  });

  it("does not expose arbitrary functions: only init, compute and generate exist", async () => {
    for (const type of ["eval", "_hpa_alloc", "constructor", "__proto__", "toString"]) {
      expect(await respond(handler, { type, requestId: 1 })).toMatchObject({ kind: "bad_request" });
    }
  });
});

describe("worker handler: results and error mapping", () => {
  it("returns compute results tagged with the engine, echoing the request id", async () => {
    const compute = vi.fn(() => ({ fake: "result" }));
    const handler = createWorkerHandler({ loadCore: async () => fakeCore({ compute }) });
    const columns = emptyColumns();
    const out = await handler.handle({ type: "compute", requestId: 41, columns, options: { histogramBins: 4 } });
    expect(out.response).toEqual({ type: "result", requestId: 41, engine: "wasm", result: { fake: "result" } });
    expect(out.transfer).toEqual([]);
    expect(compute).toHaveBeenCalledWith(columns, { histogramBins: 4 });
  });

  it("transfers the generated columns' buffers instead of copying them", async () => {
    const columns = packColumns(generateEvents({ seed: 1, count: 10 }));
    const handler = createWorkerHandler({ loadCore: async () => fakeCore({ generate: () => columns }) });
    const out = await handler.handle({ type: "generate", requestId: 1, options: { seed: 1, count: 10 } });
    expect(out.response).toMatchObject({ type: "generated", engine: "wasm" });
    expect(new Set(out.transfer)).toEqual(new Set([columns.ids.buffer, columns.timestamps.buffer, columns.values.buffer, columns.eventTypeCodes.buffer, columns.categoryCodes.buffer]));
  });

  it.each([
    ["validation", new WasmValidationError("events[0].value must be a finite number")],
    ["limit", new WasmLimitError("too many")],
    ["internal", new WasmInternalError("out of WebAssembly memory")],
    ["internal", new RangeError("unexpected")],
  ] as const)("maps %s failures to an error response", async (kind, error) => {
    const handler = createWorkerHandler({
      loadCore: async () => fakeCore({ compute: () => { throw error; }, generate: () => { throw error; } }),
    });
    for (const message of [{ type: "compute", requestId: 5, columns: emptyColumns() }, { type: "generate", requestId: 6, options: {} }]) {
      expect(await respond(handler, message)).toEqual({ type: "error", requestId: message.requestId, engine: "wasm", kind, message: error.message });
    }
  });

  it("keeps serving after a failed request", async () => {
    let calls = 0;
    const handler = createWorkerHandler({ loadCore: async () => fakeCore({ compute: () => { if (calls++ === 0) throw new WasmValidationError("bad"); return { ok: true }; } }) });
    expect(await respond(handler, { type: "compute", requestId: 1, columns: emptyColumns() })).toMatchObject({ kind: "validation" });
    expect(await respond(handler, { type: "compute", requestId: 2, columns: emptyColumns() })).toMatchObject({ type: "result", result: { ok: true } });
  });
});

describeWasm("worker handler with the real WebAssembly module", () => {
  it("computes, matching the TypeScript engine, and tags the engine", async () => {
    const core = await getCore();
    const handler = createWorkerHandler({ loadCore: async () => core });
    const events = generateEvents({ seed: 7, count: 2000 });
    const response = await respond(handler, { type: "compute", requestId: 1, columns: packColumns(events), options: { histogramBins: 12 } });
    expect(response).toMatchObject({ type: "result", engine: "wasm", requestId: 1 });
    expectIdentical((response as { result: unknown }).result, computeAnalytics(events, { histogramBins: 12 }));
  });

  it("returns validation errors with the TypeScript message", async () => {
    const core = await getCore();
    const handler = createWorkerHandler({ loadCore: async () => core });
    const columns = packColumns([{ id: 1, timestamp: 1, eventType: "a", category: "b", value: Number.NaN }]);
    expect(await respond(handler, { type: "compute", requestId: 2, columns })).toEqual({
      type: "error", requestId: 2, engine: "wasm", kind: "validation",
      message: "events[0].value must be a finite number with absolute value <= 1000000000000",
    });
  });

  it("generates seeded columns", async () => {
    const core = await getCore();
    const handler = createWorkerHandler({ loadCore: async () => core });
    const out = await handler.handle({ type: "generate", requestId: 3, options: { seed: 42, count: 5 } });
    expect(out.response).toMatchObject({ type: "generated", engine: "wasm" });
    expect(out.transfer).toHaveLength(5);
  });
});
