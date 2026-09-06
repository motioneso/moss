import type {
  AiAuthMethod,
  AiModelCapability,
  AiModelTier,
  AiProviderDiscoveredModelDto,
  AiProviderKind,
  AiProviderTestResultDto
} from "@moss/shared";

import { inferWebSearchCapability } from "./model-discovery.js";

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
    const response = await fetchModels(input, apiKey);
    if (response.ok) {
      return {
        ok: true,
        providerKind: input.providerKind,
        message: "Provider credential is valid."
      };
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
  return typeof value === "string" && value.trim() ? value : null;
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
