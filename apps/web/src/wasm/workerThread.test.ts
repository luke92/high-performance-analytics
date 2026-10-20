/// <reference types="node" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { computeAnalytics, generateEvents } from "../../../api/src/analytics/index.js";
import { WasmAnalyticsClient, type WorkerLike } from "./client.js";
import { packColumns } from "./packColumns.js";
import { describeWasm, expectIdentical } from "./support.testing.js";

/** Adapts a Node worker thread to the browser-style interface the client uses. */
class NodeWorkerAdapter implements WorkerLike {
  constructor(private readonly worker: Worker) {}
  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer as never);
  }
  terminate(): void {
    void this.worker.terminate();
  }
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: unknown) => void): void {
    if (type === "message") this.worker.on("message", (data) => listener({ data }));
    else if (type === "error") this.worker.on("error", (error: Error) => listener({ message: error.message }));
    else this.worker.on("messageerror", () => listener({}));
  }
}

const sourceEntry = fileURLToPath(new URL("./nodeWorkerEntry.testing.ts", import.meta.url));
const generatedModule = pathToFileURL(fileURLToPath(new URL("./generated/hpa_core.js", import.meta.url))).href;
const clients: WasmAnalyticsClient[] = [];
let bundleDir = "";
let entry = "";

// Worker threads cannot use tsx's .js -> .ts resolution, so run a bundled copy of the entry point.
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "hpa-worker-"));
  entry = join(bundleDir, "worker.mjs");
  await build({ entryPoints: [sourceEntry], bundle: true, format: "esm", platform: "node", outfile: entry, logLevel: "silent" });
});

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

function clientWith(mode: string, options?: { requestTimeoutMs?: number }): WasmAnalyticsClient {
  const client = new WasmAnalyticsClient(
    () => new NodeWorkerAdapter(new Worker(entry, { workerData: { mode, moduleUrl: generatedModule } })),
    options,
  );
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.terminate();
});

describe("real worker thread: failures (no WebAssembly module needed)", () => {
  it("reports a module that cannot be loaded and does not fall back to any other engine", async () => {
    const client = clientWith("missing-module");
    await expect(client.init()).rejects.toMatchObject({ kind: "init_failed", engine: "wasm", message: expect.stringContaining("has not been built") });
    await expect(client.compute(packColumns([]))).rejects.toMatchObject({ kind: "init_failed", engine: "wasm" });
  }, 30_000);

  it("reports a worker that crashes while starting", async () => {
    const client = clientWith("crash");
    await expect(client.init()).rejects.toMatchObject({ kind: "worker_error", engine: "wasm", message: expect.stringContaining("crashed during startup") });
  }, 30_000);
});

describeWasm("real worker thread with the WebAssembly module", () => {
  it("computes with exact parity, over real structured cloning and buffer transfer", async () => {
    const client = clientWith("normal");
    const ready = await client.init();
    expect(ready.engine).toBe("wasm");
    expect(ready.info.coreVersion).toMatch(/^\d+\.\d+\.\d+$/);

    const events = generateEvents({ seed: 21, count: 30_000 });
    const columns = packColumns(events);
    const idsBefore = columns.ids;
    const outcome = await client.compute(columns, { histogramBins: 16 });
    expect(outcome.engine).toBe("wasm");
    expect(idsBefore.byteLength).toBe(0); // really transferred to the other thread
    expectIdentical(outcome.result, computeAnalytics(events, { histogramBins: 16 }));
  }, 60_000);

  it("generates in the worker and receives transferred columns", async () => {
    const client = clientWith("normal");
    const { columns } = await client.generate({ seed: 42, count: 1000 });
    expect(columns.ids).toHaveLength(1000);
    expect(columns.eventTypes).toEqual(["view", "click", "add_to_cart", "purchase"]);
  }, 60_000);

  it("returns validation errors from the thread and keeps serving", async () => {
    const client = clientWith("normal");
    const bad = packColumns([{ id: -1, timestamp: 1, eventType: "a", category: "b", value: 1 }]);
    await expect(client.compute(bad)).rejects.toMatchObject({ kind: "validation", message: "events[0].id must be an integer between 0 and 9007199254740991" });
    await expect(client.compute(packColumns(generateEvents({ seed: 1, count: 10 })))).resolves.toMatchObject({ engine: "wasm" });
  }, 60_000);

  it("does not block the calling thread while a large computation runs", async () => {
    const client = clientWith("normal");
    await client.init(); // load the module first so the measurement covers computing only
    const columns = packColumns(generateEvents({ seed: 5, count: 400_000 }));
    let ticks = 0;
    const interval = setInterval(() => ticks++, 5);
    const started = performance.now();
    await client.compute(columns);
    const elapsed = performance.now() - started;
    clearInterval(interval);
    // A blocked main thread would tick ~0 times; a free one ticks roughly elapsed / 5.
    expect(elapsed).toBeGreaterThan(50);
    expect(ticks).toBeGreaterThan(elapsed / 5 / 4);
  }, 120_000);

  it("terminates a stuck worker on timeout and works again afterwards", async () => {
    const client = clientWith("normal", { requestTimeoutMs: 1 });
    await expect(client.init()).rejects.toMatchObject({ kind: "timeout", engine: "wasm" }); // 1 ms is too short to load
    const patient = clientWith("normal");
    await expect(patient.init()).resolves.toMatchObject({ engine: "wasm" });
  }, 60_000);
});
