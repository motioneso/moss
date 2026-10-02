import type { FastifyBaseLogger } from "fastify";

import type { DataContextDb } from "@moss/db";
import type { ModuleServiceKey } from "@moss/shared";

import { parseAiApiKeyCredential } from "../credentials.js";
import type { AiSecretCipher } from "../crypto.js";
import { recordModelActivity } from "../model-activity.js";
import type { AiRepository } from "../repository.js";

export type ChoiceQuestionInput = {
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
};

export type ChoiceAnswer = {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
};

export type GenerateChoicesInput = {
  readonly service: ModuleServiceKey;
  /** JSON-serialisable content the questions refer to. */
  readonly state: Record<string, unknown>;
  readonly questions: Readonly<Record<string, ChoiceQuestionInput>>;
  readonly requireExplicitBinding?: boolean;
  /** Run against this exact model instead of routing by service binding. */
  readonly explicitModel?: {
    readonly id: string;
    readonly provider_config_id: string;
    readonly provider_kind: string;
    readonly provider_model_id: string;
  };
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type GenerateChoicesResult =
  | {
      readonly ok: true;
      readonly answers: Readonly<Record<string, ChoiceAnswer>>;
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
      };
    }
  | {
      readonly ok: false;
      readonly error:
        | "needs_config"
        | "not_supported"
        | "provider_error"
        | "invalid_response"
        | "aborted";
    };

export type GenerateChoicesDeps = {
  readonly repository: Pick<
    AiRepository,
    "resolveModelForService" | "selectProviderWithCredential"
  >;
  readonly cipher: Pick<AiSecretCipher, "decryptJson">;
  readonly logger?: Pick<FastifyBaseLogger, "info" | "warn">;
  /** Injectable fetch for testing. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
};

const SYSTEM_ONE_PROVIDER_KIND = "system-one";
const SYSTEM_ONE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
const GENERATE_CHOICES_DEFAULT_TIMEOUT_MS = 20_000;
/** S3: System One rejects oversize bodies; refuse locally rather than send the state to the provider. */
const GENERATE_CHOICES_MAX_REQUEST_BYTES = 12_000;
const PROBABILITY_SUM_TOLERANCE = 0.02;

export async function generateChoices(
  scopedDb: DataContextDb,
  input: GenerateChoicesInput,
  deps: GenerateChoicesDeps
): Promise<GenerateChoicesResult> {
  const questions = Object.fromEntries(
    Object.entries(input.questions).map(([name, question]) => [
      name,
      {
        type: "choice",
        instructions: question.instructions,
        criteria: question.criteria
      }
    ])
  );
  const posted = await postSystemOne(scopedDb, input, questions, deps, "ai.generateChoices");
  if (!posted.ok) return posted;

  const answers = validateAnswers(input.questions, posted.payload);
  if (!answers) {
    deps.logger?.warn(
      { service: input.service, code: "invalid_response" },
      "ai.generateChoices invalid response"
    );
    return { ok: false, error: "invalid_response" };
  }
  return { ok: true, answers, usage: posted.usage };
}

/** A System One yes/no ("noul") question. A high `noul` value means yes. */
export type NoulQuestionInput = {
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
};

export type GenerateNoulInput = Omit<GenerateChoicesInput, "questions"> & {
  readonly questions: Readonly<Record<string, NoulQuestionInput>>;
};

type GenerateChoicesFailure = Extract<GenerateChoicesResult, { ok: false }>["error"];

export type GenerateNoulResult =
  | {
      readonly ok: true;
      /** Per question id, the probability from 0 to 1 that the answer is yes. */
      readonly probabilities: Readonly<Record<string, number>>;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
    }
  | { readonly ok: false; readonly error: GenerateChoicesFailure };

/**
 * #2805: ask System One yes/no questions. A noul answer carries one probability and no separate
 * confidence field, so the probability is returned as-is.
 */
export async function generateNoul(
  scopedDb: DataContextDb,
  input: GenerateNoulInput,
  deps: GenerateChoicesDeps
): Promise<GenerateNoulResult> {
  const questions = Object.fromEntries(
    Object.entries(input.questions).map(([name, question]) => [
      name,
      {
        type: "noul",
        instructions: question.instructions,
        ...(question.criteria ? { criteria: question.criteria } : {})
      }
    ])
  );
  const posted = await postSystemOne(scopedDb, input, questions, deps, "ai.generateNoul");
  if (!posted.ok) return posted;

  const probabilities = validateNoulAnswers(input.questions, posted.payload);
  if (!probabilities) {
    deps.logger?.warn(
      { service: input.service, code: "invalid_response" },
      "ai.generateNoul invalid response"
    );
    return { ok: false, error: "invalid_response" };
  }
  return { ok: true, probabilities, usage: posted.usage };
}

type SystemOnePost =
  | {
      readonly ok: true;
      readonly payload: Record<string, unknown>;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
    }
  | { readonly ok: false; readonly error: GenerateChoicesFailure };

/** Resolves the model and credential, posts one request to System One and reads the JSON body. */
async function postSystemOne(
  scopedDb: DataContextDb,
  input: Omit<GenerateChoicesInput, "questions">,
  questions: Record<string, unknown>,
  deps: GenerateChoicesDeps,
  logPrefix: string
): Promise<SystemOnePost> {
  const model =
    input.explicitModel ??
    (
      await deps.repository.resolveModelForService(scopedDb, input.service, {
        capability: "json",
        requireExplicitBinding: input.requireExplicitBinding
      })
    ).model;
  if (!model) return { ok: false, error: "needs_config" };

  const provider = await deps.repository.selectProviderWithCredential(
    scopedDb,
    model.provider_config_id
  );
  if (!provider) return { ok: false, error: "needs_config" };

  if (model.provider_kind !== SYSTEM_ONE_PROVIDER_KIND) {
    return { ok: false, error: "not_supported" };
  }

  if (provider.auth_method === "cli") return { ok: false, error: "needs_config" };

  let apiKey: string;
  try {
    const credential = parseAiApiKeyCredential(
      deps.cipher.decryptJson(provider.encrypted_credential)
    );
    if (!credential) return { ok: false, error: "needs_config" };
    apiKey = credential.apiKey;
  } catch {
    // Never log the ciphertext, credential material, or raw AES-GCM errors.
    deps.logger?.warn(
      { service: input.service, code: "credential_decrypt_failed" },
      `${logPrefix} credential could not be decrypted`
    );
    return { ok: false, error: "needs_config" };
  }

  const body = { model: model.provider_model_id, state: input.state, questions };
  const serializedBody = JSON.stringify(body);
  if (Buffer.byteLength(serializedBody, "utf8") > GENERATE_CHOICES_MAX_REQUEST_BYTES) {
    deps.logger?.warn(
      { service: input.service, code: "request_too_large" },
      `${logPrefix} request rejected`
    );
    return { ok: false, error: "provider_error" };
  }

  const baseUrl = (provider.base_url ?? SYSTEM_ONE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? GENERATE_CHOICES_DEFAULT_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  // Plan 3.6b (#2890): System One is reached by a raw fetch, not through the provider adapters
  // 3.6a records. Log one row per real post attempt at the same transport-facts-only standard.
  // The helper returns error values rather than throwing, so the outcome is derived from the
  // returned error instead of the wrapper's throw signal.
  let posted: Awaited<ReturnType<typeof postSystemOneRequest>>;
  try {
    posted = await postSystemOneRequest(
      fetchImpl,
      baseUrl,
      apiKey,
      serializedBody,
      signal,
      input.signal,
      deps,
      input.service,
      logPrefix
    );
  } catch (error) {
    recordModelActivity({
      kind: "structured",
      action: "choices",
      outcome: "error",
      modelName: model.provider_model_id,
      result: "failed"
    });
    throw error;
  }
  recordModelActivity({
    kind: "structured",
    action: "choices",
    outcome: posted.ok ? "ok" : posted.error === "aborted" ? "aborted" : "error",
    modelName: model.provider_model_id,
    result: posted.ok ? "completed" : posted.error === "aborted" ? "stopped" : "failed"
  });

  if (!posted.ok) return posted;

  const payload = posted.payload;
  if (!isRecord(payload)) {
    deps.logger?.warn(
      { service: input.service, code: "invalid_response" },
      `${logPrefix} invalid response`
    );
    return { ok: false, error: "invalid_response" };
  }

  const usage = isRecord(payload.usage) ? payload.usage : {};
  return {
    ok: true,
    payload,
    usage: {
      inputTokens: readTokenCount(usage["input_tokens"]),
      outputTokens: readTokenCount(usage["output_tokens"])
    }
  };
}

/** The raw System One round: post the serialized body and read the JSON payload. */
async function postSystemOneRequest(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  serializedBody: string,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  deps: GenerateChoicesDeps,
  service: ModuleServiceKey,
  logPrefix: string
): Promise<
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly error: GenerateChoicesFailure }
> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: serializedBody,
      // The API key must never be replayed to a redirect target.
      redirect: "error",
      signal
    });
  } catch (error) {
    if (callerSignal?.aborted) return { ok: false, error: "aborted" };
    const code = isTimeoutLike(error) ? "timeout" : "network_error";
    deps.logger?.warn({ service, code }, `${logPrefix} provider error`);
    return { ok: false, error: "provider_error" };
  }

  if (!response.ok) {
    deps.logger?.warn({ service, code: `http_${response.status}` }, `${logPrefix} provider error`);
    return { ok: false, error: "provider_error" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // The caller's signal firing mid-read is an abort, not a malformed body.
    if (callerSignal?.aborted) return { ok: false, error: "aborted" };
    deps.logger?.warn({ service, code: "invalid_response_body" }, `${logPrefix} invalid response`);
    return { ok: false, error: "invalid_response" };
  }
  return { ok: true, payload };
}

/** Every asked id answered as a noul with a probability inside 0 to 1; anything else fails. */
function validateNoulAnswers(
  questions: Readonly<Record<string, NoulQuestionInput>>,
  payload: Record<string, unknown>
): Record<string, number> | null {
  const rawAnswers = payload["answers"];
  if (!isRecord(rawAnswers)) return null;

  const probabilities: Record<string, number> = {};
  for (const name of Object.keys(questions)) {
    const rawAnswer = rawAnswers[name];
    if (!isRecord(rawAnswer)) return null;
    if (rawAnswer["type"] !== "noul") return null;
    const value = rawAnswer["noul"];
    if (!isUnitInterval(value)) return null;
    probabilities[name] = value;
  }
  return probabilities;
}

type ChoiceQuestionMap = Readonly<Record<string, ChoiceQuestionInput>>;

function validateAnswers(
  questions: ChoiceQuestionMap,
  payload: unknown
): Record<string, ChoiceAnswer> | null {
  if (!isRecord(payload)) return null;
  const rawAnswers = payload["answers"];
  if (!isRecord(rawAnswers)) return null;

  const answers: Record<string, ChoiceAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const rawAnswer = rawAnswers[name];
    if (!isRecord(rawAnswer)) return null;
    if (rawAnswer["type"] !== "choice") return null;

    const criteriaNames = Object.keys(question.criteria);
    const choice = rawAnswer["choice"];
    if (typeof choice !== "string" || !criteriaNames.includes(choice)) return null;

    const rawProbabilities = rawAnswer["probabilities"];
    if (!isRecord(rawProbabilities)) return null;
    if (Object.keys(rawProbabilities).length !== criteriaNames.length) return null;

    const confidence = rawAnswer["confidence"];
    if (!isUnitInterval(confidence)) return null;

    let sum = 0;
    const probabilities: Record<string, number> = {};
    for (const criterion of criteriaNames) {
      const value = rawProbabilities[criterion];
      if (!isUnitInterval(value)) return null;
      probabilities[criterion] = value;
      sum += value;
    }
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return null;

    const chosenProbability = probabilities[choice]!;
    for (const criterion of criteriaNames) {
      if (probabilities[criterion]! > chosenProbability) return null;
    }

    answers[name] = { choice, confidence, probabilities };
  }

  return answers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
