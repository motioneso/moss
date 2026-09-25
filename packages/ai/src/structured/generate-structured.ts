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
import { raceAbort, unfence } from "./run-helpers.js";

export const STRUCTURED_MAX_REPAIR_RETRIES = 2;

/**
 * Error names whose class doc comment guarantees an operator-safe message (no secrets, no raw
 * provider/response content) — compared by name (a plain string), not `instanceof`, so this stays
 * decoupled from the class that throws them.
 */
const OPERATOR_SAFE_ERROR_NAMES = new Set([
  "CliChatUnavailableError",
  "CliChatDeliveryUnknownError"
]);

/**
 * S2: turn a caught adapter error into a fixed, allow-listed diagnostic code instead of logging its
 * message. `HttpApiAdapter.generateStructured` calls `response.json()`, and a malformed-but-successful
 * response makes Node fold the raw response body into `SyntaxError.message` — logging that message
 * would leak private response content into application logs. Everything not on the allow-list below
 * collapses to "provider_error_unclassified" rather than falling back to the raw text.
 */
export function classifyStructuredProviderErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "provider_error_unclassified";
  if (OPERATOR_SAFE_ERROR_NAMES.has(error.name)) return error.name;
  if (error instanceof SyntaxError) return "invalid_response_body";
  const httpStatusMatch = /HTTP (\d{3})$/.exec(error.message);
  if (httpStatusMatch) return `http_${httpStatusMatch[1]}`;
  if (/^No .+ in .+ response/.test(error.message) || /^No .+ response$/.test(error.message)) {
    return "empty_provider_response";
  }
  if (error.message.startsWith("Unsupported provider kind")) return "unsupported_provider_kind";
  return "provider_error_unclassified";
}

export type StructuredProviderAdapter = {
  generateStructured(input: GenerateStructuredProviderInput): Promise<StructuredProviderResult>;
};

export type GenerateStructuredDeps = {
  readonly repository: Pick<
    AiRepository,
    "resolveModelForService" | "selectProviderWithCredential"
  > &
    Partial<Pick<AiRepository, "resolveSortingModel">>;
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
  /** #2228: let the model use its own built-in web search tool while producing this result. */
  readonly nativeSearch?: boolean;
  /**
   * #2228: run against this exact model instead of routing by service binding. Used by
   * model-native web search, which must use the actor's own chat model (spec decision 2), not
   * whichever JSON model the calling module is bound to.
   */
  readonly explicitModel?: GenerateStructuredExplicitModel;
  readonly signal?: AbortSignal;
  readonly telemetry?: StructuredTelemetry;
  readonly priority?: StructuredRunPriority;
  readonly scope?: StructuredRunScope;
  readonly closeScope?: boolean;
  /** #2594: try the admin's sorting model first, then today's path once if it fails. */
  readonly sorting?: true;
  /**
   * #2594: the role this run should be logged under. The sorting-question path passes an explicit
   * sorting model through the structured path, so its usage must not be logged as the main model.
   */
  readonly servedByLabel?: StructuredServedBy;
};

export type GenerateStructuredExplicitModel = {
  readonly id: string;
  readonly provider_config_id: string;
  readonly provider_kind: string;
  readonly provider_model_id: string;
};

export type StructuredServedBy = "sorting" | "main";

type StructuredFailure = "needs_config" | "validation_failed" | "provider_error" | "aborted";

export type GenerateStructuredResult =
  | {
      readonly ok: true;
      readonly object: unknown;
      readonly usage: StructuredUsage;
      readonly sources?: readonly { readonly title: string; readonly url: string }[];
      /** Always set by generateStructured. Optional so hand-built results in tests compile. */
      readonly servedBy?: StructuredServedBy;
    }
  | { readonly ok: false; readonly error: StructuredFailure };

type SortingFailure = Exclude<StructuredFailure, "aborted">;

type RunOptions = {
  readonly maxAttempts: number;
  readonly signal: AbortSignal | undefined;
  readonly servedBy: StructuredServedBy;
};

export async function generateStructured(
  scopedDb: DataContextDb,
  input: GenerateStructuredInput,
  deps: GenerateStructuredDeps
): Promise<GenerateStructuredResult> {
  assertBoundedStructuredSchema(input.schema);
  assertBoundedStructuredPrompt(input.prompt);

  let sortingFailure: { readonly modelId: string; readonly error: SortingFailure } | null = null;
  if (input.sorting) {
    if (input.signal?.aborted) return { ok: false, error: "aborted" };
    const sortingModel = input.explicitModel
      ? null
      : ((await deps.repository.resolveSortingModel?.(scopedDb, input.service, {
          requireExplicitBinding: input.requireExplicitBinding
        })) ?? null);
    if (sortingModel) {
      // No time limit of its own, matching the main model. One try, on the caller's signal.
      const attempt = await runOnModel(scopedDb, input, deps, sortingModel, {
        maxAttempts: 1,
        signal: input.signal,
        servedBy: "sorting"
      });
      if (attempt.ok) return { ...attempt, servedBy: "sorting" };
      if (input.signal?.aborted) return { ok: false, error: "aborted" };
      // An abort the caller did not ask for came from the provider itself.
      sortingFailure = {
        modelId: sortingModel.id,
        error: attempt.error === "aborted" ? "provider_error" : attempt.error
      };
    }
  }

  const model =
    input.explicitModel ??
    (
      await deps.repository.resolveModelForService(scopedDb, input.service, {
        capability: "json",
        tierHint: input.tierHint,
        requireExplicitBinding: input.requireExplicitBinding
      })
    ).model;

  if (sortingFailure) {
    deps.logger?.info(
      { service: input.service, servedBy: "main", sortingFailure: sortingFailure.error },
      "ai.structured sorting fallback"
    );
    // Asking the same model twice would only double the wait.
    if (model?.id === sortingFailure.modelId) {
      return { ok: false, error: sortingFailure.error };
    }
  }
  if (!model) return { ok: false, error: "needs_config" };

  const result = await runOnModel(scopedDb, input, deps, model, {
    maxAttempts: STRUCTURED_MAX_REPAIR_RETRIES + 1,
    signal: input.signal,
    servedBy: input.servedByLabel ?? "main"
  });
  return result.ok ? { ...result, servedBy: input.servedByLabel ?? "main" } : result;
}

async function runOnModel(
  scopedDb: DataContextDb,
  input: GenerateStructuredInput,
  deps: GenerateStructuredDeps,
  model: GenerateStructuredExplicitModel,
  options: RunOptions
): Promise<GenerateStructuredResult> {
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

  const signal = options.signal;
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validate = ajv.compile(input.schema);
  const maxOutputTokens = input.maxOutputTokens ?? STRUCTURED_DEFAULT_MAX_OUTPUT_TOKENS;
  const messages: StructuredChatTurn[] = [{ role: "user", content: input.prompt }];
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    if (signal?.aborted) return { ok: false, error: "aborted" };

    let result: Extract<StructuredProviderResult, { readonly rawObject: unknown }>;
    try {
      // The race stops adapters that ignore the signal, such as CLI-backed ones.
      const generated = await raceAbort(
        adapter.generateStructured({
          service: input.service,
          model: { provider_kind: providerKind, provider_model_id: model.provider_model_id },
          messages,
          schema: input.schema,
          maxOutputTokens,
          nativeSearch: input.nativeSearch,
          signal,
          telemetry: input.telemetry,
          priority: input.priority,
          scope: input.scope,
          closeScope: input.closeScope
        }),
        signal
      );
      if (signal?.aborted) return { ok: false, error: "aborted" };
      if ("rawText" in generated) {
        try {
          result = {
            rawObject: JSON.parse(unfence(generated.rawText)),
            usage: generated.usage,
            ...(generated.sources && generated.sources.length > 0
              ? { sources: generated.sources }
              : {})
          };
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
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
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
        {
          service: input.service,
          name: error instanceof Error ? error.name : "UnknownError",
          // S2: never log the raw exception message here. A malformed-but-successful HTTP response
          // makes Node's JSON parser fold the response body into `SyntaxError.message`, and adapter
          // errors in general are not guaranteed operator-safe (the #2229 comment this replaced
          // pointed at a credential-decryption catch that protects a different operation). Log only
          // a fixed diagnostic code, never the message text itself.
          code: classifyStructuredProviderErrorCode(error)
        },
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
          servedBy: options.servedBy,
          modelId: model.id,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          attempts: attempt + 1
        },
        "ai.structured usage"
      );
      const sources = "sources" in result ? result.sources : undefined;
      return { ok: true, object: result.rawObject, usage, ...(sources ? { sources } : {}) };
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
