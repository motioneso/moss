import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";

if (!parentPort) throw new Error("embedding CPU worker requires parentPort");

parentPort.on("message", ({ id }: { id: number }) => {
  const end = performance.now() + 1200;
  while (performance.now() < end) {
    // Deliberately model a synchronous native inference for the reproduction test.
  }
  parentPort!.postMessage({ id, embedding: [1, 2, 3] });
});
