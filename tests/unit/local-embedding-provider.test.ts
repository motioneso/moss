import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const CROSS_PROCESS_DIR = process.env.MOSS_EMBED_CROSS_PROCESS_TEST_DIR;
const CROSS_PROCESS_ROLE = process.env.MOSS_EMBED_CROSS_PROCESS_TEST_ROLE;
const CROSS_PROCESS_SCENARIO = process.env.MOSS_EMBED_CROSS_PROCESS_TEST_SCENARIO;

const embeddingLockAddress = async (cacheDir: string, modelId: string): Promise<string> => {
  const canonicalCacheDir = await realpath(cacheDir);
  const digest = createHash("sha256")
    .update(canonicalCacheDir)
    .update("\0")
    .update(modelId)
    .digest("hex");
  return `\0moss-embed-${digest}`;
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
};

const canListen = async (address: string): Promise<boolean> => {
  const server = createServer();
  return new Promise<boolean>((resolvePromise, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolvePromise(false);
      else reject(error);
    });
    server.listen(address, async () => {
      try {
        await closeServer(server);
        resolvePromise(true);
      } catch (error) {
        reject(error);
      }
    });
  });
};

/**
 * #1355: every embedding job constructed its own provider, and the provider cached its loaded
 * model per instance — so each job loaded a fresh fp32 ONNX model whose native memory was never
 * reclaimed. The prod worker ballooned to ~25 GB and the kernel OOM killer took it down.
 *
 * These tests pin the sharing contract: one load per model id for the life of the process,
 * regardless of how many providers get constructed.
 */

/**
 * Stand-in for the feature-extraction pipeline; returns a fixed two-dim vector.
 *
 * It carries a `tokenizer` because the real one does, and because #1359 makes that object the only
 * place a caller can bound sequence length. `model_max_length` starts at nomic's advertised 8192 so
 * a test that asserts the bound is observing a real change rather than a value we pre-set.
 */
const fakePipe = Object.assign(
  vi.fn(async (_text: string, _options: Record<string, unknown>) => ({
    data: Float32Array.from([0.25, 0.75])
  })),
  { tokenizer: { model_max_length: 8192 } }
);
const pipelineMock = vi.fn(async (_task: string, _modelId: string) => {
  if (CROSS_PROCESS_DIR && CROSS_PROCESS_ROLE) {
    if (CROSS_PROCESS_SCENARIO === "crash-owner") {
      await writeFile(join(CROSS_PROCESS_DIR, "owner-entered"), "");
      await new Promise(() => undefined);
    }

    if (CROSS_PROCESS_SCENARIO === "concurrent") {
      const activeDir = join(CROSS_PROCESS_DIR, "pipeline-active");
      try {
        await mkdir(activeDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("model load failed: protobuf parse collision", { cause: error });
        }
        throw error;
      }
      try {
        await writeFile(join(CROSS_PROCESS_DIR, `pipeline-entered-${CROSS_PROCESS_ROLE}`), "");
        await waitFor(() =>
          existsSync(join(CROSS_PROCESS_DIR, `pipeline-release-${CROSS_PROCESS_ROLE}`))
        );
      } finally {
        await rm(activeDir, { force: true, recursive: true });
      }
    }
  }
  return fakePipe;
});

vi.mock("@huggingface/transformers", () => ({
  env: { cacheDir: CROSS_PROCESS_DIR ? join(CROSS_PROCESS_DIR, "cache") : ".cache" },
  pipeline: pipelineMock
}));

const importProvider = async () => import("../../packages/memory/src/local-embedding-provider.js");

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("cross-process test barrier timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
};

interface SpawnedTestChild {
  readonly child: ChildProcess;
  readonly completed: Promise<{ code: number | null; stderr: string }>;
}

const spawnTestChild = (dir: string, scenario: string, role: string): SpawnedTestChild => {
  const testFile = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "--pool=threads",
      testFile,
      "-t",
      "embedding cache lock child"
    ],
    {
      env: {
        ...process.env,
        MOSS_EMBED_CROSS_PROCESS_TEST_DIR: dir,
        MOSS_EMBED_CROSS_PROCESS_TEST_ROLE: role,
        MOSS_EMBED_CROSS_PROCESS_TEST_SCENARIO: scenario
      },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 8_192) stderr += String(chunk);
  });
  return {
    child,
    completed: new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolvePromise({ code, stderr }));
    })
  };
};

const terminateChildren = async (children: readonly SpawnedTestChild[]): Promise<void> => {
  for (const { child } of children) child.kill("SIGKILL");
  await Promise.allSettled(children.map(({ completed }) => completed));
};

if (CROSS_PROCESS_DIR && CROSS_PROCESS_ROLE) {
  describe("embedding cache lock child", () => {
    it("embedding cache lock child", async () => {
      await mkdir(join(CROSS_PROCESS_DIR, "cache"), { recursive: true });

      const { LocalEmbeddingProvider } = await importProvider();

      if (CROSS_PROCESS_SCENARIO === "concurrent") {
        await writeFile(join(CROSS_PROCESS_DIR, `imported-${CROSS_PROCESS_ROLE}`), "");
        await waitFor(() => existsSync(join(CROSS_PROCESS_DIR, "start")));
        await writeFile(join(CROSS_PROCESS_DIR, `calling-${CROSS_PROCESS_ROLE}`), "");
        await waitFor(
          () =>
            existsSync(join(CROSS_PROCESS_DIR, "calling-a")) &&
            existsSync(join(CROSS_PROCESS_DIR, "calling-b"))
        );
      }

      await new LocalEmbeddingProvider("cross-process-model").embedDocument("fixture");
    });
  });
} else {
  describe("LocalEmbeddingProvider cross-process cache population (#1556)", () => {
    it("serializes first pipeline load across OS processes", async () => {
      const dir = await mkdtemp(join(tmpdir(), "moss-embed-lock-"));
      const children: SpawnedTestChild[] = [];
      try {
        const first = spawnTestChild(dir, "concurrent", "a");
        children.push(first);
        const second = spawnTestChild(dir, "concurrent", "b");
        children.push(second);
        await waitFor(
          () => existsSync(join(dir, "imported-a")) && existsSync(join(dir, "imported-b")),
          15_000
        );
        await writeFile(join(dir, "start"), "");
        await waitFor(
          () => existsSync(join(dir, "calling-a")) && existsSync(join(dir, "calling-b"))
        );
        await waitFor(
          () =>
            existsSync(join(dir, "pipeline-entered-a")) ||
            existsSync(join(dir, "pipeline-entered-b"))
        );

        const firstRole = existsSync(join(dir, "pipeline-entered-a")) ? "a" : "b";
        const secondRole = firstRole === "a" ? "b" : "a";
        expect(
          await canListen(await embeddingLockAddress(join(dir, "cache"), "cross-process-model"))
        ).toBe(false);

        await writeFile(join(dir, `pipeline-release-${firstRole}`), "");
        await waitFor(() => existsSync(join(dir, `pipeline-entered-${secondRole}`)));
        await writeFile(join(dir, `pipeline-release-${secondRole}`), "");

        const results = await Promise.all([first.completed, second.completed]);
        expect(
          results.map(({ code }) => code),
          results.map(({ stderr }) => stderr).join("\n")
        ).toEqual([0, 0]);
      } finally {
        await terminateChildren(children);
        await rm(dir, { force: true, recursive: true });
      }
    }, 20_000);

    it("recovers when the process holding the cache load lock is killed", async () => {
      const dir = await mkdtemp(join(tmpdir(), "moss-embed-lock-crash-"));
      const owner = spawnTestChild(dir, "crash-owner", "owner");
      const children: SpawnedTestChild[] = [owner];
      let follower: SpawnedTestChild | undefined;
      try {
        await waitFor(() => existsSync(join(dir, "owner-entered")), 15_000);
        expect(
          await canListen(await embeddingLockAddress(join(dir, "cache"), "cross-process-model"))
        ).toBe(false);
        owner.child.kill("SIGKILL");
        await owner.completed;

        follower = spawnTestChild(dir, "follower", "follower");
        children.push(follower);
        const result = await Promise.race([
          follower.completed,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("dead-owner recovery timed out")), 5_000)
          )
        ]);
        expect(result.code, result.stderr).toBe(0);
      } finally {
        await terminateChildren(children);
        await rm(dir, { force: true, recursive: true });
      }
    }, 25_000);
  });
}

describe("LocalEmbeddingProvider model cache (#1355)", () => {
  beforeEach(async () => {
    const { resetEmbeddingPipelineCacheForTests } = await importProvider();
    resetEmbeddingPipelineCacheForTests();
    pipelineMock.mockClear();
    fakePipe.mockClear();
    fakePipe.tokenizer = { model_max_length: 8192 };
  });

  it("loads the model once across separate provider instances", async () => {
    const { LocalEmbeddingProvider } = await importProvider();

    // Mirrors production: createEmbeddingProvider hands out a new instance per job.
    await new LocalEmbeddingProvider("model-a").embedDocument("first job");
    await new LocalEmbeddingProvider("model-a").embedDocument("second job");
    await new LocalEmbeddingProvider("model-a").embedQuery("third job");

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", "model-a");
    expect(fakePipe).toHaveBeenCalledTimes(3);
  });

  it("loads once per distinct model id", async () => {
    const { LocalEmbeddingProvider } = await importProvider();

    await new LocalEmbeddingProvider("model-a").embedDocument("a");
    await new LocalEmbeddingProvider("model-b").embedDocument("b");
    await new LocalEmbeddingProvider("model-a").embedDocument("a again");

    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(pipelineMock.mock.calls.map((call) => call[1])).toEqual(["model-a", "model-b"]);
  });

  it("does not double-load when concurrent callers race the first load", async () => {
    const { LocalEmbeddingProvider } = await importProvider();

    await Promise.all([
      new LocalEmbeddingProvider("model-a").embedDocument("one"),
      new LocalEmbeddingProvider("model-a").embedDocument("two"),
      new LocalEmbeddingProvider("model-a").embedDocument("three")
    ]);

    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it("retries the load after a failure instead of caching the rejection forever", async () => {
    const { LocalEmbeddingProvider } = await importProvider();
    pipelineMock.mockRejectedValueOnce(new Error("cold download failed"));

    await expect(new LocalEmbeddingProvider("model-a").embedDocument("x")).rejects.toThrow(
      "cold download failed"
    );

    const vector = await new LocalEmbeddingProvider("model-a").embedDocument("x");

    expect(vector).toEqual([0.25, 0.75]);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it("still prefixes the text by task, so pooled vectors stay comparable", async () => {
    const { LocalEmbeddingProvider } = await importProvider();
    const provider = new LocalEmbeddingProvider("model-a");

    await provider.embedDocument("hello");
    await provider.embedQuery("hello");

    expect(fakePipe.mock.calls.map((call) => call[0])).toEqual([
      "search_document: hello",
      "search_query: hello"
    ]);
  });
});

describe("embedding cache load lock", () => {
  it("releases ownership when the loader throws synchronously", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moss-embed-lock-sync-throw-"));
    const modelId = "sync-throw-model";
    try {
      const { withEmbeddingCacheLoadLock } =
        await import("../../packages/memory/src/embedding-cache-lock.js");
      await expect(
        withEmbeddingCacheLoadLock(dir, modelId, () => {
          throw new Error("synchronous pipeline failure");
        })
      ).rejects.toThrow("synchronous pipeline failure");
      expect(await canListen(await embeddingLockAddress(dir, modelId))).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("releases ownership when the loader rejects asynchronously", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moss-embed-lock-async-throw-"));
    const modelId = "async-throw-model";
    try {
      const { withEmbeddingCacheLoadLock } =
        await import("../../packages/memory/src/embedding-cache-lock.js");
      await expect(
        withEmbeddingCacheLoadLock(dir, modelId, async () => {
          await Promise.resolve();
          throw new Error("asynchronous pipeline failure");
        })
      ).rejects.toThrow("asynchronous pipeline failure");
      expect(await canListen(await embeddingLockAddress(dir, modelId))).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("wraps the isolated worker pipeline load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moss-embed-worker-lock-"));
    const modelId = "worker-lock-model";
    const transformers = await import("@huggingface/transformers");
    const previousCacheDir = transformers.env.cacheDir;
    try {
      transformers.env.cacheDir = dir;
      pipelineMock.mockImplementationOnce(async () => {
        expect(await canListen(await embeddingLockAddress(dir, modelId))).toBe(false);
        return fakePipe;
      });
      vi.doMock("node:worker_threads", () => ({ parentPort: { on: vi.fn() } }));
      const workerModule =
        (await import("../../packages/memory/src/local-embedding-worker.js")) as unknown as {
          loadEmbeddingWorkerPipe?: (model: string) => Promise<unknown>;
        };

      expect(workerModule.loadEmbeddingWorkerPipe).toBeTypeOf("function");
      await workerModule.loadEmbeddingWorkerPipe!(modelId);
    } finally {
      vi.doUnmock("node:worker_threads");
      transformers.env.cacheDir = previousCacheDir;
      await rm(dir, { force: true, recursive: true });
    }
  });
});

/**
 * #1359: transformers.js truncates to `tokenizer.model_max_length` and discards any max_length the
 * caller passes to the pipeline. Left at nomic's 8192 default a single call allocated ~6.8 GB —
 * self-attention is quadratic in sequence length — and the ONNX runtime keeps that as arena rather
 * than handing it back. Bounding the tokenizer at load is the only lever that works, so these tests
 * pin it at the one place it can be applied.
 */
describe("LocalEmbeddingProvider sequence bound (#1359)", () => {
  beforeEach(async () => {
    const { resetEmbeddingPipelineCacheForTests } = await importProvider();
    resetEmbeddingPipelineCacheForTests();
    pipelineMock.mockClear();
    fakePipe.mockClear();
    fakePipe.tokenizer = { model_max_length: 8192 };
  });

  it("bounds the tokenizer at load instead of leaving the model's 8192 default", async () => {
    const { LocalEmbeddingProvider, EMBED_MAX_TOKENS } = await importProvider();

    await new LocalEmbeddingProvider("model-a").embedDocument("anything");

    expect(EMBED_MAX_TOKENS).toBe(512);
    expect(fakePipe.tokenizer.model_max_length).toBe(EMBED_MAX_TOKENS);
  });

  it("applies the bound once per load, and it survives for later callers", async () => {
    const { LocalEmbeddingProvider } = await importProvider();

    await new LocalEmbeddingProvider("model-a").embedDocument("first");
    // A later caller reuses the cached pipe, so the bound must still be in force without a reload.
    await new LocalEmbeddingProvider("model-a").embedQuery("second");

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(fakePipe.tokenizer.model_max_length).toBe(512);
  });

  it("refuses to embed at all when the pipeline exposes no tokenizer to bound", async () => {
    const { LocalEmbeddingProvider } = await importProvider();
    // Simulates transformers.js changing shape under us. Falling back to the unbounded default
    // would reintroduce the multi-gigabyte call and surface as an OOM kill far from this code.
    (fakePipe as { tokenizer?: unknown }).tokenizer = undefined;

    await expect(new LocalEmbeddingProvider("model-a").embedDocument("x")).rejects.toThrow(
      /exposes no tokenizer/
    );
  });
});
