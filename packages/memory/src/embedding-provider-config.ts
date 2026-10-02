import { resolveMossEnv } from "@moss/db";

import type { EmbeddingProvider } from "./embedding-provider.js";
import { StubEmbeddingProvider } from "./embedding-provider.js";
import { LocalEmbeddingProvider } from "./local-embedding-provider.js";

export type EmbeddingProviderKind = "local" | "stub";

export interface EmbeddingProviderConfig {
  readonly kind: EmbeddingProviderKind;
  readonly modelId?: string;
}

/**
 * Plan 3.6b (#2890): the embedding-activity sink. It is structurally compatible with `@moss/ai`'s
 * `ModelActivityEntry`/`ModelActivityRecorder`, but declared here so `@moss/memory` does not import
 * `@moss/ai` (which would pull the AI package's node-only routes into the browser typecheck graph).
 * The composition root installs a recorder that forwards to `@moss/ai`'s `recordModelActivity`.
 */
export type EmbeddingActivityOutcome = "ok" | "error" | "aborted";

export interface EmbeddingActivityEntry {
  readonly kind: string;
  readonly action: string;
  readonly outcome: EmbeddingActivityOutcome;
  readonly modelName: string;
  readonly result: string;
}

export type EmbeddingActivityRecorder = (entry: EmbeddingActivityEntry) => void;

let installedEmbeddingRecorder: EmbeddingActivityRecorder | null = null;

/** Install (or clear) the process-wide embedding activity recorder. Called at a composition root. */
export function installEmbeddingActivityRecorder(recorder: EmbeddingActivityRecorder | null): void {
  installedEmbeddingRecorder = recorder;
}

function defaultEmbeddingRecorder(entry: EmbeddingActivityEntry): void {
  const recorder = installedEmbeddingRecorder;
  if (!recorder) return;
  try {
    recorder(entry);
  } catch {
    // Recording is fire-and-forget; a recorder error must never fail the embedding call.
  }
}

/**
 * Wrap an embedding provider so it records ONE model activity row per job rather than per chunk.
 * Embedding jobs create a provider per job and call it once per chunk, so the first terminal call
 * on this instance records the job's row; later calls in the same instance do not add another.
 * Only transport facts are recorded — the provider's own model name and the outcome. No text
 * ever enters the row.
 */
export function withEmbeddingActivity(
  provider: EmbeddingProvider,
  recorder: EmbeddingActivityRecorder = defaultEmbeddingRecorder
): EmbeddingProvider {
  let recorded = false;
  const recordOnce = (outcome: EmbeddingActivityOutcome): void => {
    if (recorded) return;
    recorded = true;
    try {
      recorder({
        kind: "embedding",
        action: "embedding",
        outcome,
        modelName: provider.modelName,
        result: outcome === "ok" ? "completed" : outcome === "aborted" ? "stopped" : "failed"
      });
    } catch {
      // Never let recording fail the embedding call.
    }
  };
  const run = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      const value = await call();
      recordOnce("ok");
      return value;
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      recordOnce(aborted ? "aborted" : "error");
      throw error;
    }
  };
  return {
    dimensions: provider.dimensions,
    modelName: provider.modelName,
    modelVersion: provider.modelVersion,
    embedDocument: (text) => run(() => provider.embedDocument(text)),
    embedQuery: (text) => run(() => provider.embedQuery(text))
  };
}

export interface EmbeddingRuntimeConfigResolver {
  resolveEnum(key: "ai.embed_provider"): Promise<EmbeddingProviderKind>;
  resolveString(key: "ai.embed_model"): Promise<string>;
}

// #1313: `stub` (packages/memory/src/embedding-provider.ts) SHA-256-stretches the input text
// into a 768-float vector — correct shape, meaningless content. It exists purely so tests don't
// pay to download/run a real model. The runtime-config registry
// (packages/settings/src/runtime-config-keys.ts) no longer lists "stub" as a settable enum
// value, so a real instance can never be steered onto it through the admin UI or module
// self-operation (epic #1262). This function is the last line of defense: even if "stub" reaches
// here some other way (a stale instance_settings row from before this fix, or a raw
// JARVIS_EMBED_PROVIDER=stub env var), it is only honored under an explicit test/dev signal.
// Anything else silently falls back to "local" plus a loud warning, rather than quietly serving
// noise from search.
function isStubEmbeddingAllowed(env: NodeJS.ProcessEnv): boolean {
  // VITEST is set unconditionally by the test runner (more reliable than NODE_ENV, which some
  // tooling overrides) — same signal packages/auth/src/index.ts uses for its own test-only gate.
  return (
    env.VITEST === "true" ||
    env.NODE_ENV === "test" ||
    resolveMossEnv(env, "JARVIS_ALLOW_STUB_EMBEDDINGS") === "1"
  );
}

/** The only place that instantiates an embedding provider. Never hardcode a provider elsewhere. */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  onModelCall: EmbeddingActivityRecorder = defaultEmbeddingRecorder
): EmbeddingProvider {
  const provider = buildEmbeddingProvider(config, env);
  return withEmbeddingActivity(provider, onModelCall);
}

function buildEmbeddingProvider(
  config: EmbeddingProviderConfig,
  env: NodeJS.ProcessEnv
): EmbeddingProvider {
  switch (config.kind) {
    case "local":
      return new LocalEmbeddingProvider(config.modelId);
    case "stub":
      if (!isStubEmbeddingAllowed(env)) {
        // #1313: loud, unmissable startup/first-use warning — an instance silently running the
        // fake embedding provider looks healthy and just answers search badly. Falling back to
        // "local" here is strictly better than honoring the request: it actually works, instead
        // of quietly returning noise.
        console.warn(
          '[embedding-provider] #1313: runtime config "ai.embed_provider" resolved to the ' +
            'test-only "stub" provider on what looks like a real instance (no NODE_ENV=test / ' +
            "VITEST=true / JARVIS_ALLOW_STUB_EMBEDDINGS=1 signal present). Falling back to " +
            '"local" instead — semantic search would otherwise silently return noise.'
        );
        return new LocalEmbeddingProvider(config.modelId);
      }
      return new StubEmbeddingProvider();
  }
}

export async function getEmbeddingProviderConfig(
  resolver: EmbeddingRuntimeConfigResolver
): Promise<EmbeddingProviderConfig> {
  const kind = await resolver.resolveEnum("ai.embed_provider");
  const modelId = await resolver.resolveString("ai.embed_model");
  return modelId ? { kind, modelId } : { kind };
}
