import { parentPort, workerData } from "node:worker_threads";

let result;
try {
  // The pattern and value are data, never source. The host terminates this worker
  // if V8 spends too long in RegExp.test().
  new RegExp(workerData.pattern, "u");
  result = new RegExp(`^(?:${workerData.pattern})$`, "u").test(workerData.value);
  if (typeof result !== "boolean") result = false;
} catch {
  result = false;
}

parentPort?.postMessage(result);
parentPort?.close();
