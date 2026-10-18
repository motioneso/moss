import type { ApiKeyChatReadinessStatus } from "@moss/shared";

import {
  readCliToolVersions,
  type CliToolVersionReader,
  type CliToolVersions
} from "./cli-tool-versions.js";
import { providerBaseUrl } from "./provider-base-url.js";
import {
  PROVIDER_CREDENTIAL_MISSING_MESSAGE,
  PROVIDER_REJECTED_CREDENTIAL_MESSAGE,
  testProviderCredential
} from "./provider-validation.js";

/** Kinds whose API-key rows can drive chat: the claude agent and OpenCode. */
export type ApiKeyChatProviderKind = "anthropic" | "openai-compatible";

export function isApiKeyChatProviderKind(kind: string): kind is ApiKeyChatProviderKind {
  return kind === "anthropic" || kind === "openai-compatible";
}

export interface ApiKeyChatReadinessInput {
  readonly providerId: string;
  readonly providerKind: ApiKeyChatProviderKind;
  readonly baseUrl: string | null;
  /** Moves when the key is edited, so it invalidates the cache. */
  readonly updatedAt: Date;
  /** Decrypts the stored credential. Called only on a cache miss. */
  readonly openCredential: () => unknown;
}

export interface ApiKeyChatReadinessOptions {
  readonly cliToolVersionReader?: CliToolVersionReader;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

interface CachedStatus {
  readonly status: ApiKeyChatReadinessStatus;
  readonly expiresAt: number;
}

/**
 * Readiness for an API-key chat row. The sidecar must report the agent program installed, and the
 * provider's models list must answer with the stored address and key. Results are cached by row
 * id and update time, never by key.
 */
export class ApiKeyChatReadiness {
  private readonly cache = new Map<string, CachedStatus>();

  constructor(private readonly options: ApiKeyChatReadinessOptions = {}) {}

  async check(input: ApiKeyChatReadinessInput): Promise<ApiKeyChatReadinessStatus> {
    const now = this.options.now?.() ?? Date.now();
    const cacheKey = `${input.providerId}:${input.updatedAt.getTime()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.status;

    const status = await this.probe(input);

    // A runner outage says nothing about the row, so it is never cached.
    if (status !== "runner_unavailable") {
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(key);
      }
      this.cache.set(cacheKey, { status, expiresAt: now + CACHE_TTL_MS });
    }
    return status;
  }

  private async probe(input: ApiKeyChatReadinessInput): Promise<ApiKeyChatReadinessStatus> {
    const versions = await readCliToolVersions(this.options.cliToolVersionReader);
    if (!versions) return "runner_unavailable";
    if (agentVersion(versions, input.providerKind) === null) return "agent_missing";

    let credential: unknown;
    try {
      credential = input.openCredential();
    } catch {
      return "needs_key";
    }

    const baseFetch = this.options.fetch ?? fetch;
    const result = await testProviderCredential({
      providerKind: input.providerKind,
      authMethod: "api_key",
      baseUrl: providerBaseUrl(input.providerKind, input.baseUrl),
      credential,
      fetch: (url, init) =>
        baseFetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    });
    if (result.ok) return "ready";
    if (result.message === PROVIDER_CREDENTIAL_MISSING_MESSAGE) return "needs_key";
    if (result.message === PROVIDER_REJECTED_CREDENTIAL_MESSAGE) return "rejected_key";
    return "unreachable";
  }
}

function agentVersion(versions: CliToolVersions, kind: ApiKeyChatProviderKind): string | null {
  return kind === "anthropic" ? versions.providers.anthropic : versions.opencode;
}
