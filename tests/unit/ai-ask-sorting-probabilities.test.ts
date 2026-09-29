import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import { askSortingProbabilities } from "../../packages/ai/src/structured/ask-sorting-probabilities.js";
import type { AskSortingQuestionsDeps } from "../../packages/ai/src/structured/ask-sorting-questions.js";
import type { StructuredProviderAdapter } from "../../packages/ai/src/structured/generate-structured.js";

/**
 * #2805: yes/no questions answered as a probability of yes. System One answers as noul; any other
 * sorting model answers yes/no with a confidence, converted to the same shape.
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

const questions = {
  q_a: { instructions: "Is it A?" },
  q_b: { instructions: "Is it B?" }
};

function makeDeps(options: {
  model: unknown;
  fetch?: typeof fetch;
  adapter?: StructuredProviderAdapter;
  cliAdapter?: StructuredProviderAdapter;
  authMethod?: "api_key" | "cli";
}): AskSortingQuestionsDeps {
  return {
    repository: {
      resolveSortingModel: vi.fn(async () => options.model as never),
      resolveModelForService: vi.fn(async () => ({ model: null, reason: "needs-config" as const })),
      selectProviderWithCredential: vi.fn(async (_db, providerId: string) => ({
        id: providerId,
        auth_method: options.authMethod ?? "api_key",
        base_url: "https://example.test",
        encrypted_credential: {}
      })) as never
    } as AskSortingQuestionsDeps["repository"],
    cipher: { decryptJson: vi.fn(() => ({ apiKey: "sk-test" })) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.adapter ? { createAdapter: () => options.adapter! } : {}),
    ...(options.cliAdapter ? { createCliStructuredAdapter: () => options.cliAdapter! } : {})
  };
}

function fetchReturning(payload: unknown) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => payload
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("askSortingProbabilities", () => {
  it("asks System One noul questions and returns each probability as-is", async () => {
    const fetch = fetchReturning({
      model: "jev-1.13.0",
      answers: { q_a: { type: "noul", noul: 0.91 }, q_b: { type: "noul", noul: 0.12 } },
      usage: { input_tokens: 40, output_tokens: 5 }
    });
    const deps = makeDeps({ model: systemOneModel, fetch });

    const result = await askSortingProbabilities(
      scopedDb,
      { service: "module.connectors.email-sort", state: { subject: "x" }, questions },
      deps
    );

    expect(result).toEqual({
      ok: true,
      probabilities: { q_a: 0.91, q_b: 0.12 },
      modelId: "jev",
      usage: { inputTokens: 40, outputTokens: 5 }
    });
    expect(deps.repository.resolveSortingModel).toHaveBeenCalledWith(
      scopedDb,
      "module.connectors.email-sort",
      { acceptSystemOne: true }
    );
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      model: string;
      questions: Record<string, { type: string; instructions: string }>;
    };
    expect(body.model).toBe("jev-latest");
    expect(body.questions.q_a).toEqual({ type: "noul", instructions: "Is it A?" });
  });

  it("rejects a noul answer that is missing or out of range", async () => {
    for (const answers of [
      { q_a: { type: "noul", noul: 0.9 } },
      { q_a: { type: "noul", noul: 0.9 }, q_b: { type: "noul", noul: 1.2 } },
      { q_a: { type: "noul", noul: 0.9 }, q_b: { type: "choice", noul: 0.2 } }
    ]) {
      const deps = makeDeps({ model: systemOneModel, fetch: fetchReturning({ answers }) });
      const result = await askSortingProbabilities(
        scopedDb,
        { service: "module.connectors.email-sort", state: {}, questions },
        deps
      );
      expect(result).toEqual({ ok: false, error: "invalid_response" });
    }
  });

  it("converts a structured yes/no answer with confidence into a probability of yes", async () => {
    const generateStructured = vi.fn(async (_input: unknown) => ({
      rawObject: {
        answers: [
          { id: "q_a", answer: "yes", confidence: 0.8 },
          { id: "q_b", answer: "no", confidence: 0.7 }
        ]
      },
      usage: { inputTokens: 7, outputTokens: 2 }
    }));
    const fetch = fetchReturning({});
    const deps = makeDeps({ model: jsonModel, fetch, adapter: { generateStructured } });

    const result = await askSortingProbabilities(
      scopedDb,
      { service: "module.connectors.email-sort", state: {}, questions },
      deps
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probabilities.q_a).toBeCloseTo(0.8);
    expect(result.probabilities.q_b).toBeCloseTo(0.3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers through a command-line sorting model only when the caller supplies its adapter", async () => {
    const generateStructured = vi.fn(async (_input: unknown) => ({
      rawObject: {
        answers: [
          { id: "q_a", answer: "no", confidence: 0.9 },
          { id: "q_b", answer: "yes", confidence: 0.6 }
        ]
      },
      usage: { inputTokens: 5, outputTokens: 2 }
    }));
    const input = { service: "module.connectors.email-sort" as const, state: {}, questions };

    const withAdapter = await askSortingProbabilities(
      scopedDb,
      input,
      makeDeps({ model: jsonModel, authMethod: "cli", cliAdapter: { generateStructured } })
    );
    expect(withAdapter.ok).toBe(true);
    if (!withAdapter.ok) return;
    expect(withAdapter.probabilities.q_a).toBeCloseTo(0.1);
    expect(withAdapter.probabilities.q_b).toBeCloseTo(0.6);

    const without = await askSortingProbabilities(
      scopedDb,
      input,
      makeDeps({ model: jsonModel, authMethod: "cli" })
    );
    expect(without).toEqual({ ok: false, error: "needs_config" });
  });

  it("reports not_supported and calls nothing when no sorting model is bound", async () => {
    const fetch = fetchReturning({});
    const adapter: StructuredProviderAdapter = { generateStructured: vi.fn() };
    const deps = makeDeps({ model: null, fetch, adapter });

    const result = await askSortingProbabilities(
      scopedDb,
      { service: "module.connectors.email-sort", state: {}, questions },
      deps
    );

    expect(result).toEqual({ ok: false, error: "not_supported" });
    expect(fetch).not.toHaveBeenCalled();
    expect(adapter.generateStructured).not.toHaveBeenCalled();
  });
});
