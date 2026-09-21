import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import {
  generateChoices,
  type GenerateChoicesDeps
} from "../../packages/ai/src/structured/generate-choices.js";

const scopedDb = {} as DataContextDb;

const model = {
  id: "model-1",
  provider_config_id: "provider-1",
  provider_kind: "system-one",
  provider_model_id: "jev-latest"
} as never;

const provider = {
  id: "provider-1",
  auth_method: "api_key",
  base_url: null,
  encrypted_credential: {}
} as never;

const questions = {
  alignment: {
    instructions: "Classify the focus",
    criteria: {
      focused: "making progress on the task",
      necessary_detour: "a necessary side trip",
      distracted: "off task"
    }
  }
} as const;

const state = { app: "Xcode", title: "Editor" };

const validResponse = {
  model: "jev-latest",
  answers: {
    alignment: {
      type: "choice",
      choice: "focused",
      confidence: 0.8,
      probabilities: { focused: 0.8, necessary_detour: 0.15, distracted: 0.05 }
    }
  },
  usage: { input_tokens: 12, output_tokens: 3 }
};

type DepsOverrides = {
  repository?: Partial<GenerateChoicesDeps["repository"]>;
  cipher?: GenerateChoicesDeps["cipher"];
  logger?: GenerateChoicesDeps["logger"];
  fetch?: typeof fetch;
};

function makeDeps(overrides: DepsOverrides = {}): GenerateChoicesDeps {
  return {
    repository: {
      resolveModelForService: vi.fn(async () => ({
        model,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(async () => provider),
      ...overrides.repository
    } as GenerateChoicesDeps["repository"],
    cipher: overrides.cipher ?? { decryptJson: vi.fn(() => ({ apiKey: "ts-secret-key" })) },
    logger: overrides.logger,
    fetch: overrides.fetch
  };
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return { service: "module.focus-judgment" as const, state, questions, ...overrides };
}

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  } as unknown as Response;
}

function okFetch(payload: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, payload));
  return { fetchMock, deps: makeDeps({ fetch: fetchMock as unknown as typeof fetch }) };
}

describe("generateChoices", () => {
  it("posts the System One request body to the default base URL", async () => {
    const { fetchMock, deps } = okFetch(validResponse);

    const result = await generateChoices(scopedDb, makeInput(), deps);

    expect(result).toEqual({
      ok: true,
      answers: {
        alignment: {
          choice: "focused",
          confidence: 0.8,
          probabilities: { focused: 0.8, necessary_detour: 0.15, distracted: 0.05 }
        }
      },
      usage: { inputTokens: 12, outputTokens: 3 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer ts-secret-key"
    });
    expect(init.redirect).toBe("error");
    // Fixture the whole serialised body so a renamed or dropped field fails the test.
    expect(init.body).toBe(
      JSON.stringify({
        model: "jev-latest",
        state: { app: "Xcode", title: "Editor" },
        questions: {
          alignment: {
            type: "choice",
            instructions: "Classify the focus",
            criteria: {
              focused: "making progress on the task",
              necessary_detour: "a necessary side trip",
              distracted: "off task"
            }
          }
        }
      })
    );
  });

  it("uses a custom base URL with trailing slashes trimmed", async () => {
    const { fetchMock } = okFetch(validResponse);
    const custom = makeDeps({
      repository: {
        selectProviderWithCredential: vi.fn(
          async () =>
            ({ ...(provider as object), base_url: "https://custom.example/api///" }) as never
        )
      },
      fetch: fetchMock as unknown as typeof fetch
    });

    await generateChoices(scopedDb, makeInput(), custom);

    expect(fetchMock.mock.calls[0]![0]).toBe("https://custom.example/api/v1/systemone");
  });

  it("returns not_supported for another provider kind without calling fetch", async () => {
    const fetchMock = vi.fn();
    const deps = makeDeps({
      repository: {
        resolveModelForService: vi.fn(async () => ({
          model: { ...(model as object), provider_kind: "anthropic" } as never,
          reason: "matched-active-model" as const
        }))
      },
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(await generateChoices(scopedDb, makeInput(), deps)).toEqual({
      ok: false,
      error: "not_supported"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns needs_config for no model, no provider, CLI auth, or bad credential", async () => {
    const noModel = makeDeps({
      repository: {
        resolveModelForService: vi.fn(async () => ({
          model: null,
          reason: "needs-config" as const
        }))
      }
    });
    expect(await generateChoices(scopedDb, makeInput(), noModel)).toEqual({
      ok: false,
      error: "needs_config"
    });

    expect(
      await generateChoices(
        scopedDb,
        makeInput(),
        makeDeps({ repository: { selectProviderWithCredential: vi.fn(async () => undefined) } })
      )
    ).toEqual({ ok: false, error: "needs_config" });

    expect(
      await generateChoices(
        scopedDb,
        makeInput(),
        makeDeps({
          repository: {
            selectProviderWithCredential: vi.fn(
              async () => ({ ...(provider as object), auth_method: "cli" }) as never
            )
          }
        })
      )
    ).toEqual({ ok: false, error: "needs_config" });

    const warn = vi.fn();
    const undecryptable = await generateChoices(
      scopedDb,
      makeInput(),
      makeDeps({
        cipher: {
          decryptJson: vi.fn(() => {
            throw new Error("raw AES-GCM secret");
          })
        },
        logger: { info: vi.fn(), warn }
      })
    );
    expect(undecryptable).toEqual({ ok: false, error: "needs_config" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("AES-GCM");

    expect(
      await generateChoices(
        scopedDb,
        makeInput(),
        makeDeps({ cipher: { decryptJson: vi.fn(() => ({})) } })
      )
    ).toEqual({ ok: false, error: "needs_config" });
  });

  describe("response validation rejects each rule independently", () => {
    async function expectInvalid(answer: unknown) {
      const { deps } = okFetch({
        answers: { alignment: answer },
        usage: { input_tokens: 1, output_tokens: 1 }
      });
      expect(await generateChoices(scopedDb, makeInput(), deps)).toEqual({
        ok: false,
        error: "invalid_response"
      });
    }

    const base = {
      type: "choice",
      choice: "focused",
      confidence: 0.8,
      probabilities: { focused: 0.8, necessary_detour: 0.15, distracted: 0.05 }
    };

    it("wrong answer type", async () => {
      await expectInvalid({ ...base, type: "score" });
    });

    it("choice not among the criteria", async () => {
      await expectInvalid({ ...base, choice: "other" });
    });

    it("missing probability key", async () => {
      await expectInvalid({
        ...base,
        probabilities: { focused: 0.85, necessary_detour: 0.15 }
      });
    });

    it("extra probability key", async () => {
      await expectInvalid({
        ...base,
        probabilities: { focused: 0.8, necessary_detour: 0.15, distracted: 0.04, other: 0.01 }
      });
    });

    it("probability out of range", async () => {
      await expectInvalid({
        ...base,
        probabilities: { focused: 1.2, necessary_detour: -0.1, distracted: -0.1 }
      });
    });

    it("probabilities do not sum to one", async () => {
      await expectInvalid({
        ...base,
        probabilities: { focused: 0.6, necessary_detour: 0.2, distracted: 0.1 }
      });
    });

    it("chosen choice is not the highest probability", async () => {
      await expectInvalid({ ...base, choice: "necessary_detour" });
    });

    it("confidence out of range", async () => {
      await expectInvalid({ ...base, confidence: 1.5 });
    });

    it("missing answer for a requested question", async () => {
      const { deps } = okFetch({ answers: {} });
      expect(await generateChoices(scopedDb, makeInput(), deps)).toEqual({
        ok: false,
        error: "invalid_response"
      });
    });
  });

  it("tolerates extra answers that were not asked for, and defaults absent usage", async () => {
    const { deps } = okFetch({
      answers: {
        alignment: validResponse.answers.alignment,
        something_else: { type: "choice", choice: "irrelevant", confidence: 1, probabilities: {} }
      }
    });

    const result = await generateChoices(scopedDb, makeInput(), deps);

    expect(result).toEqual({
      ok: true,
      answers: {
        alignment: {
          choice: "focused",
          confidence: 0.8,
          probabilities: { focused: 0.8, necessary_detour: 0.15, distracted: 0.05 }
        }
      },
      usage: { inputTokens: 0, outputTokens: 0 }
    });
  });

  it("maps a 401 to provider_error without logging the key or body", async () => {
    const warn = vi.fn();
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: "PRIVATE_SENTINEL" }));
    const deps = makeDeps({
      logger: { info: vi.fn(), warn },
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(await generateChoices(scopedDb, makeInput(), deps)).toEqual({
      ok: false,
      error: "provider_error"
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("ts-secret-key");
    expect(logged).not.toContain("PRIVATE_SENTINEL");
    expect(logged).not.toContain("Xcode");
    expect(warn).toHaveBeenCalledWith(
      { service: "module.focus-judgment", code: "http_401" },
      "ai.generateChoices provider error"
    );
  });

  it("maps a timeout to provider_error and an aborted caller signal to aborted", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    const timeoutWarn = vi.fn();
    const timeoutDeps = makeDeps({
      logger: { info: vi.fn(), warn: timeoutWarn },
      fetch: vi.fn().mockRejectedValue(timeoutError) as unknown as typeof fetch
    });
    expect(await generateChoices(scopedDb, makeInput(), timeoutDeps)).toEqual({
      ok: false,
      error: "provider_error"
    });
    expect(timeoutWarn).toHaveBeenCalledWith(
      { service: "module.focus-judgment", code: "timeout" },
      "ai.generateChoices provider error"
    );

    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const controller = new AbortController();
    controller.abort();
    const abortDeps = makeDeps({
      fetch: vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch
    });
    expect(
      await generateChoices(scopedDb, makeInput({ signal: controller.signal }), abortDeps)
    ).toEqual({ ok: false, error: "aborted" });
  });

  it("maps a transport failure to provider_error with network_error", async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      logger: { info: vi.fn(), warn },
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch
    });

    expect(await generateChoices(scopedDb, makeInput(), deps)).toEqual({
      ok: false,
      error: "provider_error"
    });
    expect(warn).toHaveBeenCalledWith(
      { service: "module.focus-judgment", code: "network_error" },
      "ai.generateChoices provider error"
    );
  });

  it("refuses an oversize request without calling the provider", async () => {
    const fetchMock = vi.fn();
    const warn = vi.fn();
    const deps = makeDeps({
      logger: { info: vi.fn(), warn },
      fetch: fetchMock as unknown as typeof fetch
    });

    const result = await generateChoices(
      scopedDb,
      makeInput({ state: { blob: "x".repeat(13_000) } }),
      deps
    );

    expect(result).toEqual({ ok: false, error: "provider_error" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { service: "module.focus-judgment", code: "request_too_large" },
      "ai.generateChoices request rejected"
    );
  });
});
