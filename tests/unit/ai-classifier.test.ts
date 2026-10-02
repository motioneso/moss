import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import {
  askClassifierChoice,
  extractClassifierValues,
  resolveClassifier,
  type ClassifierDeps,
  type ClassifierHandle
} from "../../packages/ai/src/structured/classifier.js";
import type { StructuredProviderAdapter } from "../../packages/ai/src/structured/generate-structured.js";

/**
 * #2865: the routing contract for the chat classifier gate. Fixtures only. Every provider call is a
 * fake, and the user's default chat model must never be reached from this file's code.
 */

const scopedDb = {} as DataContextDb;
const SERVICE = "module.chat" as const;

const choiceOnlyModel = {
  id: "m-choice",
  provider_config_id: "p-choice",
  provider_kind: "system-one",
  provider_model_id: "choice-x"
} as never;

const typedModel = {
  id: "m-typed",
  provider_config_id: "p-typed",
  provider_kind: "openai-compatible",
  provider_model_id: "typed-x"
} as never;

const question = {
  instructions: "Which area does the message belong to?",
  criteria: { lights: "smart home", calendar: "calendar", none: "anything else" }
};

function makeDeps(options: {
  sortingModel?: unknown;
  chatModel?: unknown;
  fetch?: typeof fetch;
  adapter?: StructuredProviderAdapter;
}) {
  const resolveSortingModel = vi.fn(async () => (options.sortingModel ?? null) as never);
  const resolveModelForService = vi.fn(async () => ({
    model: (options.chatModel ?? null) as never,
    reason: "needs-config" as const
  }));
  const deps: ClassifierDeps = {
    repository: {
      resolveSortingModel,
      resolveModelForService,
      selectProviderWithCredential: vi.fn(async (_db, providerId: string) => ({
        id: providerId,
        auth_method: "api_key",
        base_url: "https://example.test",
        encrypted_credential: {}
      })) as never
    } as ClassifierDeps["repository"],
    cipher: { decryptJson: vi.fn(() => ({ apiKey: "sk-test" })) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.adapter ? { createAdapter: () => options.adapter! } : {})
  };
  return { deps, resolveSortingModel, resolveModelForService };
}

function systemOneFetch(probabilities: Record<string, number>, choice: string, confidence = 0.9) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      answers: { choice: { type: "choice", choice, confidence, probabilities } },
      usage: { input_tokens: 5, output_tokens: 1 }
    })
  })) as unknown as typeof fetch;
}

function adapterReturning(...objects: unknown[]) {
  const generateStructured = vi.fn(async () => ({
    rawObject: objects.shift(),
    usage: { inputTokens: 7, outputTokens: 2 }
  }));
  return { adapter: { generateStructured } as StructuredProviderAdapter, generateStructured };
}

describe("resolveClassifier", () => {
  it("returns null when no classifier is bound, without touching the chat model", async () => {
    const { deps, resolveModelForService } = makeDeps({ chatModel: typedModel });
    expect(await resolveClassifier(scopedDb, SERVICE, deps)).toBeNull();
    expect(resolveModelForService).not.toHaveBeenCalled();
  });

  it("asks the existing sorting-model lookup, which keeps its routing restrictions", async () => {
    const { deps, resolveSortingModel } = makeDeps({ sortingModel: typedModel });
    await resolveClassifier(scopedDb, SERVICE, deps);
    expect(resolveSortingModel).toHaveBeenCalledWith(scopedDb, SERVICE, { acceptSystemOne: true });
  });

  it("reports choice-only for a classifier that returns choices and scores only", async () => {
    const { deps } = makeDeps({ sortingModel: choiceOnlyModel });
    const handle = await resolveClassifier(scopedDb, SERVICE, deps);
    expect(handle?.capability).toBe("choice_only");
  });

  it("reports typed extraction for a classifier that takes a structured request", async () => {
    const { deps } = makeDeps({ sortingModel: typedModel });
    const handle = await resolveClassifier(scopedDb, SERVICE, deps);
    expect(handle?.capability).toBe("typed_extraction");
  });

  it("never falls back to the chat model when the classifier is disabled or missing", async () => {
    const { deps, resolveModelForService } = makeDeps({ chatModel: typedModel });
    const adapter = adapterReturning({});
    expect(await resolveClassifier(scopedDb, SERVICE, deps)).toBeNull();
    expect(resolveModelForService).not.toHaveBeenCalled();
    expect(adapter.generateStructured).not.toHaveBeenCalled();
  });
});

describe("askClassifierChoice on a choice-only classifier", () => {
  async function handleFor(deps: ClassifierDeps): Promise<ClassifierHandle> {
    const handle = await resolveClassifier(scopedDb, SERVICE, deps);
    if (!handle) throw new Error("no classifier");
    return handle;
  }

  it("returns every score, the runner-up and the lead", async () => {
    const fetch = systemOneFetch({ lights: 0.8, calendar: 0.15, none: 0.05 }, "lights", 0.95);
    const { deps } = makeDeps({ sortingModel: choiceOnlyModel, fetch });
    const result = await askClassifierChoice(
      scopedDb,
      await handleFor(deps),
      { service: SERVICE, state: { message: "turn off the lights" }, question },
      deps
    );
    expect(result).toMatchObject({
      ok: true,
      choice: "lights",
      confidence: 0.95,
      probabilities: { lights: 0.8, calendar: 0.15, none: 0.05 },
      runnerUp: { choice: "calendar", probability: 0.15 }
    });
    expect(result.ok && result.lead).toBeCloseTo(0.65);
  });

  it("makes exactly one provider call per question and pins the resolved model", async () => {
    const fetch = systemOneFetch({ lights: 0.8, calendar: 0.15, none: 0.05 }, "lights");
    const { deps, resolveSortingModel } = makeDeps({ sortingModel: choiceOnlyModel, fetch });
    const handle = await handleFor(deps);
    await askClassifierChoice(scopedDb, handle, { service: SERVICE, state: {}, question }, deps);
    await askClassifierChoice(scopedDb, handle, { service: SERVICE, state: {}, question }, deps);
    expect(fetch).toHaveBeenCalledTimes(2);
    // The binding is read once, when the handle is made, not once per stage.
    expect(resolveSortingModel).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body)
    );
    expect(body.model).toBe("choice-x");
  });

  it("declines a malformed score set instead of repairing it", async () => {
    // Scores that do not add up to 1 are not a usable answer.
    const fetch = systemOneFetch({ lights: 0.9, calendar: 0.9, none: 0.9 }, "lights");
    const { deps } = makeDeps({ sortingModel: choiceOnlyModel, fetch });
    const result = await askClassifierChoice(
      scopedDb,
      await handleFor(deps),
      { service: SERVICE, state: {}, question },
      deps
    );
    expect(result).toEqual({ ok: false, error: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a provider error without a second try", async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    const { deps } = makeDeps({ sortingModel: choiceOnlyModel, fetch: failing });
    const result = await askClassifierChoice(
      scopedDb,
      await handleFor(deps),
      { service: SERVICE, state: {}, question },
      deps
    );
    expect(result).toEqual({ ok: false, error: "provider_error" });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("reports aborted when the shared deadline has already passed", async () => {
    const fetch = systemOneFetch({ lights: 0.8, calendar: 0.15, none: 0.05 }, "lights");
    const { deps } = makeDeps({ sortingModel: choiceOnlyModel, fetch });
    const handle = await handleFor(deps);
    const controller = new AbortController();
    controller.abort();
    const result = await askClassifierChoice(
      scopedDb,
      handle,
      { service: SERVICE, state: {}, question, signal: controller.signal },
      deps
    );
    expect(result).toEqual({ ok: false, error: "aborted" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a valid answer that arrives after the deadline or a cancel", async () => {
    const controller = new AbortController();
    const slow = vi.fn(async () => ({
      ok: true,
      status: 200,
      // The cancel lands while the response body is still being read.
      json: async () => {
        controller.abort();
        return {
          answers: {
            choice: {
              type: "choice",
              choice: "lights",
              confidence: 0.95,
              probabilities: { lights: 0.8, calendar: 0.15, none: 0.05 }
            }
          },
          usage: { input_tokens: 5, output_tokens: 1 }
        };
      }
    })) as unknown as typeof fetch;
    const { deps } = makeDeps({ sortingModel: choiceOnlyModel, fetch: slow });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    const result = await askClassifierChoice(
      scopedDb,
      handle,
      { service: SERVICE, state: {}, question, signal: controller.signal },
      deps
    );
    expect(result).toEqual({ ok: false, error: "aborted" });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("rejects a question with fewer than two options", async () => {
    const { deps } = makeDeps({ sortingModel: choiceOnlyModel, fetch: systemOneFetch({}, "x") });
    const result = await askClassifierChoice(
      scopedDb,
      await handleFor(deps),
      { service: SERVICE, state: {}, question: { instructions: "q", criteria: { only: "one" } } },
      deps
    );
    expect(result).toEqual({ ok: false, error: "invalid_response" });
  });
});

describe("askClassifierChoice on a typed-extraction classifier", () => {
  const goodAnswer = {
    choice: "lights",
    confidence: 0.92,
    scores: { lights: 0.85, calendar: 0.1, none: 0.05 }
  };

  it("returns the same result shape as the choice-only path", async () => {
    const { adapter } = adapterReturning(goodAnswer);
    const { deps } = makeDeps({ sortingModel: typedModel, adapter });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    const result = await askClassifierChoice(
      scopedDb,
      handle,
      { service: SERVICE, state: { message: "lights off" }, question },
      deps
    );
    expect(result).toMatchObject({
      ok: true,
      choice: "lights",
      confidence: 0.92,
      probabilities: { lights: 0.85, calendar: 0.1, none: 0.05 },
      runnerUp: { choice: "calendar", probability: 0.1 }
    });
  });

  it("makes one attempt and no repair retry on a bad answer", async () => {
    const { adapter, generateStructured } = adapterReturning(
      { choice: "lights", confidence: 0.9 },
      goodAnswer
    );
    const { deps } = makeDeps({ sortingModel: typedModel, adapter });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    const result = await askClassifierChoice(
      scopedDb,
      handle,
      { service: SERVICE, state: {}, question },
      deps
    );
    expect(result.ok).toBe(false);
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("declines an answer whose chosen option is not the top score", async () => {
    const { adapter } = adapterReturning({
      choice: "calendar",
      confidence: 0.9,
      scores: { lights: 0.85, calendar: 0.1, none: 0.05 }
    });
    const { deps } = makeDeps({ sortingModel: typedModel, adapter });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    const result = await askClassifierChoice(
      scopedDb,
      handle,
      { service: SERVICE, state: {}, question },
      deps
    );
    expect(result.ok).toBe(false);
  });

  it("declines an answer that names an option not on the menu", async () => {
    const { adapter } = adapterReturning({
      choice: "garage",
      confidence: 0.9,
      scores: { lights: 0.85, calendar: 0.1, none: 0.05 }
    });
    const { deps } = makeDeps({ sortingModel: typedModel, adapter });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    const result = await askClassifierChoice(
      scopedDb,
      handle,
      { service: SERVICE, state: {}, question },
      deps
    );
    expect(result.ok).toBe(false);
  });

  it("does not call the chat model when the classifier answer is bad", async () => {
    const { adapter } = adapterReturning({});
    const { deps, resolveModelForService } = makeDeps({
      sortingModel: typedModel,
      chatModel: typedModel,
      adapter
    });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    await askClassifierChoice(scopedDb, handle, { service: SERVICE, state: {}, question }, deps);
    expect(resolveModelForService).not.toHaveBeenCalled();
  });
});

describe("extractClassifierValues", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["minutes"],
    properties: { minutes: { type: "number", minimum: 1, maximum: 600 } }
  };

  it("declines with not_supported on a choice-only classifier, with no provider call", async () => {
    const fetch = systemOneFetch({}, "x");
    const { deps } = makeDeps({ sortingModel: choiceOnlyModel, fetch });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    const result = await extractClassifierValues(
      scopedDb,
      handle,
      { service: SERVICE, instructions: "Fill the values.", state: {}, schema },
      deps
    );
    expect(result).toEqual({ ok: false, error: "not_supported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns schema-valid values from a typed classifier in one attempt", async () => {
    const { adapter, generateStructured } = adapterReturning({ minutes: 10 });
    const { deps } = makeDeps({ sortingModel: typedModel, adapter });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    const result = await extractClassifierValues(
      scopedDb,
      handle,
      {
        service: SERVICE,
        instructions: "Fill the values.",
        state: { message: "10 minutes" },
        schema
      },
      deps
    );
    expect(result).toMatchObject({ ok: true, values: { minutes: 10 } });
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the values break the schema", async () => {
    const { adapter, generateStructured } = adapterReturning({ minutes: 9999 }, { minutes: 10 });
    const { deps } = makeDeps({ sortingModel: typedModel, adapter });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    const result = await extractClassifierValues(
      scopedDb,
      handle,
      { service: SERVICE, instructions: "Fill the values.", state: {}, schema },
      deps
    );
    expect(result).toEqual({ ok: false, error: "invalid_response" });
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("returns aborted when the deadline fires after the first stage", async () => {
    const controller = new AbortController();
    const generateStructured = vi.fn(async () => {
      controller.abort();
      return { rawObject: { minutes: 10 }, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const { deps } = makeDeps({
      sortingModel: typedModel,
      adapter: { generateStructured } as StructuredProviderAdapter
    });
    const handle = (await resolveClassifier(scopedDb, SERVICE, deps))!;
    const result = await extractClassifierValues(
      scopedDb,
      handle,
      {
        service: SERVICE,
        instructions: "Fill the values.",
        state: {},
        schema,
        signal: controller.signal
      },
      deps
    );
    expect(result).toEqual({ ok: false, error: "aborted" });
  });
});
