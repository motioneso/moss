import type {
  AiAuthMethod,
  AiModelCapability,
  AiModelTier,
  AiProviderDiscoveredModelDto,
  AiProviderKind,
  AiProviderTestResultDto
} from "@moss/shared";
import { decisionModelDialect } from "@moss/shared";

import { inferWebSearchCapability } from "./model-discovery.js";

/** #3057: the Cloudflare Test probe and its two preset-only messages. */
const CLOUDFLARE_TEST_MODEL = "clef-flash";
const NO_MODEL_LIST_MESSAGE =
  "This service does not list its models, so the key could not be checked. Add a model by hand, then try it.";

export interface ProviderValidationInput {
  readonly providerKind: AiProviderKind;
  readonly authMethod: AiAuthMethod;
  readonly baseUrl: string | null;
  readonly credential: unknown;
  readonly fetch?: typeof fetch;
}

export async function testProviderCredential(
  input: ProviderValidationInput
): Promise<AiProviderTestResultDto> {
  if (input.authMethod === "cli") {
    return fail(input.providerKind, "CLI provider testing is not supported yet.");
  }

  const apiKey = readApiKey(input.credential);
  if (!apiKey) return fail(input.providerKind, "Provider credential is missing.");

  try {
    // #3057: a Cloudflare decision model has no models list; its Test sends one fixed probe.
    if (
      input.providerKind === "system-one" &&
      decisionModelDialect(input.baseUrl) === "cloudflare"
    ) {
      return await testCloudflareDecisionModel(input, apiKey);
    }

    const response = await fetchModels(input, apiKey);
    if (response.ok) {
      return {
        ok: true,
        providerKind: input.providerKind,
        message: "Provider credential is valid."
      };
    }
    if (input.providerKind === "system-one" && response.status === 404) {
      // #3057: a decision-model service with no models list is not a rejected key.
      return fail(input.providerKind, NO_MODEL_LIST_MESSAGE);
    }
    return fail(
      input.providerKind,
      response.status === 401 || response.status === 403
        ? "Provider rejected the credential."
        : "Provider test failed."
    );
  } catch {
    return fail(input.providerKind, "Provider test failed.");
  }
}

/**
 * #3057: Cloudflare's decision-model endpoint has no models list, so the credential is checked by
 * sending one tiny fixed yes/no probe through the same URL the sender uses. A 2xx with
 * `success: true` passes; 401/403 means the token was rejected.
 */
async function testCloudflareDecisionModel(
  input: ProviderValidationInput,
  apiKey: string
): Promise<AiProviderTestResultDto> {
  const f = input.fetch ?? globalThis.fetch;
  const base = (input.baseUrl ?? "").replace(/\/+$/, "");

  let response: Response;
  try {
    response = await f(`${base}/run/@cf/cloudflare/${CLOUDFLARE_TEST_MODEL}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: CLOUDFLARE_TEST_MODEL,
        state: { probe: "decision-model-test" },
        questions: { reachable: { type: "noul", instructions: "Answer yes." } }
      }),
      redirect: "error"
    });
  } catch {
    return fail(input.providerKind, "Provider test failed.");
  }

  if (response.status === 401 || response.status === 403) {
    return fail(input.providerKind, "Provider rejected the credential.");
  }
  if (!response.ok) return fail(input.providerKind, "Provider test failed.");

  try {
    const payload = await response.json();
    if (
      payload &&
      typeof payload === "object" &&
      (payload as { success?: unknown }).success === true
    ) {
      return {
        ok: true,
        providerKind: input.providerKind,
        message: "Provider credential is valid."
      };
    }
  } catch {
    // A body that cannot be read is a failed test, handled below.
  }
  return fail(input.providerKind, "Provider test failed.");
}

export async function discoverProviderModels(
  input: ProviderValidationInput
): Promise<AiProviderDiscoveredModelDto[]> {
  if (input.authMethod === "cli") return [];
  const apiKey = readApiKey(input.credential);
  if (!apiKey) return [];

  try {
    const response = await fetchModels(input, apiKey);
    if (!response.ok) return [];
    return extractModelIds(await response.json()).map((id) => suggestModel(id, input.providerKind));
  } catch {
    return [];
  }
}

function fail(providerKind: AiProviderKind, message: string): AiProviderTestResultDto {
  return { ok: false, providerKind, message };
}

function readApiKey(credential: unknown): string | null {
  if (!credential || typeof credential !== "object") return null;
  const value = (credential as { apiKey?: unknown }).apiKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fetchModels(input: ProviderValidationInput, apiKey: string): Promise<Response> {
  const f = input.fetch ?? globalThis.fetch;
  switch (input.providerKind) {
    case "anthropic":
      return f("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      });
    case "google":
      return f("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": apiKey }
      });
    case "system-one": {
      // TypeSafe's System One API serves only `GET /v1/models` and `POST /v1/systemone`; the
      // latter takes fixed named questions, so this kind can never ride the chat-completions path.
      const base = (input.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "");
      return f(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } });
    }
    case "openai-compatible":
    case "ollama":
    case "custom": {
      const base = (input.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
      return f(`${base}/v1/models`, { headers: { authorization: `Bearer ${apiKey}` } });
    }
  }
}

function extractModelIds(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data
      .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
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

function suggestModel(
  providerModelId: string,
  providerKind: AiProviderKind
): AiProviderDiscoveredModelDto {
  if (providerKind === "system-one") {
    // System One answers named questions, not chat; json is the only capability it can serve and
    // its models are cheap economy picks for the focus judgment.
    return {
      providerModelId,
      displayName: providerModelId,
      capabilities: ["json"],
      tier: "economy"
    };
  }
  const lower = providerModelId.toLowerCase();
  const capabilities: AiModelCapability[] = ["chat", "tool-use", "json", "summarization"];
  if (lower.includes("vision") || lower.includes("image") || lower.includes("gemini")) {
    capabilities.push("vision");
  }
  if (inferWebSearchCapability(providerKind, providerModelId)) {
    capabilities.push("web-search");
  }

  let tier: AiModelTier = "interactive";
  if (lower.includes("mini") || lower.includes("haiku") || lower.includes("flash")) {
    tier = "economy";
  } else if (lower.includes("opus") || lower.includes("reason")) {
    tier = "reasoning";
  }

  return { providerModelId, displayName: providerModelId, capabilities, tier };
}
