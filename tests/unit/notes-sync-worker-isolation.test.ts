import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";

import { CpuIsolatedEmbeddingProvider } from "../../packages/memory/src/local-embedding-provider.js";

async function measureMaxEventLoopDelay(work: () => Promise<void>): Promise<number> {
  let maxDelay = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxDelay = Math.max(maxDelay, now - last - 10);
    last = now;
  }, 10);

  await work();
  await new Promise((resolve) => setTimeout(resolve, 20));
  clearInterval(timer);
  return maxDelay;
}

describe("notes.sync embedding CPU isolation (#1590)", () => {
  it("keeps the event loop responsive during representative inference", async () => {
    const provider = new CpuIsolatedEmbeddingProvider(
      "test-model",
      new URL("../fixtures/embedding-cpu-worker.mjs", import.meta.url)
    );

    const maxDelay = await measureMaxEventLoopDelay(() =>
      Promise.all(
        Array.from({ length: 4 }, (_, index) => provider.embedDocument(`chunk-${index}`))
      ).then(() => undefined)
    );

    expect(maxDelay).toBeLessThan(1000);
  });
});
