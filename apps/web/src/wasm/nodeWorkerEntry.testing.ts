/// <reference types="node" />
// Test-only: runs the production WorkerHandler inside a real Node.js worker thread, so the messaging
// tests exercise a real thread, real structured cloning and real buffer transfer. The browser entry
// is analytics.worker.ts; this file only swaps the message port and the module loader. The test bundles
// it with esbuild first, because tsx cannot resolve `.js` -> `.ts` imports inside worker threads.
import { parentPort, workerData } from "node:worker_threads";
import { HpaCore } from "./hpaCore.js";
import { createWorkerHandler } from "./workerHandler.js";

const { mode = "normal", moduleUrl = "" } = (workerData ?? {}) as { mode?: string; moduleUrl?: string };
if (mode === "crash") throw new Error("worker crashed during startup");

const handler = createWorkerHandler({
  loadCore: async () => {
    if (mode === "missing-module") throw new Error("the WebAssembly module has not been built");
    // Same artifact the browser loads. The test passes its URL because this file runs as a bundled copy.
    const module = (await import(/* @vite-ignore */ moduleUrl)) as { default: never };
    return HpaCore.create(module.default);
  },
});

parentPort!.on("message", (message: unknown) => {
  void handler.handle(message).then(({ response, transfer }) => parentPort!.postMessage(response, transfer));
});
