import { parentPort } from "node:worker_threads";

parentPort?.on("message", ({ pattern, value }) => {
  let result;
  try {
    // The pattern and value are data, never source. The host terminates this worker
    // if V8 spends too long in RegExp.test().
    new RegExp(pattern, "u");
    result = new RegExp(`^(?:${pattern})$`, "u").test(value);
    if (typeof result !== "boolean") result = false;
  } catch {
    result = false;
  }

  parentPort?.postMessage(result);
});
