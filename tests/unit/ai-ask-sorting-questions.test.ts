import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import {
  askSortingQuestions,
  buildSortingQuestionsPrompt,
  sortingQuestionsResponseSchema,
  type AskSortingQuestionsDeps,
  type SortingQuestionBatch
} from "../../packages/ai/src/structured/ask-sorting-questions.js";
import type { StructuredProviderAdapter } from "../../packages/ai/src/structured/generate-structured.js";

/**
 * #2594 slice 2: the general "ask the sorting model yes/no questions" function. Both backends must
 * give the caller the same answer shape, so the story filter never has to know which ran.
 */

const scopedDb = {} as DataContextDb;

const systemOneModel = {
  id: "jev",
  provider_config_id: "p-system-one",
  provider_kind: "system-one",
  provider_model_id: "jev-latest"
} as never;

const jsonModel = {
  id: "small",
  provider_config_id: "p-json",
  provider_kind: "openai-compatible",
  provider_model_id: "small-x"
} as never;

const batch: SortingQuestionBatch = {
  state: { untrustedData: { stories: { s0: { headline: "a story" } } } },
  questions: {
    q0: { instructions: "Does it match?", criteria: { yes: "yes", no: "no" } }
  }
};

function makeDeps(options: {
  model: unknown;
  fetch?: typeof fetch;
  adapter?: StructuredProviderAdapter;
  logger?: AskSortingQuestionsDeps["logger"];
}): AskSortingQuestionsDeps {
  return {
    repository: {
      resolveSortingModel: vi.fn(async () => options.model as never),
      resolveModelForService: vi.fn(async () => ({ model: null, reason: "needs-config" as const })),
      selectProviderWithCredential: vi.fn(async (_db, providerId: string) => ({
        id: providerId,
        auth_method: "api_key",
        base_url: "https://example.test",
        encrypted_credential: {}
      })) as never
    } as AskSortingQuestionsDeps["repository"],
    cipher: { decryptJson: vi.fn(() => ({ apiKey: "sk-test" })) },
    logger: options.logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.adapter ? { createAdapter: () => options.adapter! } : {})
  };
}

function systemOneResponse(answer: { choice: string; confidence: number }) {
  const probabilities: Record<string, number> = { yes: 0.5, no: 0.5 };
  probabilities[answer.choice] = answer.confidence;
  const other = answer.choice === "yes" ? "no" : "yes";
  probabilities[other] = 1 - answer.confidence;
  return {
    answers: {
      q0: { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities }
    },
    usage: { input_tokens: 11, output_tokens: 3 }
  };
}

function fetchReturning(payload: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload
  })) as unknown as typeof fetch;
}

describe("askSortingQuestions", () => {
  it("answers through the System One choice backend and logs sorting usage", async () => {
    const fetch = fetchReturning(systemOneResponse({ choice: "yes", confidence: 0.8 }));
    const adapter: StructuredProviderAdapter = { generateStructured: vi.fn() };
    const info = vi.fn();
    const deps = makeDeps({
      model: systemOneModel,
      fetch,
      adapter,
      logger: { info, warn: vi.fn() }
    });

    const result = await askSortingQuestions(
      scopedDb,
      { service: "module.news", batches: [batch] },
      deps
    );

    expect(result).toEqual({
      ok: true,
      answers: { q0: { choice: "yes", confidence: 0.8 } },
      usage: { inputTokens: 11, outputTokens: 3 }
    });
    expect(adapter.generateStructured).not.toHaveBeenCalled();
    expect(deps.repository.resolveSortingModel).toHaveBeenCalledWith(scopedDb, "module.news", {
      acceptSystemOne: true
    });
    expect(info).toHaveBeenCalledWith(
      {
        service: "module.news",
        servedBy: "sorting",
        modelId: "jev",
        providerKind: "system-one",
        inputTokens: 11,
        outputTokens: 3,
        requests: 1
      },
      "ai.sorting usage"
    );
  });

  it("labels a structured sorting answer as sorting, naming the model that answered", async () => {
    const info = vi.fn();
    const deps = makeDeps({
      model: jsonModel,
      adapter: {
        generateStructured: vi.fn(async () => ({
          rawObject: { answers: [{ id: "q0", answer: "yes", confidence: 0.8 }] },
          usage: { inputTokens: 3, outputTokens: 1 }
        }))
      },
      logger: { info, warn: vi.fn() }
    });

    const result = await askSortingQuestions(
      scopedDb,
      { service: "module.news", batches: [batch] },
      deps
    );

    expect(result.ok).toBe(true);
    // The structured path must not log the sorting model's answer as the main model.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ servedBy: "sorting", modelId: "small" }),
      "ai.structured usage"
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        servedBy: "sorting",
        modelId: "small",
        providerKind: "openai-compatible"
      }),
      "ai.sorting usage"
    );
  });

  it("answers through the structured backend for a non-System One sorting model", async () => {
    const generateStructured = vi.fn(async (_input: unknown) => ({
      rawObject: { answers: [{ id: "q0", answer: "no", confidence: 0.25 }] },
      usage: { inputTokens: 7, outputTokens: 2 }
    }));
    const fetch = fetchReturning(systemOneResponse({ choice: "yes", confidence: 0.9 }));
    const deps = makeDeps({
      model: jsonModel,
      fetch,
      adapter: { generateStructured }
    });

    const result = await askSortingQuestions(
      scopedDb,
      { service: "module.sports", batches: [batch] },
      deps
    );

    expect(result).toEqual({
      ok: true,
      answers: { q0: { choice: "no", confidence: 0.25 } },
      usage: { inputTokens: 7, outputTokens: 2 }
    });
    expect(fetch).not.toHaveBeenCalled();
    const sent = generateStructured.mock.calls[0]?.[0] as {
      schema: unknown;
      messages: readonly { role: string; content: string }[];
    };
    expect(sent.schema).toBe(sortingQuestionsResponseSchema);
    expect(sent.messages[0]?.content).toBe(buildSortingQuestionsPrompt(batch));
  });

  it("reports not_supported and calls nothing when no sorting model is bound", async () => {
    const fetch = fetchReturning(systemOneResponse({ choice: "yes", confidence: 0.9 }));
    const adapter: StructuredProviderAdapter = { generateStructured: vi.fn() };
    const deps = makeDeps({ model: null, fetch, adapter });

    const result = await askSortingQuestions(
      scopedDb,
      { service: "module.news", batches: [batch] },
      deps
    );

    expect(result).toEqual({ ok: false, error: "not_supported" });
    expect(fetch).not.toHaveBeenCalled();
    expect(adapter.generateStructured).not.toHaveBeenCalled();
  });

  it("returns aborted before resolving a model when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = makeDeps({
      model: systemOneModel,
      fetch: fetchReturning(systemOneResponse({ choice: "yes", confidence: 0.9 }))
    });

    const result = await askSortingQuestions(
      scopedDb,
      { service: "module.news", batches: [batch], signal: controller.signal },
      deps
    );

    expect(result).toEqual({ ok: false, error: "aborted" });
    expect(deps.repository.resolveSortingModel).not.toHaveBeenCalled();
  });

  it("fails the run when the structured answer skips a question", async () => {
    const deps = makeDeps({
      model: jsonModel,
      adapter: {
        generateStructured: vi.fn(async () => ({
          rawObject: { answers: [] },
          usage: { inputTokens: 1, outputTokens: 1 }
        }))
      }
    });

    const result = await askSortingQuestions(
      scopedDb,
      { service: "module.news", batches: [batch] },
      deps
    );

    expect(result).toEqual({ ok: false, error: "invalid_response" });
  });

  it("merges several batches and sums their usage", async () => {
    const second: SortingQuestionBatch = {
      state: { untrustedData: { stories: { s1: { headline: "another" } } } },
      questions: {
        q1: { instructions: "Does it match?", criteria: { yes: "yes", no: "no" } }
      }
    };
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      const payload =
        call === 1
          ? systemOneResponse({ choice: "yes", confidence: 0.9 })
          : {
              answers: {
                q1: {
                  type: "choice",
                  choice: "no",
                  confidence: 0.9,
                  probabilities: { yes: 0.1, no: 0.9 }
                }
              },
              usage: { input_tokens: 4, output_tokens: 1 }
            };
      return { ok: true, status: 200, json: async () => payload };
    }) as unknown as typeof globalThis.fetch;
    const deps = makeDeps({ model: systemOneModel, fetch });

    const result = await askSortingQuestions(
      scopedDb,
      { service: "module.news", batches: [batch, second] },
      deps
    );

    expect(result).toEqual({
      ok: true,
      answers: {
        q0: { choice: "yes", confidence: 0.9 },
        q1: { choice: "no", confidence: 0.9 }
      },
      usage: { inputTokens: 15, outputTokens: 4 }
    });
  });
});
