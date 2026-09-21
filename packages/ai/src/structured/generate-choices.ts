import type { FastifyBaseLogger } from "fastify";

import type { DataContextDb } from "@moss/db";
import type { ModuleServiceKey } from "@moss/shared";

import { parseAiApiKeyCredential } from "../credentials.js";
import type { AiSecretCipher } from "../crypto.js";
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
  const resolved = await deps.repository.resolveModelForService(scopedDb, input.service, {
    capability: "json",
    requireExplicitBinding: input.requireExplicitBinding
  });
  if (!resolved.model) return { ok: false, error: "needs_config" };
  const model = resolved.model;

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
      "ai.generateChoices credential could not be decrypted"
    );
    return { ok: false, error: "needs_config" };
  }

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
  const body = { model: model.provider_model_id, state: input.state, questions };
  const serializedBody = JSON.stringify(body);
  if (Buffer.byteLength(serializedBody, "utf8") > GENERATE_CHOICES_MAX_REQUEST_BYTES) {
    deps.logger?.warn(
      { service: input.service, code: "request_too_large" },
      "ai.generateChoices request rejected"
    );
    return { ok: false, error: "provider_error" };
  }

  const baseUrl = (provider.base_url ?? SYSTEM_ONE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? GENERATE_CHOICES_DEFAULT_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;

  const fetchImpl = deps.fetch ?? globalThis.fetch;
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
    if (input.signal?.aborted) return { ok: false, error: "aborted" };
    const code = isTimeoutLike(error) ? "timeout" : "network_error";
    deps.logger?.warn({ service: input.service, code }, "ai.generateChoices provider error");
    return { ok: false, error: "provider_error" };
  }

  if (!response.ok) {
    deps.logger?.warn(
      { service: input.service, code: `http_${response.status}` },
      "ai.generateChoices provider error"
    );
    return { ok: false, error: "provider_error" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // The caller's signal firing mid-read is an abort, not a malformed body.
    if (input.signal?.aborted) return { ok: false, error: "aborted" };
    deps.logger?.warn(
      { service: input.service, code: "invalid_response_body" },
      "ai.generateChoices invalid response"
    );
    return { ok: false, error: "invalid_response" };
  }

  const answers = validateAnswers(input.questions, payload);
  if (!answers || !isRecord(payload)) {
    deps.logger?.warn(
      { service: input.service, code: "invalid_response" },
      "ai.generateChoices invalid response"
    );
    return { ok: false, error: "invalid_response" };
  }

  const usage = isRecord(payload.usage) ? payload.usage : {};
  return {
    ok: true,
    answers,
    usage: {
      inputTokens: readTokenCount(usage["input_tokens"]),
      outputTokens: readTokenCount(usage["output_tokens"])
    }
  };
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
