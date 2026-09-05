/**
 * #2208 MODEL-LIST ADAPTERS — one per provider kind, registered next to the login adapters.
 *
 * No CLI (`claude`, `codex`, `gemini`) has a list-models command, but the credential the runner
 * already holds for a logged-in provider is enough to ask the vendor for its live list. Each
 * adapter reads that credential from the cli-auth home base ONLY, bounds the vendor call at
 * {@link MODEL_LIST_TIMEOUT_MS}, and returns model IDS ONLY: the credential is never returned,
 * logged, or embedded in an error message (spec 2026-09-03-discover-cli-provider-models §1).
 *
 *   - anthropic: the persisted `setup-token` (provider-token-store) as a Bearer on
 *     `GET /v1/models`. The file may carry a leading `CLAUDE_CODE_OAUTH_TOKEN=` prefix (seen on
 *     dev — the CLI tolerates it); it is stripped here.
 *   - openai-compatible (codex): `<homeBase>/.codex/auth.json` → `tokens.access_token` +
 *     `tokens.account_id` against the codex backend. The `client_version` query param MUST be the
 *     installed CLI's real version or the list comes back empty, so it is read once from
 *     `codex --version` and cached.
 *   - google (gemini): `unsupported` — not verifiable yet (follow-up issue).
 *
 * SERVER-SIDE ONLY (cli-runner): the vendor endpoints and credential file layouts are runner
 * knowledge and must never ship to the browser bundle.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { TmuxIo } from "@moss/ai";
import type { RpcListProviderModelsResult, RpcProviderKind } from "@moss/chat/live";

import { readProviderToken } from "./provider-token-store.js";

/** Bound on every vendor call (spec §1). */
export const MODEL_LIST_TIMEOUT_MS = 5_000;

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
/** The env-var name the claude CLI reads the token from; a persisted file may be prefixed with it. */
const ANTHROPIC_TOKEN_PREFIX = "CLAUDE_CODE_OAUTH_TOKEN=";

export interface ModelListAdapterDeps {
  /** The cli-auth HOME base the credentials live under. Absent ⇒ every provider is `not_logged_in`. */
  readonly homeBase?: string;
  /** The vendor HTTP client; injected by tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** The sanitized execFile-style runner, used ONLY to read `codex --version`. */
  readonly io?: Pick<TmuxIo, "run">;
  /** Optional override of the codex CLI version (tests / a pre-read value). */
  readonly codexVersion?: () => Promise<string | undefined>;
  /**
   * #2242: called when the vendor rejects the stored credential itself (HTTP 401). This call and
   * the readiness check use the SAME credential against the SAME vendor, so a rejection here is a
   * rejection there — the host uses this to record that the login now needs redoing instead of
   * leaving a saved "the login works" answer standing. Not called for other HTTP failures: a 403
   * is an authenticated request that was not permitted, and a 5xx is the vendor's own fault.
   */
  readonly onLoginRejected?: () => void;
}

export type ModelListAdapter = (deps: ModelListAdapterDeps) => Promise<RpcListProviderModelsResult>;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** Strip a leading `CLAUDE_CODE_OAUTH_TOKEN=` (any case-exact prefix match) and surrounding space. */
export function stripAnthropicTokenPrefix(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith(ANTHROPIC_TOKEN_PREFIX)
    ? trimmed.slice(ANTHROPIC_TOKEN_PREFIX.length).trim()
    : trimmed;
}

/** Keep only current claude- ids; legacy snapshot versions contain ":". */
export function filterAnthropicModelIds(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id) => id.includes("claude-") && !id.includes(":"));
}

/** Keep only listable codex models (`visibility === "list"`); the id is the `slug`. */
export function filterCodexModelIds(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const models = (json as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models
    .filter(
      (item): item is { slug: string; visibility?: unknown } =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as { slug?: unknown }).slug === "string" &&
        (item as { slug: string }).slug.length > 0
    )
    .filter((item) => item.visibility === "list")
    .map((item) => item.slug);
}

/** `codex --version` prints e.g. `codex-cli 0.139.0`; return the bare semver or undefined. */
export function parseCodexVersion(stdout: string): string | undefined {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout);
  return match?.[1];
}

/**
 * Build a `codex --version` reader that runs the CLI at most once per runner process (a failed
 * read is NOT cached, so a later install of the CLI is picked up on the next call).
 */
export function createCodexVersionReader(
  io: Pick<TmuxIo, "run"> | undefined
): () => Promise<string | undefined> {
  let cached: string | undefined;
  return async () => {
    if (cached) return cached;
    if (!io) return undefined;
    try {
      const result = await io.run("codex", ["--version"]);
      const version = result.code === 0 ? parseCodexVersion(result.stdout) : undefined;
      if (version) cached = version;
      return version;
    } catch {
      return undefined;
    }
  };
}

/** The one HTTP status that means the credential itself was rejected, not the request. */
const CREDENTIAL_REJECTED_STATUS = 401;

/**
 * A vendor error message that carries the HTTP status only — never a body (it could echo a token).
 *
 * #2242: a 401 is reported as `not_logged_in`, not a plain `error`. The vendor DID answer; it
 * refused the stored sign-in, so "Could not reach the provider" would be untrue and would send
 * someone off retrying instead of logging back in. Every other status stays a plain error: a 403
 * is a request that was allowed to authenticate but not permitted, and a 5xx is the vendor's fault.
 */
function httpFailure(status: number, onLoginRejected?: () => void): RpcListProviderModelsResult {
  const message = `model list request failed with HTTP ${status}`;
  if (status === CREDENTIAL_REJECTED_STATUS) {
    onLoginRejected?.();
    return { status: "not_logged_in", message };
  }
  return { status: "error", message };
}

/** A transport/timeout error, reduced to its class — never the raw message (could carry a URL/token). */
function transportFailure(err: unknown): RpcListProviderModelsResult {
  const name = err instanceof Error ? err.name : "Error";
  return {
    status: "error",
    message:
      name === "TimeoutError" || name === "AbortError"
        ? `model list request timed out after ${MODEL_LIST_TIMEOUT_MS} ms`
        : "model list request failed (network error)"
  };
}

async function fetchJson(
  f: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
  onLoginRejected?: () => void
): Promise<{ ok: true; json: unknown } | { ok: false; result: RpcListProviderModelsResult }> {
  let response: Response;
  try {
    response = await f(url, { headers, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, result: transportFailure(err) };
  }
  if (!response.ok) return { ok: false, result: httpFailure(response.status, onLoginRejected) };
  try {
    return { ok: true, json: await response.json() };
  } catch {
    return { ok: false, result: { status: "error", message: "model list response was not JSON" } };
  }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const anthropicAdapter: ModelListAdapter = async (deps) => {
  if (!deps.homeBase) return { status: "not_logged_in" };
  const stored = await readProviderToken(deps.homeBase, "anthropic");
  const token = stored ? stripAnthropicTokenPrefix(stored) : "";
  if (!token) return { status: "not_logged_in" };
  const outcome = await fetchJson(
    deps.fetch ?? globalThis.fetch,
    ANTHROPIC_MODELS_URL,
    {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20"
    },
    deps.onLoginRejected
  );
  if (!outcome.ok) return outcome.result;
  return { status: "ok", models: filterAnthropicModelIds(outcome.json).map((id) => ({ id })) };
};

/** `<homeBase>/.codex/auth.json` — the file the codex CLI writes at login. */
export function codexAuthPath(homeBase: string): string {
  return path.join(homeBase, ".codex", "auth.json");
}

async function readCodexAuth(
  homeBase: string
): Promise<{ accessToken: string; accountId: string } | undefined> {
  let raw: string;
  try {
    raw = await readFile(codexAuthPath(homeBase), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown; account_id?: unknown } };
    const accessToken = parsed?.tokens?.access_token;
    const accountId = parsed?.tokens?.account_id;
    if (typeof accessToken !== "string" || accessToken.length === 0) return undefined;
    if (typeof accountId !== "string" || accountId.length === 0) return undefined;
    return { accessToken, accountId };
  } catch {
    return undefined;
  }
}

const codexAdapter: ModelListAdapter = async (deps) => {
  if (!deps.homeBase) return { status: "not_logged_in" };
  const auth = await readCodexAuth(deps.homeBase);
  if (!auth) return { status: "not_logged_in" };
  const readVersion = deps.codexVersion ?? createCodexVersionReader(deps.io);
  const version = await readVersion();
  if (!version) {
    return { status: "error", message: "could not read the installed codex CLI version" };
  }
  const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(version)}`;
  const outcome = await fetchJson(
    deps.fetch ?? globalThis.fetch,
    url,
    {
      authorization: `Bearer ${auth.accessToken}`,
      "ChatGPT-Account-Id": auth.accountId
    },
    deps.onLoginRejected
  );
  if (!outcome.ok) return outcome.result;
  return { status: "ok", models: filterCodexModelIds(outcome.json).map((id) => ({ id })) };
};

const googleAdapter: ModelListAdapter = async () => ({
  status: "unsupported",
  message: "this provider cannot list its models yet"
});

/** THE registry: a provider absent here is `unsupported`. */
export const MODEL_LIST_ADAPTERS: Readonly<Record<RpcProviderKind, ModelListAdapter>> = {
  anthropic: anthropicAdapter,
  "openai-compatible": codexAdapter,
  google: googleAdapter
};

/**
 * #2242 (round 3): prove a saved sign-in against the vendor for real, using the same request the
 * model list makes. Needed for codex, whose own readiness check only asks the local tool whether
 * it is holding a sign-in file — that check cannot tell a refused sign-in from a good one, so it
 * must never be what clears a recorded refusal. Returns "accepted" only when the vendor answered
 * with a list; "refused" when it turned the sign-in down; "unknown" for anything else (the vendor
 * being unreachable or broken), which leaves a recorded refusal exactly as it was.
 */
export async function verifyProviderCredential(
  provider: RpcProviderKind,
  deps: ModelListAdapterDeps
): Promise<"accepted" | "refused" | "unknown"> {
  const result = await listProviderModels(provider, deps);
  if (result.status === "ok") return "accepted";
  if (result.status === "not_logged_in") return "refused";
  return "unknown";
}

/** Run the provider's adapter; an adapter throw becomes a plain `error` (no secret can leak via message). */
export async function listProviderModels(
  provider: RpcProviderKind,
  deps: ModelListAdapterDeps
): Promise<RpcListProviderModelsResult> {
  const adapter = MODEL_LIST_ADAPTERS[provider];
  if (!adapter) return { status: "unsupported" };
  try {
    return await adapter(deps);
  } catch {
    return { status: "error", message: "model list failed unexpectedly" };
  }
}
