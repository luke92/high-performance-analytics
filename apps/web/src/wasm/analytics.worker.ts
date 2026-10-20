/// <reference lib="webworker" />
// Entry point of the dedicated Web Worker that runs the WebAssembly analytics off the UI thread.
// All logic lives in workerHandler.ts; this file only connects it to the worker's message port.
import { loadHpaCore } from "./loadModule.js";
import { createWorkerHandler } from "./workerHandler.js";

const handler = createWorkerHandler({ loadCore: () => loadHpaCore() });

// DOM and WebWorker typings conflict in one program, so use the minimal shape of the worker scope.
const scope = self as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.addEventListener("message", (event: MessageEvent) => {
  void handler.handle(event.data).then(({ response, transfer }) => scope.postMessage(response, transfer));
});
