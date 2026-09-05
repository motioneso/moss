import { resolveMossEnv } from "@moss/db";

export interface WebSearchProviderInput {
  readonly query: string;
  readonly limit: number;
  readonly freshness?: "any" | "day" | "week" | "month";
}

export interface WebSearchProviderResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedAt?: string;
}

export interface WebSearchProviderOutput {
  readonly results: readonly WebSearchProviderResult[];
  readonly trace?: Record<string, unknown>;
}

export interface WebSearchProvider {
  readonly name: string;
  search(input: WebSearchProviderInput): Promise<WebSearchProviderOutput>;
}

const unavailableSearchProvider: WebSearchProvider = {
  name: "unavailable",
  search: async () => ({ results: [], trace: { unavailable: true } })
};

// Brave Search provider — key resolved from the encrypted instance setting (admin UI) or the
// JARVIS_BRAVE_SEARCH_API_KEY env fallback. Pricing (2026): $5 free credit/month (~1k searches),
// then metered at $5 per 1k requests; credit card required, no spending cap. Docs:
// https://brave.com/search/api/
const BRAVE_FRESHNESS_MAP: Partial<Record<string, string>> = {
  day: "pd",
  week: "pw",
  month: "pm"
};

function createBraveSearchProvider(apiKey: string): WebSearchProvider {
  return {
    name: "brave",
    async search(input) {
      const params = new URLSearchParams({
        q: input.query,
        count: String(Math.min(input.limit, 20)),
        text_decorations: "false",
        extra_snippets: "false"
      });
      if (input.freshness && input.freshness !== "any") {
        const mapped = BRAVE_FRESHNESS_MAP[input.freshness];
        if (mapped) params.set("freshness", mapped);
      }
      const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey
        },
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Brave Search API error ${response.status}: ${body.slice(0, 200)}`);
      }
      const data = (await response.json()) as {
        web?: {
          results?: Array<{ title?: string; url?: string; description?: string; age?: string }>;
        };
      };
      const results: WebSearchProviderResult[] = (data.web?.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
        ...(r.age ? { publishedAt: r.age } : {})
      }));
      return {
        results,
        trace: { provider: "brave", count: results.length }
      };
    }
  };
}

/**
 * #2228: search by asking a chat model to use its own built-in web search tool, instead of
 * calling a search API directly. `runner` is a thin transport the composition root binds to a
 * structured-output call against the actor's chat model; everything about turning a query into a
 * prompt and turning the model's reply back into results lives here so it is unit-testable
 * without a real model.
 */
export interface ModelNativeSearchRunnerInput {
  readonly prompt: string;
  readonly schema: Record<string, unknown>;
}

export interface ModelNativeSearchRunnerResult {
  readonly object: unknown;
  readonly sources?: readonly { readonly title: string; readonly url: string }[];
}

export type ModelNativeSearchRunner = (
  input: ModelNativeSearchRunnerInput
) => Promise<ModelNativeSearchRunnerResult | null>;

const MODEL_NATIVE_SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "snippet"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" }
        }
      }
    }
  }
} as const;

function buildModelNativeSearchPrompt(input: WebSearchProviderInput): string {
  const freshnessLine =
    input.freshness && input.freshness !== "any"
      ? ` Prefer results published in the last ${input.freshness}.`
      : "";
  return (
    `Use your web search tool to find up to ${input.limit} results for: ${input.query}.` +
    `${freshnessLine} Reply with ONLY a JSON object of the shape ` +
    `{"results": [{"title": string, "url": string, "snippet": string}]}, built from pages you ` +
    "actually found through search, not invented ones."
  );
}

/**
 * Runs the structured search request and merges the parsed result list with any citations the
 * provider attached to the reply (a source the model cited but didn't repeat in the JSON body
 * still counts as a found result). Returns an empty list when the runner is unavailable or the
 * model reports nothing.
 */
export function createModelNativeProvider(runner: ModelNativeSearchRunner): WebSearchProvider {
  return {
    name: "model-native",
    async search(input) {
      const generated = await runner({
        prompt: buildModelNativeSearchPrompt(input),
        schema: MODEL_NATIVE_SEARCH_SCHEMA
      });
      if (!generated) {
        return { results: [], trace: { provider: "model-native", unavailable: true } };
      }

      const rawResults = Array.isArray((generated.object as { results?: unknown })?.results)
        ? (generated.object as { results: unknown[] }).results
        : [];
      const byUrl = new Map<string, WebSearchProviderResult>();
      for (const entry of rawResults) {
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as { title?: unknown; url?: unknown; snippet?: unknown };
        if (typeof candidate.url !== "string" || candidate.url.length === 0) continue;
        byUrl.set(candidate.url, {
          title: typeof candidate.title === "string" ? candidate.title : "",
          url: candidate.url,
          snippet: typeof candidate.snippet === "string" ? candidate.snippet : ""
        });
      }
      for (const source of generated.sources ?? []) {
        if (!byUrl.has(source.url)) {
          byUrl.set(source.url, { title: source.title, url: source.url, snippet: "" });
        }
      }

      const results = Array.from(byUrl.values()).slice(0, input.limit);
      return { results, trace: { provider: "model-native", count: results.length } };
    }
  };
}

/**
 * Resolves the instance-wide Brave key per request. Injected by the composition root (module
 * isolation: web-research must not import settings/db internals). `scopedDb` is the tool's
 * DataContextDb, typed `unknown` here to keep web-research free of a `@moss/db` dependency;
 * the resolver narrows it. Returns the decrypted key, or null when no instance key is set.
 */
export type WebSearchKeyResolver = (scopedDb: unknown) => Promise<string | null>;

/**
 * Resolves the model-native search runner for the current actor, plus an identifier for the
 * model behind it (used to key the provider cache — a different actor or a changed model
 * binding must not reuse another actor's closure). Injected by the composition root; returns
 * null when model-native search is not currently active (disabled, no model, model lacks the
 * capability). Same `unknown` typing rationale as {@link WebSearchKeyResolver}.
 */
export interface ModelNativeSearchResolution {
  readonly runner: ModelNativeSearchRunner;
  readonly modelId: string;
}
export type ModelNativeSearchResolver = (
  scopedDb: unknown
) => Promise<ModelNativeSearchResolution | null>;

let testSearchProvider: WebSearchProvider | undefined;
let keyResolver: WebSearchKeyResolver | undefined;
let modelNativeResolver: ModelNativeSearchResolver | undefined;
let modelNativeProviderCache: { modelId: string; provider: WebSearchProvider } | undefined;
// Fired when the injected key resolver throws (bad keyring / corrupted envelope) so the
// composition root can emit a metadata-only warn. web-research stays db/dependency-free; the
// callback carries NO secret material — only the event name is produced here.
let keyDecryptFailedNotifier: (() => void) | undefined;
// Tiny cache keyed by the resolved key VALUE: when the admin saves/rotates/revokes, the next
// request resolves a different key (or null) → cache miss → fresh provider, so a new key takes
// effect without a restart. invalidateWebSearchProviderCache() is the explicit save/revoke hook.
//
// ACCEPTED: the decrypted key is held in process memory for the cache entry's lifetime. This is
// inherent to decrypt-at-use — createBraveSearchProvider closes over `apiKey` and sends it as
// X-Subscription-Token on every request, so the plaintext lives in the provider closure whether or
// not we also key the cache by it. Hashing the cache key would drop one extra reference, not the
// plaintext, so it buys nothing. The AES-256-GCM at-rest guarantee is unchanged; this is the
// unavoidable in-use exposure, not an at-rest leak.
let providerCache: { apiKey: string; provider: WebSearchProvider } | undefined;

/** Options for {@link setWebSearchKeyResolver}. */
export interface SetWebSearchKeyResolverOptions {
  /**
   * Fired when the resolver throws (bad keyring / corrupted envelope). The composition root wires
   * this to a `warn`-level log emitting `web_search.key_decrypt_failed`. MUST carry metadata only —
   * never the key, ciphertext, envelope, or any derived value (Hard Invariant: secrets never escape).
   * web-research deliberately does not produce the payload itself to stay free of a logger type.
   */
  readonly onDecryptFailed?: () => void;
}

/**
 * Composition-root seam: install the resolver that reads the encrypted instance key, plus an
 * optional notifier for the decrypt-failure observability event (see {@link SetWebSearchKeyResolverOptions}).
 */
export function setWebSearchKeyResolver(
  resolver: WebSearchKeyResolver | undefined,
  options?: SetWebSearchKeyResolverOptions
): void {
  keyResolver = resolver;
  keyDecryptFailedNotifier = options?.onDecryptFailed;
  providerCache = undefined;
}

/** Composition-root seam: install the resolver for model-native (built-in) search. */
export function setModelNativeSearchResolver(resolver: ModelNativeSearchResolver | undefined): void {
  modelNativeResolver = resolver;
  modelNativeProviderCache = undefined;
}

/** Drop the cached providers so the next request re-resolves the key/model (save/revoke hook). */
export function invalidateWebSearchProviderCache(): void {
  providerCache = undefined;
  modelNativeProviderCache = undefined;
}

function providerForKey(apiKey: string): WebSearchProvider {
  if (providerCache && providerCache.apiKey === apiKey) return providerCache.provider;
  const provider = createBraveSearchProvider(apiKey);
  providerCache = { apiKey, provider };
  return provider;
}

function providerForModelNative(resolution: ModelNativeSearchResolution): WebSearchProvider {
  if (modelNativeProviderCache && modelNativeProviderCache.modelId === resolution.modelId) {
    return modelNativeProviderCache.provider;
  }
  const provider = createModelNativeProvider(resolution.runner);
  modelNativeProviderCache = { modelId: resolution.modelId, provider };
  return provider;
}

/**
 * Resolve the active web-search provider for a request. Precedence: test override → decrypted
 * instance key → `JARVIS_BRAVE_SEARCH_API_KEY` env fallback → model-native (built-in) search →
 * unavailable. Decrypt-at-use means a freshly-saved key works without a restart. A failing key
 * resolver (bad keyring/envelope) falls back to the env key rather than breaking chat.
 */
export async function resolveWebSearchProvider(scopedDb: unknown): Promise<WebSearchProvider> {
  if (testSearchProvider) return testSearchProvider;

  let apiKey: string | null = null;
  if (keyResolver) {
    try {
      apiKey = await keyResolver(scopedDb);
    } catch {
      // A configured instance key failed to decrypt (bad keyring / corrupted envelope). Don't
      // break chat — fall back to the env key — but surface the event so an operator can diagnose.
      // The notifier emits metadata only; no key/ciphertext/envelope crosses this boundary.
      keyDecryptFailedNotifier?.();
      apiKey = null;
    }
  }
  if (!apiKey) {
    apiKey = resolveMossEnv(process.env, "JARVIS_BRAVE_SEARCH_API_KEY") || null;
  }
  if (apiKey) return providerForKey(apiKey);

  if (modelNativeResolver) {
    const resolution = await modelNativeResolver(scopedDb);
    if (resolution) return providerForModelNative(resolution);
  }

  return unavailableSearchProvider;
}

export function setWebSearchProviderForTests(provider: WebSearchProvider | undefined): void {
  testSearchProvider = provider;
  // Reset the resolved-key cache so tests that swap or clear the provider never get a stale
  // Brave or model-native instance from a prior resolveWebSearchProvider call.
  providerCache = undefined;
  modelNativeProviderCache = undefined;
}
