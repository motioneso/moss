import { parentPort } from "node:worker_threads";

import { env as transformersEnv, pipeline } from "@huggingface/transformers";

import { withEmbeddingCacheLoadLock } from "./embedding-cache-lock.js";
import { applyTransformersCacheDir } from "./transformers-cache-dir.js";

interface ExtractPipe {
  (text: string, options: Record<string, unknown>): Promise<{ data: Float32Array }>;
  tokenizer?: { model_max_length?: number };
}

interface EmbedRequest {
  readonly id: number;
  readonly modelId: string;
  readonly prefix: "search_document" | "search_query";
  readonly text: string;
}

const pipeCache = new Map<string, Promise<ExtractPipe>>();

export function loadEmbeddingWorkerPipe(modelId: string): Promise<ExtractPipe> {
  const cached = pipeCache.get(modelId);
  if (cached) return cached;

  // Must run before the cache dir is read: the library's default is unwritable in the
  // container and the resulting EACCES is indistinguishable from an ordinary bug (#1883).
  applyTransformersCacheDir(transformersEnv);
  const loading = withEmbeddingCacheLoadLock(transformersEnv.cacheDir, modelId, () =>
    Promise.resolve(
      pipeline("feature-extraction", modelId, {
        session_options: {
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
          executionMode: "sequential"
        }
      })
    )
  ).then((value) => {
    const pipe = value as unknown as ExtractPipe;
    if (!pipe.tokenizer) {
      throw new Error(`Embedding pipeline for "${modelId}" exposes no tokenizer`);
    }
    pipe.tokenizer.model_max_length = 512;
    return pipe;
  });
  const guarded = loading.catch((error: unknown) => {
    pipeCache.delete(modelId);
    throw error;
  });
  pipeCache.set(modelId, guarded);
  return guarded;
}

if (!parentPort) throw new Error("embedding worker requires parentPort");

parentPort.on("message", async (request: EmbedRequest) => {
  try {
    const pipe = await loadEmbeddingWorkerPipe(request.modelId);
    const output = await pipe(`${request.prefix}: ${request.text}`, {
      pooling: "mean",
      normalize: true
    });
    parentPort!.postMessage({ id: request.id, embedding: Array.from(output.data) });
  } catch (error) {
    parentPort!.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
