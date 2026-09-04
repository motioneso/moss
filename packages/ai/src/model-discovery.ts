import type {
  AiCliModelListFailure,
  AiCliModelListResult,
  AiModelCapability,
  AiModelTier,
  AiProviderDiscoveredModelDto
} from "@moss/shared";
import type { AiAuthMethod, AiProviderKind } from "@moss/db";

const CACHE_TTL_MS = 3_600_000; // 1 hour

// Provider create/update calls this inline and soft-fails on error, but an unbounded fetch still
// blocks the request on a slow/unreachable provider API. Bound the wait, not just the failure.
const MODEL_DISCOVERY_FETCH_TIMEOUT_MS = 5_000;

interface CacheEntry {
  readonly models: AiProviderDiscoveredModelDto[];
  readonly expiresAt: number;
}

/**
 * #2208: the port that asks the cli-runner for a CLI provider's live model list (ids only). The
 * composition root injects it over the runner socket; absent (host-dev / in-process path, unit
 * tests) ⇒ CLI discovery reports `reason: "unavailable"` and returns no models. There is NO
 * typed-in fallback list any more: model ids are discovered or entered by hand, never shipped.
 */
export type CliModelLister = (provider: AiProviderKind) => Promise<AiCliModelListResult>;

/** Why CLI discovery returned no models. `unavailable` ⇒ no runner connection on this build. */
export type ModelDiscoveryReason = AiCliModelListFailure | "unavailable";

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
  /** Always false since #2208 removed the static lists; kept so the DTO shape is unchanged. */
  readonly fromFallback: boolean;
  readonly cacheExpiresAt: number | null;
  /**
   * #2208: set ONLY when a CLI provider's list could not be fetched (routes surface it in plain
   * English). Absent ⇒ the list is authoritative for this provider (an API-key provider, or a CLI
   * provider whose vendor answered `ok`), so persistence may reconcile discovered rows against it.
   */
  readonly reason?: ModelDiscoveryReason;
  /** Plain-English detail from the runner for a failed CLI list; never carries a secret. */
  readonly message?: string;
}

export interface ModelDiscoveryServiceDeps {
  readonly cliModelLister?: CliModelLister;
}

export class ModelDiscoveryService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cliModelLister: CliModelLister | undefined;

  constructor(deps: ModelDiscoveryServiceDeps = {}) {
    this.cliModelLister = deps.cliModelLister;
  }

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
        fromFallback: false,
        cacheExpiresAt: cached.expiresAt
      };
    }

    const fetched =
      input.authMethod === "cli"
        ? await this.fetchCliModels(input.providerKind)
        : { models: await fetchApiKeyModels(input) };
    if (fetched.reason !== undefined) {
      return {
        models: [],
        fromCache: false,
        fromFallback: false,
        cacheExpiresAt: null,
        reason: fetched.reason,
        ...(fetched.message !== undefined ? { message: fetched.message } : {})
      };
    }
    this.cache.set(cacheKey, { models: fetched.models, expiresAt: now + CACHE_TTL_MS });
    return {
      models: fetched.models,
      fromCache: false,
      fromFallback: false,
      cacheExpiresAt: now + CACHE_TTL_MS
    };
  }

  invalidate(actorUserId: string, providerId: string): void {
    this.cache.delete(`${actorUserId}:${providerId}`);
  }

  /** #2208: CLI providers have no HTTP `/models`; the runner asks the vendor with the stored login. */
  private async fetchCliModels(providerKind: AiProviderKind): Promise<{
    models: AiProviderDiscoveredModelDto[];
    reason?: ModelDiscoveryReason;
    message?: string;
  }> {
    if (!this.cliModelLister) return { models: [], reason: "unavailable" };
    const result = await this.cliModelLister(providerKind);
    if (result.status !== "ok") {
      return {
        models: [],
        reason: result.status,
        ...(result.message !== undefined ? { message: result.message } : {})
      };
    }
    const models = result.models
      .map((model) => inferModel(model.id, providerKind))
      .filter((model): model is AiProviderDiscoveredModelDto => model !== null);
    return { models };
  }
}

/** API-key providers: a failed or credential-less discovery returns [] (no invented ids, #2208). */
async function fetchApiKeyModels(
  input: ModelDiscoveryInput
): Promise<AiProviderDiscoveredModelDto[]> {
  const apiKey = readApiKey(input.credential);
  if (!apiKey) return [];

  try {
    const response = await doFetch(input, apiKey);
    if (!response.ok) return [];
    // #874 HIGH-2: inferModel returns null for pure speech-to-text models (dropped from assistant
    // discovery); filter them out so only assistant-bindable models reach the admin UI.
    return extractModelEntries(input.providerKind, await response.json())
      .map((entry) => inferModel(entry.id, input.providerKind, entry.releasedAt))
      .filter((model): model is AiProviderDiscoveredModelDto => model !== null);
  } catch {
    return [];
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

interface DiscoveredModelEntry {
  readonly id: string;
  /** ISO 8601 release date when the provider's list carries one. */
  readonly releasedAt: string | null;
}

/**
 * Anthropic lists `created_at` (ISO string); OpenAI-compatible lists `created` (unix seconds).
 * Anything unparseable is null so a provider that omits the field simply has no release order.
 */
function readReleasedAt(item: Record<string, unknown>): string | null {
  const iso = item.created_at;
  if (typeof iso === "string") {
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const epoch = item.created;
  if (typeof epoch === "number" && Number.isFinite(epoch) && epoch > 0) {
    return new Date(epoch * 1000).toISOString();
  }
  return null;
}

function extractModelEntries(providerKind: AiProviderKind, json: unknown): DiscoveredModelEntry[] {
  if (!json || typeof json !== "object") return [];

  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data)) {
    let entries = data
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .filter(
        (item): item is Record<string, unknown> & { id: string } =>
          typeof item.id === "string" && item.id.length > 0
      )
      .map((item) => ({ id: item.id, releasedAt: readReleasedAt(item) }));
    if (providerKind === "anthropic") {
      // Include only current claude- models; exclude legacy snapshot versions (contain ":")
      entries = entries.filter((entry) => entry.id.includes("claude-") && !entry.id.includes(":"));
    }
    return entries;
  }

  const models = (json as { models?: unknown }).models;
  if (Array.isArray(models)) {
    return models
      .map((item) =>
        item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
          ? (item as { name: string }).name.replace(/^models\//, "")
          : null
      )
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id, releasedAt: null }));
  }
  return [];
}

function inferTierFromModelId(providerKind: AiProviderKind, modelId: string): AiModelTier {
  const id = modelId.toLowerCase();
  if (providerKind === "anthropic") {
    // #2208: Fable is the Mythos-class tier above Opus — the same "slow, careful" slot.
    if (id.includes("opus") || id.includes("fable")) return "reasoning";
    if (id.includes("sonnet")) return "interactive";
    if (id.includes("haiku")) return "economy";
    return "interactive";
  }
  if (providerKind === "openai-compatible") {
    // #982/#869 D7: Codex's published suffixes express service tier. Heuristics on the id are
    // fine (#2208); typed-in lists of ids are not.
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
  providerKind: AiProviderKind,
  releasedAt: string | null = null
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
  return { providerModelId, displayName: providerModelId, capabilities, tier, releasedAt };
}
