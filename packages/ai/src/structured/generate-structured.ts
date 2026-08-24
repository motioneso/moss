import { Ajv, type ErrorObject } from "ajv";
import type { FastifyBaseLogger } from "fastify";

import type { DataContextDb } from "@moss/db";
import type { AiModelTier, ModuleServiceKey } from "@moss/shared";

import { HttpApiAdapter } from "../adapters/http-api.js";
import {
  StructuredOutputParseError,
  type GenerateStructuredProviderInput,
  type StructuredChatTurn,
  type StructuredRunScope,
  type StructuredRunPriority,
  type StructuredTelemetry,
  type StructuredProviderResult,
  type StructuredUsage
} from "../adapters/http-api-structured.js";
import type { ProviderKind } from "../adapters/transcript-reader.js";
import { parseAiApiKeyCredential } from "../credentials.js";
import type { AiSecretCipher } from "../crypto.js";
import type { AiRepository } from "../repository.js";
import {
  STRUCTURED_DEFAULT_MAX_OUTPUT_TOKENS,
  STRUCTURED_RESULT_MAX_BYTES,
  assertBoundedStructuredPrompt,
  assertBoundedStructuredSchema
} from "./schema-bounds.js";

export const STRUCTURED_MAX_REPAIR_RETRIES = 2;

export type StructuredProviderAdapter = {
  generateStructured(input: GenerateStructuredProviderInput): Promise<StructuredProviderResult>;
};

export type GenerateStructuredDeps = {
  readonly repository: Pick<
    AiRepository,
    "resolveModelForService" | "selectProviderWithCredential"
  >;
  readonly cipher: Pick<AiSecretCipher, "decryptJson">;
  readonly logger?: Pick<FastifyBaseLogger, "info" | "warn">;
  readonly createAdapter?: (
    kind: ProviderKind,
    apiKey: string,
    baseUrl: string | null
  ) => StructuredProviderAdapter;
  /** #982/#869/#981: implemented by chat and injected at module-registry; ai never imports chat. */
  readonly createCliStructuredAdapter?: (kind: ProviderKind) => StructuredProviderAdapter;
};

export type GenerateStructuredInput = {
  readonly service: ModuleServiceKey;
  readonly schema: Record<string, unknown>;
  readonly prompt: string;
  readonly tierHint?: AiModelTier;
  readonly requireExplicitBinding?: boolean;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  readonly telemetry?: StructuredTelemetry;
  readonly priority?: StructuredRunPriority;
  readonly scope?: StructuredRunScope;
  readonly closeScope?: boolean;
};

export type GenerateStructuredResult =
  | { readonly ok: true; readonly object: unknown; readonly usage: StructuredUsage }
  | {
      readonly ok: false;
      readonly error: "needs_config" | "validation_failed" | "provider_error" | "aborted";
    };

export async function generateStructured(
  scopedDb: DataContextDb,
  input: GenerateStructuredInput,
  deps: GenerateStructuredDeps
): Promise<GenerateStructuredResult> {
  assertBoundedStructuredSchema(input.schema);
  assertBoundedStructuredPrompt(input.prompt);

  const route = await deps.repository.resolveModelForService(scopedDb, input.service, {
    capability: "json",
    tierHint: input.tierHint,
    requireExplicitBinding: input.requireExplicitBinding
  });
  if (!route.model) return { ok: false, error: "needs_config" };
  const model = route.model;

  const provider = await deps.repository.selectProviderWithCredential(
    scopedDb,
    model.provider_config_id
  );
  if (!provider) return { ok: false, error: "needs_config" };

  if (
    model.provider_kind !== "anthropic" &&
    model.provider_kind !== "openai-compatible" &&
    model.provider_kind !== "google"
  ) {
    deps.logger?.warn(
      { service: input.service, providerKind: model.provider_kind },
      "ai.structured unsupported provider kind"
    );
    return { ok: false, error: "provider_error" };
  }
  const providerKind = model.provider_kind as ProviderKind;
  let adapter: StructuredProviderAdapter;
  if (provider.auth_method === "cli") {
    // #982/#869/#981 D3: CLI credentials are sealed markers, not API keys. Route before decrypt so
    // AES-GCM can never see `{ cli: true }`; composition root supplies chat's CLI implementation.
    if (!deps.createCliStructuredAdapter) return { ok: false, error: "needs_config" };
    adapter = deps.createCliStructuredAdapter(providerKind);
  } else {
    let credential;
    try {
      credential = parseAiApiKeyCredential(deps.cipher.decryptJson(provider.encrypted_credential));
    } catch {
      // #981 defense-in-depth: never log ciphertext, credential material, or raw AES-GCM errors.
      deps.logger?.warn(
        { service: input.service, providerKind },
        "ai.structured credential could not be decrypted"
      );
      return { ok: false, error: "needs_config" };
    }
    if (!credential) return { ok: false, error: "needs_config" };
    const createAdapter =
      deps.createAdapter ??
      ((kind: ProviderKind, apiKey: string, baseUrl: string | null) =>
        new HttpApiAdapter(kind, apiKey, baseUrl ? { baseUrl } : {}));
    adapter = createAdapter(providerKind, credential.apiKey, provider.base_url ?? null);
  }

  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validate = ajv.compile(input.schema);
  const maxOutputTokens = input.maxOutputTokens ?? STRUCTURED_DEFAULT_MAX_OUTPUT_TOKENS;
  const messages: StructuredChatTurn[] = [{ role: "user", content: input.prompt }];
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 0; attempt <= STRUCTURED_MAX_REPAIR_RETRIES; attempt += 1) {
    if (input.signal?.aborted) return { ok: false, error: "aborted" };

    let result: Extract<StructuredProviderResult, { readonly rawObject: unknown }>;
    try {
      const generated = await adapter.generateStructured({
        service: input.service,
        model: { provider_kind: providerKind, provider_model_id: model.provider_model_id },
        messages,
        schema: input.schema,
        maxOutputTokens,
        signal: input.signal,
        telemetry: input.telemetry,
        priority: input.priority,
        scope: input.scope,
        closeScope: input.closeScope
      });
      if ("rawText" in generated) {
        try {
          result = { rawObject: JSON.parse(generated.rawText), usage: generated.usage };
        } catch {
          throw new StructuredOutputParseError(
            "CLI output is not valid JSON",
            generated.rawText,
            generated.usage
          );
        }
      } else {
        result = generated;
      }
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return { ok: false, error: "aborted" };
      }
      if (error instanceof StructuredOutputParseError) {
        input.telemetry?.emit({ kind: "parse" });
        usage.inputTokens += error.usage.inputTokens;
        usage.outputTokens += error.usage.outputTokens;
        messages.push({ role: "assistant", content: error.rawText });
        messages.push({
          role: "user",
          content:
            "That output was not valid JSON for the required schema. Respond again with ONLY a JSON object matching the schema."
        });
        input.telemetry?.emit({ kind: "repair" });
        continue;
      }
      deps.logger?.warn(
        { service: input.service, name: error instanceof Error ? error.name : "UnknownError" },
        "ai.structured provider error"
      );
      return { ok: false, error: "provider_error" };
    }

    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    const serialized = JSON.stringify(result.rawObject) ?? "";
    if (Buffer.byteLength(serialized, "utf8") > STRUCTURED_RESULT_MAX_BYTES) break;

    if (validate(result.rawObject)) {
      deps.logger?.info(
        {
          service: input.service,
          modelId: model.id,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          attempts: attempt + 1
        },
        "ai.structured usage"
      );
      return { ok: true, object: result.rawObject, usage };
    }

    messages.push({ role: "assistant", content: serialized.slice(0, 4000) });
    messages.push({ role: "user", content: formatValidationErrors(validate.errors ?? []) });
    input.telemetry?.emit({ kind: "repair" });
  }

  return { ok: false, error: "validation_failed" };
}

function formatValidationErrors(errors: readonly ErrorObject[]): string {
  const lines = errors
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"}: ${error.message ?? "invalid"}`);
  return `The JSON did not match the required schema:\n${lines.join("\n")}\nRespond again with ONLY a corrected JSON object matching the schema.`.slice(
    0,
    1000
  );
}
