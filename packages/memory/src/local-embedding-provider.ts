import { Worker } from "node:worker_threads";

import { env as transformersEnv, pipeline } from "@huggingface/transformers";

import type { EmbeddingProvider } from "./embedding-provider.js";
import { withEmbeddingCacheLoadLock } from "./embedding-cache-lock.js";
import { applyTransformersCacheDir } from "./transformers-cache-dir.js";

const DEFAULT_MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";

/**
 * Longest token sequence we let the model see in one call.
 *
 * #1359: self-attention cost grows with the square of the sequence length, and
 * `nomic-embed-text-v1.5` advertises an 8192-token window. Left at that default a single call
 * allocated ~6.8 GB of native scratch — memory the ONNX runtime keeps as arena rather than
 * returning to the OS — and took 23 seconds. At 512 tokens the same call costs ~26 MB and 0.4
 * seconds for an identically shaped vector. 512 is also nomic's own training context for retrieval,
 * so shorter sequences are what the model is actually good at; averaging 8192 tokens into one
 * 768-dim vector produces a washed-out embedding that matches everything and retrieves nothing.
 *
 * This is a safety floor for every caller, not a substitute for chunking. Text past the bound is
 * DISCARDED, silently, by the tokenizer. `splitIntoChunks` in parser.ts is what keeps the bound
 * lossless by never handing us a chunk this large in the first place.
 */
export const EMBED_MAX_TOKENS = 512;

/** Minimal callable shape we need from the feature-extraction pipeline. */
interface ExtractPipe {
  (text: string, options: Record<string, unknown>): Promise<{ data: Float32Array }>;
  /** The pipeline's tokenizer. Mutating `model_max_length` is the only way to bound length. */
  tokenizer?: { model_max_length?: number };
}

/**
 * Process-wide cache of loaded models, keyed by model id.
 *
 * #1355: this used to be a per-instance field, and `createEmbeddingProvider` hands out a NEW
 * provider on every call — including once per background job. Every job therefore loaded its own
 * fp32 CPU copy of the model, and because the ONNX session holds native memory outside the JS
 * heap, the discarded copies were never meaningfully reclaimed. The prod worker reached ~25 GB RSS
 * in about 70 minutes, the kernel OOM killer took the container down, and users saw an nginx 502
 * mid-conversation.
 *
 * Sharing is safe: the model is immutable, identical for every caller, and derived only from the
 * model id. The provider holds no db handle, no AccessContext and no user state, so there is
 * nothing tenant-specific that could leak between callers.
 *
 * The cache stores the PROMISE rather than the resolved pipe so concurrent first-callers await a
 * single load instead of racing into several. A rejected load evicts itself, so a transient
 * failure (a cold model download, say) does not poison the cache for the life of the process.
 */
const pipeCache = new Map<string, Promise<ExtractPipe>>();

type WorkerResponse = {
  readonly id: number;
  readonly embedding?: number[];
  readonly error?: string;
};

class EmbeddingWorkerClient {
  private nextRequestId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (embedding: number[]) => void; reject: (error: Error) => void }
  >();
  private readonly worker: Worker;

  constructor(
    private readonly modelId: string,
    workerUrl: URL
  ) {
    this.worker = new Worker(workerUrl);
    this.worker.unref();
    this.worker.on("message", (response: WorkerResponse) => {
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if (response.error) request.reject(new Error(response.error));
      else request.resolve(response.embedding ?? []);
    });
    this.worker.on("error", (error) => this.rejectPending(error));
    this.worker.on("exit", (code) => {
      if (code !== 0) this.rejectPending(new Error(`Embedding worker exited with code ${code}`));
    });
  }

  embed(prefix: "search_document" | "search_query", text: string): Promise<number[]> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, modelId: this.modelId, prefix, text });
    });
  }

  close(): void {
    this.rejectPending(new Error("Embedding worker closed"));
    void this.worker.terminate();
  }

  private rejectPending(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const request of this.pending.values()) request.reject(failure);
    this.pending.clear();
  }
}

const workerClients = new Map<string, EmbeddingWorkerClient>();
const DEFAULT_EMBEDDING_WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./local-embedding-worker.ts" : "./local-embedding-worker.js",
  import.meta.url
);

function getEmbeddingWorkerClient(modelId: string, workerUrl: URL): EmbeddingWorkerClient {
  const key = `${workerUrl.href}:${modelId}`;
  const cached = workerClients.get(key);
  if (cached) return cached;
  const client = new EmbeddingWorkerClient(modelId, workerUrl);
  workerClients.set(key, client);
  return client;
}

function loadPipe(modelId: string): Promise<ExtractPipe> {
  const cached = pipeCache.get(modelId);
  if (cached) return cached;

  // Must run before the cache dir is read: the library's default is unwritable in the
  // container and the resulting EACCES is indistinguishable from an ordinary bug (#1883).
  applyTransformersCacheDir(transformersEnv);
  // pipeline() returns a complex union; we narrow to the callable shape we need.
  const loading = withEmbeddingCacheLoadLock(transformersEnv.cacheDir, modelId, () =>
    Promise.resolve(pipeline("feature-extraction", modelId))
  ).then((p) => {
    const pipe = p as unknown as ExtractPipe;
    // #1359: transformers.js FeatureExtractionPipeline._call hardcodes its tokenizer call to
    // `{ padding: true, truncation: true }` and destructures only pooling/normalize/quantize/
    // precision from the caller's options. Any max_length we pass at the call site is silently
    // dropped, so mutating the tokenizer after load is the only lever that bounds sequence length.
    if (!pipe.tokenizer) {
      // Failing loud beats falling back to the 8192-token default: that default is what produced
      // the ~6.8 GB-per-call worker and it fails as an OOM kill far from this line.
      throw new Error(
        `Embedding pipeline for "${modelId}" exposes no tokenizer; cannot bound sequence length (#1359)`
      );
    }
    pipe.tokenizer.model_max_length = EMBED_MAX_TOKENS;
    return pipe;
  });
  const guarded = loading.catch((err: unknown) => {
    pipeCache.delete(modelId);
    throw err;
  });
  pipeCache.set(modelId, guarded);
  return guarded;
}

/** Test-only: drop the shared model cache so a suite can observe loads from a clean slate. */
export function resetEmbeddingPipelineCacheForTests(): void {
  pipeCache.clear();
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;
  readonly modelName: string;
  readonly modelVersion = "1.5";

  constructor(modelId: string = DEFAULT_MODEL_ID) {
    this.modelName = modelId;
  }

  async embedDocument(text: string): Promise<number[]> {
    return this.run("search_document", text);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.run("search_query", text);
  }

  private async run(prefix: "search_document" | "search_query", text: string): Promise<number[]> {
    const pipe = await loadPipe(this.modelName);
    const output = await pipe(`${prefix}: ${text}`, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }
}

/** Embedding provider for queue handlers whose native inference must not share the main loop. */
export class CpuIsolatedEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;
  readonly modelName: string;
  readonly modelVersion = "1.5";
  private readonly client: EmbeddingWorkerClient;

  constructor(modelId: string = DEFAULT_MODEL_ID, workerUrl: URL = DEFAULT_EMBEDDING_WORKER_URL) {
    this.modelName = modelId;
    this.client = getEmbeddingWorkerClient(modelId, workerUrl);
  }

  embedDocument(text: string): Promise<number[]> {
    return this.client.embed("search_document", text);
  }

  embedQuery(text: string): Promise<number[]> {
    return this.client.embed("search_query", text);
  }

  close(): void {
    this.client.close();
  }
}
