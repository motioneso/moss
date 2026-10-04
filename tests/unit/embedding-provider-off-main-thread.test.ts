import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

// onnxruntime-node runs inference synchronously on the calling thread. This pipe does the same,
// so an in-process provider blocks the event loop exactly as production did (#3027).
const BLOCK_MS = 300;
const blockingPipe = Object.assign(
  async () => {
    const end = performance.now() + BLOCK_MS;
    while (performance.now() < end) {
      // Busy-wait on the caller's thread.
    }
    return { data: new Float32Array(768) };
  },
  { tokenizer: { model_max_length: 8192 } }
);

vi.mock("@huggingface/transformers", () => ({
  env: { cacheDir: ".cache" },
  pipeline: vi.fn(async () => blockingPipe)
}));

const ECHO_WORKER_URL = new URL("../fixtures/embedding-echo-worker.mjs", import.meta.url);

async function maxEventLoopDelayMs(work: () => Promise<unknown>): Promise<number> {
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

describe("local embeddings run off the main thread (#3027)", () => {
  afterEach(async () => {
    const memory = await import("../../packages/memory/src/local-embedding-provider.js");
    memory.setEmbeddingWorkerUrlForTests(undefined);
  });

  it("keeps the event loop responsive for the factory's local provider", async () => {
    const memory = await import("../../packages/memory/src/local-embedding-provider.js");
    const { createEmbeddingProvider } =
      await import("../../packages/memory/src/embedding-provider-config.js");
    memory.setEmbeddingWorkerUrlForTests(ECHO_WORKER_URL);
    const provider = createEmbeddingProvider({ kind: "local" }, { NODE_ENV: "test" }, () => {});

    const delay = await maxEventLoopDelayMs(async () => {
      for (const text of ["one", "two", "three"]) await provider.embedDocument(text);
    });

    expect(delay).toBeLessThan(BLOCK_MS / 2);
  });

  it("replaces a crashed embedding worker instead of hanging later calls", async () => {
    const memory = await import("../../packages/memory/src/local-embedding-provider.js");
    const provider = new memory.CpuIsolatedEmbeddingProvider("crash-model", ECHO_WORKER_URL);

    await expect(provider.embedDocument("crash")).rejects.toThrow(/exited/);
    await expect(provider.embedDocument("after")).resolves.toEqual([5]);
  }, 5_000);
});
