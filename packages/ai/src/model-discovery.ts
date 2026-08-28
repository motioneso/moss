import type { AiModelCapability, AiModelTier, AiProviderDiscoveredModelDto } from "@moss/shared";
import type { AiAuthMethod, AiProviderKind } from "@moss/db";

const CACHE_TTL_MS = 3_600_000; // 1 hour

// Provider create/update calls this inline and soft-fails on error, but an unbounded fetch still
// blocks the request on a slow/unreachable provider API. Bound the wait, not just the failure.
const MODEL_DISCOVERY_FETCH_TIMEOUT_MS = 5_000;

interface CacheEntry {
  readonly models: AiProviderDiscoveredModelDto[];
  readonly fromFallback: boolean;
  readonly expiresAt: number;
}

// Static fallback — no hardcoded model IDs outside this file.
const ANTHROPIC_STATIC_MODELS: readonly AiProviderDiscoveredModelDto[] = [
  {
    providerModelId: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    capabilities: ["chat", "tool-use", "json", "vision", "summarization"],
    tier: "reasoning"
  },
  {
    providerModelId: "claude-sonnet-4-6",
    displayName: "Claude",
    capabilities: ["chat", "tool-use", "json", "vision", "summarization"],
    tier: "interactive"
  },
  {
    providerModelId: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    capabilities: ["chat", "tool-use", "json", "summarization"],
    tier: "economy"
  }
];

// #982/#869 D7: curated static model lists for installable + loginable CLI providers. A CLI
// provider has no HTTP `/models` endpoint to query, so discovery returns this list (marked
// fromFallback — it's not from a live API). Reconciliation inserts these rows active; resolver
// ordering keeps the `"default"` sentinel first for unpinned chat while concrete ids serve json and
// explicit pins. Keeping ids here makes Codex list upkeep a one-file data change.
//   - anthropic (claude CLI): the same concrete ids as the API fallback.
//   - openai-compatible (codex CLI): current ids from learn.chatgpt.com/docs/models, 2026-07-12.
//   - google (gemini CLI): current ids the pinned CLI accepts for `--model`, 2026-08-27 (#2028).
//     These serve an explicit pin and the json/summarization routes; unpinned chat still rides the
//     `"default"` sentinel and therefore the account's own model.
export const CLI_STATIC_MODELS: Partial<
  Record<AiProviderKind, readonly AiProviderDiscoveredModelDto[]>
> = {
  anthropic: ANTHROPIC_STATIC_MODELS,
  "openai-compatible": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6"].map(
    (id) => inferModel(id, "openai-compatible")!
  ),
  google: [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite"
  ].map((id) => inferModel(id, "google")!)
};

/** #982/#869: only providers backed by curated CLI data are safe to clean-slate reconcile. */
export function hasCliStaticModels(providerKind: AiProviderKind): boolean {
  return CLI_STATIC_MODELS[providerKind] !== undefined;
}

export interface ModelDiscoveryInput {
  readonly providerKind: AiProviderKind;
  readonly authMethod: AiAuthMethod;
  readonly baseUrl: string | null;
  readonly credential: unknown;
  readonly fetch?: typeof globalThis.fetch;
}

export interface DiscoverModelsResult {
  readonly models: AiProviderDiscoveredModelDto[];
  readonly fromCache: boolean;
  readonly fromFallback: boolean;
  readonly cacheExpiresAt: number | null;
}

export class ModelDiscoveryService {
  private readonly cache = new Map<string, CacheEntry>();

  async discoverModels(
    cacheKey: string,
    input: ModelDiscoveryInput
  ): Promise<DiscoverModelsResult> {
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return {
        models: cached.models,
        fromCache: true,
        fromFallback: cached.fromFallback,
        cacheExpiresAt: cached.expiresAt
      };
    }

    const { models, fromFallback } = await fetchModels(input);
    if (!fromFallback) {
      this.cache.set(cacheKey, { models, fromFallback, expiresAt: now + CACHE_TTL_MS });
    }
    return {
      models,
      fromCache: false,
      fromFallback,
      cacheExpiresAt: fromFallback ? null : now + CACHE_TTL_MS
    };
  }

  invalidate(actorUserId: string, providerId: string): void {
    this.cache.delete(`${actorUserId}:${providerId}`);
  }
}

async function fetchModels(
  input: ModelDiscoveryInput
): Promise<{ models: AiProviderDiscoveredModelDto[]; fromFallback: boolean }> {
  if (input.authMethod === "cli") {
    // #870/H5: no live endpoint — return the curated static list for this CLI kind (or none).
    const statics = CLI_STATIC_MODELS[input.providerKind];
    return statics
      ? { models: statics.slice(), fromFallback: true }
      : { models: [], fromFallback: false };
  }

  const apiKey = readApiKey(input.credential);
  if (!apiKey) {
    return input.providerKind === "anthropic"
      ? { models: ANTHROPIC_STATIC_MODELS.slice(), fromFallback: true }
      : { models: [], fromFallback: false };
  }

  try {
    const response = await doFetch(input, apiKey);
    if (!response.ok) {
      return input.providerKind === "anthropic"
        ? { models: ANTHROPIC_STATIC_MODELS.slice(), fromFallback: true }
        : { models: [], fromFallback: false };
    }
    // #874 HIGH-2: inferModel returns null for pure speech-to-text models (dropped from assistant
    // discovery); filter them out so only assistant-bindable models reach the admin UI.
    const models = extractModelIds(input.providerKind, await response.json())
      .map((id) => inferModel(id, input.providerKind))
      .filter((model): model is AiProviderDiscoveredModelDto => model !== null);
    return { models, fromFallback: false };
  } catch {
    return input.providerKind === "anthropic"
      ? { models: ANTHROPIC_STATIC_MODELS.slice(), fromFallback: true }
      : { models: [], fromFallback: false };
  }
}

function readApiKey(credential: unknown): string | null {
  if (!credential || typeof credential !== "object") return null;
  const value = (credential as { apiKey?: unknown }).apiKey;
  return typeof value === "string" && value.trim() ? value : null;
}

function doFetch(input: ModelDiscoveryInput, apiKey: string): Promise<Response> {
  const f = input.fetch ?? globalThis.fetch;
  const signal = AbortSignal.timeout(MODEL_DISCOVERY_FETCH_TIMEOUT_MS);
  switch (input.providerKind) {
    case "anthropic":
      return f("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal
      });
    case "google":
      return f("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": apiKey },
        signal
      });
    case "openai-compatible":
    case "ollama":
    case "custom": {
      const base = (input.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
      return f(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
    }
  }
}

function extractModelIds(providerKind: AiProviderKind, json: unknown): string[] {
  if (!json || typeof json !== "object") return [];

  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data)) {
    let ids = data
      .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (providerKind === "anthropic") {
      // Include only current claude- models; exclude legacy snapshot versions (contain ":")
      ids = ids.filter((id) => id.includes("claude-") && !id.includes(":"));
    }
    return ids;
  }

  const models = (json as { models?: unknown }).models;
  if (Array.isArray(models)) {
    return models
      .map((item) =>
        item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
          ? (item as { name: string }).name.replace(/^models\//, "")
          : null
      )
      .filter((id): id is string => Boolean(id));
  }
  return [];
}

function inferTierFromModelId(providerKind: AiProviderKind, modelId: string): AiModelTier {
  const id = modelId.toLowerCase();
  if (providerKind === "anthropic") {
    if (id.includes("opus")) return "reasoning";
    if (id.includes("sonnet")) return "interactive";
    if (id.includes("haiku")) return "economy";
    return "interactive";
  }
  if (providerKind === "openai-compatible") {
    // #982/#869 D7: Codex's published suffixes express service tier; keep this inference beside
    // the curated data so feature routing remains provider-agnostic.
    if (id.includes("-sol")) return "reasoning";
    if (id.includes("-terra")) return "interactive";
    if (id.includes("-luna")) return "economy";
    if (/\bo[0-9]/.test(id)) return "reasoning";
    if (id.includes("mini") || id.includes("nano") || id.includes("small")) return "economy";
    if (id.includes("3.5") || id.includes("3-5")) return "economy";
    return "interactive";
  }
  if (providerKind === "google") {
    // #2028: Gemini names its own tiers in the model id. "flash-lite" and "flash" are the cheap
    // fast ones, "pro" is the slow careful one; anything unrecognised is treated as everyday.
    if (id.includes("flash") || id.includes("lite")) return "economy";
    if (id.includes("pro") || id.includes("ultra")) return "reasoning";
    return "interactive";
  }
  // ollama, custom: use name hints
  if (id.includes("mini") || id.includes("flash") || id.includes("haiku")) return "economy";
  if (id.includes("opus") || id.includes("reason")) return "reasoning";
  return "interactive";
}

function inferModel(
  providerModelId: string,
  providerKind: AiProviderKind
): AiProviderDiscoveredModelDto | null {
  const lower = providerModelId.toLowerCase();

  // #874 HIGH-2: assistant-provider discovery no longer infers `transcription` at all. Voice (STT)
  // is a dedicated instance endpoint (`purpose='voice'`, configured manually with a free-text model
  // name) — it does NOT flow through discovery on an assistant provider. A pure speech-to-text model
  // (whisper / *-transcribe) has no assistant capability, so we drop it from the discovered list
  // entirely (caller filters nulls) rather than surfacing an unbindable, non-chat row.
  const isPureTranscription = lower.includes("whisper") || lower.includes("transcribe");
  if (isPureTranscription) {
    return null;
  }

  // Multimodal audio chat models (e.g. gpt-4o-audio) keep their chat/tool capabilities but are NOT
  // tagged `transcription` — Voice never binds to an assistant-side model (#874 HIGH-2 / CRIT-1).
  const capabilities: AiModelCapability[] = ["chat", "tool-use", "json", "summarization"];
  if (lower.includes("vision") || lower.includes("image") || lower.includes("gemini")) {
    capabilities.push("vision");
  }
  const tier = inferTierFromModelId(providerKind, providerModelId);
  return { providerModelId, displayName: providerModelId, capabilities, tier };
}
