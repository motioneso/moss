import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";

if (!parentPort) throw new Error("embedding echo worker requires parentPort");

parentPort.on("message", ({ id, text }) => {
  // A "crash" request kills this worker thread so a test can watch the client replace it.
  if (text === "crash") process.exit(1);
  const end = performance.now() + 300;
  while (performance.now() < end) {
    // Models a synchronous native inference, on this thread only.
  }
  parentPort.postMessage({ id, embedding: [text.length] });
});
