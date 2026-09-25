import type { DataContextDb } from "@moss/db";
import type { ModuleServiceKey } from "@moss/shared";

import { HttpApiAdapter } from "./adapters/http-api.js";
import type { StructuredRunPriority } from "./adapters/http-api-structured.js";
import type { ProviderKind } from "./adapters/transcript-reader.js";
import type { ChatProviderAdapter, ChatTurn } from "./chat-adapter.js";
import { parseAiApiKeyCredential } from "./credentials.js";
import type { AiSecretCipher } from "./crypto.js";
import type { AiRepository } from "./repository.js";
import type { GenerateStructuredDeps } from "./structured/generate-structured.js";
import { raceAbort, unfence } from "./structured/run-helpers.js";

/**
 * Free-text generation on one configured model, whatever its provider's sign-in method. Callers
 * pick the model (capability routing, service binding); this only runs it. A subscription-login
 * provider goes through the CLI transport chat uses, injected at the composition root because ai
 * never imports chat. An API-key provider goes through the HTTP adapter.
 */

export type GenerateTextModel = {
  readonly id: string;
  readonly provider_config_id: string;
  readonly provider_kind: string;
  readonly provider_model_id: string;
};

export type GenerateTextInput = {
  readonly model: GenerateTextModel;
  readonly messages: readonly ChatTurn[];
  readonly maxOutputTokens: number;
  /** Keys the CLI transport's stable one-shot working directory. */
  readonly service?: ModuleServiceKey;
  readonly signal?: AbortSignal;
  readonly priority?: StructuredRunPriority;
};

export type GenerateTextDeps = {
  readonly repository: Pick<AiRepository, "selectProviderWithCredential">;
  readonly cipher: Pick<AiSecretCipher, "decryptJson">;
  readonly createAdapter?: (
    kind: ProviderKind,
    apiKey: string,
    baseUrl: string | null
  ) => Pick<ChatProviderAdapter, "generateChat">;
  readonly createCliStructuredAdapter?: GenerateStructuredDeps["createCliStructuredAdapter"];
};

export type GenerateTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: "needs_config" | "provider_error" | "aborted" };

// The CLI transport only speaks structured JSON, so free text travels as one string field.
const TEXT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false
} as const;

export async function generateText(
  scopedDb: DataContextDb,
  input: GenerateTextInput,
  deps: GenerateTextDeps
): Promise<GenerateTextResult> {
  if (input.signal?.aborted) return { ok: false, error: "aborted" };
  const requested = input.model.provider_kind;
  if (requested !== "anthropic" && requested !== "openai-compatible" && requested !== "google") {
    return { ok: false, error: "provider_error" };
  }
  const kind: ProviderKind = requested;
  const model = { provider_kind: kind, provider_model_id: input.model.provider_model_id };

  const provider = await deps.repository.selectProviderWithCredential(
    scopedDb,
    input.model.provider_config_id
  );
  if (!provider) return { ok: false, error: "needs_config" };

  let run: () => Promise<string>;
  if (provider.auth_method === "cli") {
    // A login provider stores a sealed marker, not a key. Route before decrypt.
    const createCli = deps.createCliStructuredAdapter;
    if (!createCli) return { ok: false, error: "needs_config" };
    run = async () =>
      readText(
        await createCli(kind).generateStructured({
          service: input.service,
          model,
          messages: input.messages,
          schema: TEXT_SCHEMA,
          maxOutputTokens: input.maxOutputTokens,
          signal: input.signal,
          priority: input.priority
        })
      );
  } else {
    let apiKey: string;
    try {
      const credential = parseAiApiKeyCredential(
        deps.cipher.decryptJson(provider.encrypted_credential)
      );
      if (!credential) return { ok: false, error: "needs_config" };
      apiKey = credential.apiKey;
    } catch {
      // Never surface the raw error: it can carry credential material.
      return { ok: false, error: "needs_config" };
    }
    const adapter = (deps.createAdapter ?? defaultCreateAdapter)(
      kind,
      apiKey,
      provider.base_url ?? null
    );
    run = async () =>
      (
        await adapter.generateChat({
          model,
          messages: input.messages,
          maxOutputTokens: input.maxOutputTokens
        })
      ).text;
  }

  try {
    const text = await raceAbort(run(), input.signal);
    return input.signal?.aborted ? { ok: false, error: "aborted" } : { ok: true, text };
  } catch {
    return input.signal?.aborted
      ? { ok: false, error: "aborted" }
      : { ok: false, error: "provider_error" };
  }
}

function defaultCreateAdapter(kind: ProviderKind, apiKey: string, baseUrl: string | null) {
  return new HttpApiAdapter(kind, apiKey, baseUrl ? { baseUrl } : {});
}

function readText(result: { readonly rawObject?: unknown; readonly rawText?: string }): string {
  const value = "rawText" in result ? JSON.parse(unfence(result.rawText ?? "")) : result.rawObject;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { text?: unknown }).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  throw new Error("Model transport returned no text");
}
