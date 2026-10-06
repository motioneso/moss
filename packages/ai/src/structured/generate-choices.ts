import type { FastifyBaseLogger } from "fastify";

import { readScopedActorUserId, type ActivityFactCounts, type DataContextDb } from "@moss/db";
import {
  CLOUDFLARE_DECISION_MODELS,
  decisionModelDialect,
  FOCUS_IMAGE_MAX_CHARS,
  type DecisionModelDialect
} from "@moss/shared";
import type { ModuleServiceKey } from "@moss/shared";

import { parseAiApiKeyCredential } from "../credentials.js";
import type { AiSecretCipher } from "../crypto.js";
import {
  isGateTimeoutAbort,
  modelActivityStructuredCode,
  recordModelActivity,
  type ModelActivityFailureCode
} from "../model-activity.js";
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

/**
 * #2956: activity context for a System One line. The gate names `chat.tool_check`
 * with its turn; other callers take the service structured code. The owner
 * defaults to the scoped actor.
 */
export type GenerateChoicesActivity = {
  readonly ownerUserId?: string;
  readonly turnId?: string;
  readonly parentId?: string;
  readonly actionCode?: string;
};

export type GenerateChoicesInput = {
  readonly service: ModuleServiceKey;
  /** JSON-serialisable content the questions refer to. */
  readonly state: Record<string, unknown>;
  readonly questions: Readonly<Record<string, ChoiceQuestionInput>>;
  readonly requireExplicitBinding?: boolean;
  readonly activity?: GenerateChoicesActivity;
  /** Run against this exact model instead of routing by service binding. */
  readonly explicitModel?: {
    readonly id: string;
    readonly provider_config_id: string;
    readonly provider_kind: string;
    readonly provider_model_id: string;
    /** Needed only with `image`: a model without `vision` never receives one. */
    readonly capabilities?: readonly string[];
  };
  /**
   * #3067: one picture, as a data URL, sent beside `state` rather than inside it. Only a model
   * that takes images (see `choiceModelTakesImages`) receives it; any other answers
   * `not_supported` without a request. Never logged or recorded; the activity line counts it.
   */
  readonly image?: string;
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

/**
 * #3067: whether a choice model can be sent a picture. Only Clef, on Cloudflare's dialect, with
 * the `vision` capability on its row. The standard dialect never receives `images` until a
 * service there is proven live. Shared with the focus context so the Mac is offered the picture
 * source exactly when this call would accept one.
 */
export function choiceModelTakesImages(
  model: {
    readonly provider_kind: string;
    readonly provider_model_id: string;
    readonly capabilities?: readonly string[];
  },
  providerBaseUrl: string | null
): boolean {
  return (
    model.provider_kind === SYSTEM_ONE_PROVIDER_KIND &&
    decisionModelDialect(providerBaseUrl ?? SYSTEM_ONE_DEFAULT_BASE_URL) === "cloudflare" &&
    isCloudflareDecisionModel(model.provider_model_id) &&
    (model.capabilities?.includes("vision") ?? false)
  );
}

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
    recordSystemOneActivity(posted.modelName, "error", {
      ...posted.activity,
      durationMs: posted.durationMs,
      inputTokens: posted.usage.inputTokens,
      outputTokens: posted.usage.outputTokens,
      failureCode: "bad_shape"
    });
    deps.logger?.warn(
      { service: input.service, code: "invalid_response" },
      "ai.generateChoices invalid response"
    );
    return { ok: false, error: "invalid_response" };
  }
  recordSystemOneActivity(posted.modelName, "ok", {
    ...posted.activity,
    durationMs: posted.durationMs,
    inputTokens: posted.usage.inputTokens,
    outputTokens: posted.usage.outputTokens,
    factCounts: { confidence: topConfidence(Object.values(answers)) }
  });
  return { ok: true, answers, usage: posted.usage };
}

/**
 * #2956: the headline confidence for a choice line. One question reports its
 * own; several report the strongest, so the line never invents an average.
 */
function topConfidence(answers: readonly { readonly confidence: number }[]): number {
  let top = 0;
  for (const answer of answers) {
    if (answer.confidence > top) top = answer.confidence;
  }
  return top;
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
    recordSystemOneActivity(posted.modelName, "error", {
      ...posted.activity,
      durationMs: posted.durationMs,
      inputTokens: posted.usage.inputTokens,
      outputTokens: posted.usage.outputTokens,
      failureCode: "bad_shape"
    });
    deps.logger?.warn(
      { service: input.service, code: "invalid_response" },
      "ai.generateNoul invalid response"
    );
    return { ok: false, error: "invalid_response" };
  }
  // A noul answer carries no separate confidence; its probability is the reading.
  const readings = Object.values(probabilities).map((noul) => ({ confidence: noul }));
  recordSystemOneActivity(posted.modelName, "ok", {
    ...posted.activity,
    durationMs: posted.durationMs,
    inputTokens: posted.usage.inputTokens,
    outputTokens: posted.usage.outputTokens,
    factCounts: { confidence: topConfidence(readings) }
  });
  return { ok: true, probabilities, usage: posted.usage };
}

type SystemOnePost =
  | {
      readonly ok: true;
      readonly payload: Record<string, unknown>;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly modelName: string;
      readonly durationMs: number;
      readonly activity: SystemOneActivity;
    }
  | { readonly ok: false; readonly error: GenerateChoicesFailure };

/** #2956: the activity line's identity for one System One call. */
export type SystemOneActivity = {
  readonly ownerUserId?: string;
  readonly turnId?: string;
  readonly parentId?: string;
  readonly actionCode: string;
  /** #3067: how many pictures the call carried; absent when none. A count, never the picture. */
  readonly images?: number;
};

async function systemOneActivity(
  scopedDb: DataContextDb,
  input: Omit<GenerateChoicesInput, "questions">
): Promise<SystemOneActivity> {
  const scopedOwner = input.activity?.ownerUserId ?? (await readScopedActorUserId(scopedDb));
  return {
    actionCode: input.activity?.actionCode ?? modelActivityStructuredCode(input.service),
    ...(scopedOwner ? { ownerUserId: scopedOwner } : {}),
    ...(input.activity?.turnId ? { turnId: input.activity.turnId } : {}),
    ...(input.activity?.parentId ? { parentId: input.activity.parentId } : {}),
    ...(input.image !== undefined ? { images: 1 } : {})
  };
}

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

  // #3067: a picture goes only to a model that takes one. Anything else is refused here, before
  // the body is built, so the picture never reaches a provider that would not accept it.
  if (input.image !== undefined && !choiceModelTakesImages(model, provider.base_url)) {
    return { ok: false, error: "not_supported" };
  }

  // The text cap covers state and questions only. A picture has its own cap below, so a request
  // that carries one is not refused for the picture's size against the text limit.
  const body = { model: model.provider_model_id, state: input.state, questions };
  const textBody = JSON.stringify(body);
  if (Buffer.byteLength(textBody, "utf8") > GENERATE_CHOICES_MAX_REQUEST_BYTES) {
    deps.logger?.warn(
      { service: input.service, code: "request_too_large" },
      `${logPrefix} request rejected`
    );
    return { ok: false, error: "provider_error" };
  }
  if (input.image !== undefined && input.image.length > FOCUS_IMAGE_MAX_CHARS) {
    deps.logger?.warn(
      { service: input.service, code: "image_too_large" },
      `${logPrefix} request rejected`
    );
    return { ok: false, error: "provider_error" };
  }
  const serializedBody =
    input.image === undefined ? textBody : JSON.stringify({ ...body, images: [input.image] });

  const baseUrl = (provider.base_url ?? SYSTEM_ONE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const dialect = decisionModelDialect(baseUrl);
  // The Cloudflare model id becomes a URL path segment, so it is checked against the fixed list
  // before any request. Anything else is refused locally and never sent.
  if (dialect === "cloudflare" && !isCloudflareDecisionModel(model.provider_model_id)) {
    deps.logger?.warn(
      { service: input.service, code: "model_not_allowed" },
      `${logPrefix} request rejected`
    );
    return { ok: false, error: "provider_error" };
  }
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? GENERATE_CHOICES_DEFAULT_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  // Plan 3.6b (#2890): System One is reached by a raw fetch, not through the provider adapters
  // 3.6a records. Log one row per real post attempt at the same transport-facts-only standard.
  // The outcome reflects the whole call: an unusable body is a failed call, like the adapters.
  // #2956: the row carries the line code, owner, turn and duration. Confidence lands
  // with the success record in the caller, which is the only place that knows it.
  const activity = await systemOneActivity(scopedDb, input);
  const startedAt = Date.now();
  let posted: Awaited<ReturnType<typeof postSystemOneRequest>>;
  try {
    posted = await postSystemOneRequest(
      fetchImpl,
      dialect,
      baseUrl,
      model.provider_model_id,
      apiKey,
      serializedBody,
      signal,
      input.signal,
      deps,
      input.service,
      logPrefix
    );
  } catch (error) {
    recordSystemOneActivity(model.provider_model_id, "error", {
      ...activity,
      durationMs: Date.now() - startedAt,
      failureCode: "unknown"
    });
    throw error;
  }

  if (!posted.ok) {
    // #3064: one owner for the timeout line — the gate. An abort carrying the gate's own
    // deadline reason files nothing here; the gate files the single line. Every other
    // outcome records exactly as before.
    if (posted.error !== "aborted" || !isGateTimeoutAbort(input.signal)) {
      recordSystemOneActivity(
        model.provider_model_id,
        posted.error === "aborted" ? "aborted" : "error",
        {
          ...activity,
          durationMs: Date.now() - startedAt,
          failureCode: posted.error === "aborted" ? "cancelled" : "unknown"
        }
      );
    }
    return posted;
  }

  const payload = posted.payload;
  if (!isRecord(payload)) {
    recordSystemOneActivity(model.provider_model_id, "error", {
      ...activity,
      durationMs: Date.now() - startedAt,
      failureCode: "bad_shape"
    });
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
    },
    modelName: model.provider_model_id,
    durationMs: Date.now() - startedAt,
    activity
  };
}

/** Record one System One post attempt. Transport facts only; never the state, questions or key. */
export function recordSystemOneActivity(
  modelName: string,
  outcome: "ok" | "error" | "aborted",
  activity: SystemOneActivity & {
    readonly durationMs?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly factCounts?: ActivityFactCounts;
    readonly failureCode?: ModelActivityFailureCode;
  }
): void {
  const factCounts =
    activity.images !== undefined
      ? { ...activity.factCounts, images: activity.images }
      : activity.factCounts;
  recordModelActivity({
    kind: "structured",
    action: "choices",
    outcome,
    modelName,
    result: outcome === "ok" ? "completed" : outcome === "aborted" ? "stopped" : "failed",
    actionCode: activity.actionCode,
    ...(activity.ownerUserId ? { ownerUserId: activity.ownerUserId } : {}),
    ...(activity.turnId ? { turnId: activity.turnId } : {}),
    ...(activity.parentId ? { parentId: activity.parentId } : {}),
    ...(activity.durationMs !== undefined ? { durationMs: activity.durationMs } : {}),
    ...(activity.inputTokens !== undefined ? { inputTokens: activity.inputTokens } : {}),
    ...(activity.outputTokens !== undefined ? { outputTokens: activity.outputTokens } : {}),
    ...(factCounts ? { factCounts } : {}),
    ...(activity.failureCode ? { failureCode: activity.failureCode } : {})
  });
}

/** The raw System One round: post the serialized body and read the JSON payload. */
async function postSystemOneRequest(
  fetchImpl: typeof fetch,
  dialect: DecisionModelDialect,
  baseUrl: string,
  modelId: string,
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
  // The two dialects differ only in address and envelope. Cloudflare puts the model id in the
  // path; the standard dialect posts to the fixed `/v1/systemone`.
  const requestUrl =
    dialect === "cloudflare"
      ? `${baseUrl}/run/@cf/cloudflare/${modelId}`
      : `${baseUrl}/v1/systemone`;
  let response: Response;
  try {
    response = await fetchImpl(requestUrl, {
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

  if (dialect === "cloudflare") {
    // Cloudflare wraps every answer in `{ success, result }`. A refusal is a provider error, never
    // an `invalid_response` the caller could mistake for a malformed (but valid) answer.
    const unwrapped = unwrapCloudflareReply(payload);
    if (!unwrapped) {
      deps.logger?.warn({ service, code: "cloudflare_error" }, `${logPrefix} provider error`);
      return { ok: false, error: "provider_error" };
    }
    return { ok: true, payload: unwrapped };
  }

  return { ok: true, payload };
}

/**
 * Cloudflare answers `{ success, result }`. Only `success === true` with a record `result` is a
 * usable answer; the result then flows through the same answer checks as the standard dialect.
 */
function unwrapCloudflareReply(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || payload["success"] !== true) return null;
  const result = payload["result"];
  return isRecord(result) ? result : null;
}

function isCloudflareDecisionModel(modelId: string): boolean {
  return (CLOUDFLARE_DECISION_MODELS as readonly string[]).includes(modelId);
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
