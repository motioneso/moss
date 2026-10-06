import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import {
  GATE_TIMEOUT_ABORT_REASON,
  installModelActivityRecorder,
  type ModelActivityEntry
} from "../../packages/ai/src/model-activity.js";
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

  describe("model activity recording (plan 3.6b, #2890)", () => {
    it("records one structured/choices row for a real System One post", async () => {
      const entries: ModelActivityEntry[] = [];
      installModelActivityRecorder((entry) => entries.push(entry));
      try {
        const { deps } = okFetch(validResponse);
        const result = await generateChoices(scopedDb, makeInput(), deps);

        expect(result.ok).toBe(true);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          kind: "structured",
          action: "choices",
          outcome: "ok",
          modelName: "jev-latest",
          result: "completed"
        });
      } finally {
        installModelActivityRecorder(null);
      }
    });

    it("records an error outcome when the provider call fails", async () => {
      const entries: ModelActivityEntry[] = [];
      installModelActivityRecorder((entry) => entries.push(entry));
      try {
        const deps = makeDeps({
          fetch: vi.fn(async () => jsonResponse(500, {})) as unknown as typeof fetch
        });
        expect(await generateChoices(scopedDb, makeInput(), deps)).toEqual({
          ok: false,
          error: "provider_error"
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ outcome: "error", result: "failed" });
      } finally {
        installModelActivityRecorder(null);
      }
    });

    it("records an error outcome when a 200 response body is unusable", async () => {
      const entries: ModelActivityEntry[] = [];
      installModelActivityRecorder((entry) => entries.push(entry));
      try {
        const { deps } = okFetch("not-json-object");
        expect(await generateChoices(scopedDb, makeInput(), deps)).toEqual({
          ok: false,
          error: "invalid_response"
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ outcome: "error", result: "failed" });
      } finally {
        installModelActivityRecorder(null);
      }
    });

    it("records an aborted outcome when the caller's signal fires", async () => {
      const entries: ModelActivityEntry[] = [];
      installModelActivityRecorder((entry) => entries.push(entry));
      try {
        const controller = new AbortController();
        controller.abort();
        const abortError = new Error("aborted");
        abortError.name = "AbortError";
        const deps = makeDeps({
          fetch: vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch
        });
        expect(
          await generateChoices(scopedDb, makeInput({ signal: controller.signal }), deps)
        ).toBeDefined();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ outcome: "aborted", result: "stopped" });
      } finally {
        installModelActivityRecorder(null);
      }
    });

    it("files nothing when the gate deadline aborts the post — the gate owns the line — #3064", async () => {
      const entries: ModelActivityEntry[] = [];
      installModelActivityRecorder((entry) => entries.push(entry));
      try {
        const controller = new AbortController();
        controller.abort(GATE_TIMEOUT_ABORT_REASON);
        const abortError = new Error("aborted");
        abortError.name = "AbortError";
        const deps = makeDeps({
          fetch: vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch
        });
        expect(
          await generateChoices(
            scopedDb,
            makeInput({
              signal: controller.signal,
              activity: {
                actionCode: "chat.tool_check",
                ownerUserId: "user-1",
                turnId: "turn-1"
              }
            }),
            deps
          )
        ).toEqual({ ok: false, error: "aborted" });
        expect(entries).toHaveLength(0);
      } finally {
        installModelActivityRecorder(null);
      }
    });

    it("files nothing when the gate deadline aborts model resolution — #3064", async () => {
      const entries: ModelActivityEntry[] = [];
      installModelActivityRecorder((entry) => entries.push(entry));
      try {
        const controller = new AbortController();
        const deps = makeDeps({
          repository: {
            resolveModelForService: vi.fn(async () => {
              controller.abort(GATE_TIMEOUT_ABORT_REASON);
              throw new Error("db wedged");
            })
          }
        });
        await expect(
          generateChoices(
            scopedDb,
            makeInput({
              signal: controller.signal,
              activity: {
                actionCode: "chat.tool_check",
                ownerUserId: "user-1",
                turnId: "turn-1"
              }
            }),
            deps
          )
        ).rejects.toThrow("db wedged");
        expect(entries).toHaveLength(0);
      } finally {
        installModelActivityRecorder(null);
      }
    });

    it("records nothing when no call is made (not supported), and never the state text", async () => {
      const entries: ModelActivityEntry[] = [];
      installModelActivityRecorder((entry) => entries.push(entry));
      try {
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
        expect(entries).toHaveLength(0);

        const SENTINEL = "SENTINEL-state-text-do-not-record";
        const { deps: okDeps } = okFetch(validResponse);
        await generateChoices(scopedDb, makeInput({ state: { title: SENTINEL } }), okDeps);
        expect(JSON.stringify(entries)).not.toContain(SENTINEL);
      } finally {
        installModelActivityRecorder(null);
      }
    });
  });
});

describe("generateChoices activity lines", () => {
  it("records chat.tool_check with owner, turn, confidence and tokens", async () => {
    const { deps } = okFetch(validResponse);
    const entries: ModelActivityEntry[] = [];
    installModelActivityRecorder((entry) => entries.push(entry));
    try {
      const result = await generateChoices(
        scopedDb,
        makeInput({
          activity: {
            ownerUserId: "user-1",
            turnId: "turn-1",
            parentId: "answer-1",
            actionCode: "chat.tool_check"
          }
        }),
        deps
      );
      expect(result.ok).toBe(true);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: "structured",
        actionCode: "chat.tool_check",
        ownerUserId: "user-1",
        turnId: "turn-1",
        parentId: "answer-1",
        outcome: "ok",
        inputTokens: 12,
        outputTokens: 3,
        factCounts: { confidence: 0.8 }
      });
      expect(typeof entries[0]?.durationMs).toBe("number");
    } finally {
      installModelActivityRecorder(null);
    }
  });

  it("defaults to the service structured code when the caller names none", async () => {
    const { deps } = okFetch(validResponse);
    const entries: ModelActivityEntry[] = [];
    installModelActivityRecorder((entry) => entries.push(entry));
    try {
      await generateChoices(scopedDb, makeInput(), deps);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actionCode: "structured.focus-judgment",
        outcome: "ok"
      });
      expect(entries[0]).not.toHaveProperty("ownerUserId");
    } finally {
      installModelActivityRecorder(null);
    }
  });

  it("records a failed post with a code and no confidence", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: "internal" }));
    const deps = makeDeps({ fetch: fetchMock as unknown as typeof fetch });
    const entries: ModelActivityEntry[] = [];
    installModelActivityRecorder((entry) => entries.push(entry));
    try {
      const result = await generateChoices(
        scopedDb,
        makeInput({ activity: { ownerUserId: "user-1", turnId: "turn-1" } }),
        deps
      );
      expect(result).toEqual({ ok: false, error: "provider_error" });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ outcome: "error", ownerUserId: "user-1" });
      expect(entries[0]?.factCounts).toBeUndefined();
    } finally {
      installModelActivityRecorder(null);
    }
  });
});

const CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const CLOUDFLARE_BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai`;

function cloudflareDeps(
  overrides: {
    readonly modelId?: string;
    readonly capabilities?: readonly string[];
    readonly fetch?: typeof fetch;
    readonly logger?: GenerateChoicesDeps["logger"];
  } = {}
): GenerateChoicesDeps {
  return makeDeps({
    repository: {
      resolveModelForService: vi.fn(async () => ({
        model: {
          ...(model as object),
          provider_model_id: overrides.modelId ?? "clef-flash",
          ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {})
        } as never,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(
        async () => ({ ...(provider as object), base_url: CLOUDFLARE_BASE_URL }) as never
      )
    },
    fetch: overrides.fetch,
    logger: overrides.logger
  });
}

describe("generateChoices Cloudflare dialect (#3057)", () => {
  it("posts to the Cloudflare run path with the model id in the URL and body", async () => {
    const { fetchMock } = okFetch({ success: true, result: validResponse });
    const deps = cloudflareDeps({ fetch: fetchMock as unknown as typeof fetch });

    await generateChoices(scopedDb, makeInput(), deps);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${CLOUDFLARE_BASE_URL}/run/@cf/cloudflare/clef-flash`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "clef-flash" });
  });

  it("unwraps a Cloudflare reply to the same answers and token counts as a Jev reply", async () => {
    const { deps } = okFetch(validResponse);
    const jev = await generateChoices(scopedDb, makeInput(), deps);

    const { fetchMock } = okFetch({
      success: true,
      result: validResponse,
      errors: [],
      messages: []
    });
    const clef = await generateChoices(
      scopedDb,
      makeInput(),
      cloudflareDeps({ fetch: fetchMock as unknown as typeof fetch })
    );

    expect(clef).toEqual(jev);
    expect(clef).toEqual({
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
  });

  it("reports success:false as provider_error, not invalid_response", async () => {
    const warn = vi.fn();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { success: false, errors: [{ code: 7000 }], messages: [] })
    );
    const deps = cloudflareDeps({
      fetch: fetchMock as unknown as typeof fetch,
      logger: { info: vi.fn(), warn }
    });

    expect(await generateChoices(scopedDb, makeInput(), deps)).toEqual({
      ok: false,
      error: "provider_error"
    });
    expect(warn).toHaveBeenCalledWith(
      { service: "module.focus-judgment", code: "cloudflare_error" },
      "ai.generateChoices provider error"
    );
  });

  it("refuses a model id outside the fixed list without sending a request", async () => {
    const fetchMock = vi.fn();
    const deps = cloudflareDeps({
      modelId: "../x",
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(await generateChoices(scopedDb, makeInput(), deps)).toEqual({
      ok: false,
      error: "provider_error"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("generateChoices image lane (#3067)", () => {
  // A distinctive base64 run, so a leak into a log or activity row is unmistakable.
  const IMAGE = `data:image/jpeg;base64,${"QklOR08".repeat(4)}${"A".repeat(200_000)}`;

  it("sends a Clef model with vision the picture in images, outside state", async () => {
    const { fetchMock } = okFetch({ success: true, result: validResponse });
    const deps = cloudflareDeps({
      capabilities: ["json", "vision"],
      fetch: fetchMock as unknown as typeof fetch
    });

    // 11,000 bytes of state plus a 200 KB picture: the text cap counts the state, not the picture.
    const result = await generateChoices(
      scopedDb,
      makeInput({ state: { blob: "x".repeat(11_000) }, image: IMAGE }),
      deps
    );

    expect(result.ok).toBe(true);
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(sent["images"]).toEqual([IMAGE]);
    expect(JSON.stringify(sent["state"])).not.toContain("QklOR08");
    expect(Object.keys(sent).sort()).toEqual(["images", "model", "questions", "state"]);
  });

  it("still refuses oversize state when a picture rides along", async () => {
    const fetchMock = vi.fn();
    const deps = cloudflareDeps({
      capabilities: ["json", "vision"],
      fetch: fetchMock as unknown as typeof fetch
    });

    const result = await generateChoices(
      scopedDb,
      makeInput({ state: { blob: "x".repeat(13_000) }, image: IMAGE }),
      deps
    );

    expect(result).toEqual({ ok: false, error: "provider_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a picture over its own cap without a request or the picture in the log", async () => {
    const fetchMock = vi.fn();
    const warn = vi.fn();
    const deps = cloudflareDeps({
      capabilities: ["json", "vision"],
      fetch: fetchMock as unknown as typeof fetch,
      logger: { info: vi.fn(), warn }
    });

    const result = await generateChoices(
      scopedDb,
      makeInput({ image: `data:image/jpeg;base64,${"A".repeat(1_048_576)}` }),
      deps
    );

    expect(result).toEqual({ ok: false, error: "provider_error" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { service: "module.focus-judgment", code: "image_too_large" },
      "ai.generateChoices request rejected"
    );
  });

  it.each([
    ["Clef without vision", () => cloudflareDeps({ capabilities: ["json"] })],
    ["Clef with no capabilities on the row", () => cloudflareDeps()],
    [
      "the standard dialect, even with vision",
      () =>
        makeDeps({
          repository: {
            resolveModelForService: vi.fn(async () => ({
              model: { ...(model as object), capabilities: ["json", "vision"] } as never,
              reason: "matched-active-model" as const
            }))
          }
        })
    ],
    [
      "a model id outside the Clef list, even on Cloudflare with vision",
      () => cloudflareDeps({ modelId: "jev-latest", capabilities: ["json", "vision"] })
    ]
  ])("answers not_supported for %s, and never sends the picture", async (_name, build) => {
    const fetchMock = vi.fn();
    const deps = { ...build(), fetch: fetchMock as unknown as typeof fetch };
    const entries: ModelActivityEntry[] = [];
    installModelActivityRecorder((entry) => entries.push(entry));
    try {
      expect(await generateChoices(scopedDb, makeInput({ image: IMAGE }), deps)).toEqual({
        ok: false,
        error: "not_supported"
      });
    } finally {
      installModelActivityRecorder(null);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
  });

  it("refuses a picture for an explicit model passed without its capabilities", async () => {
    const fetchMock = vi.fn();
    const deps = cloudflareDeps({ fetch: fetchMock as unknown as typeof fetch });

    const result = await generateChoices(
      scopedDb,
      makeInput({
        image: IMAGE,
        explicitModel: {
          id: "model-1",
          provider_config_id: "provider-1",
          provider_kind: "system-one",
          provider_model_id: "clef-flash"
        }
      }),
      deps
    );

    expect(result).toEqual({ ok: false, error: "not_supported" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a text-only Clef request byte for byte as before, with vision on the row", async () => {
    const { fetchMock } = okFetch({ success: true, result: validResponse });
    await generateChoices(
      scopedDb,
      makeInput(),
      cloudflareDeps({
        capabilities: ["json", "vision"],
        fetch: fetchMock as unknown as typeof fetch
      })
    );

    expect(fetchMock.mock.calls[0]![1].body).toBe(
      JSON.stringify({
        model: "clef-flash",
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

  it("counts the picture on the activity line and never records or logs it", async () => {
    const entries: ModelActivityEntry[] = [];
    const info = vi.fn();
    const warn = vi.fn();
    installModelActivityRecorder((entry) => entries.push(entry));
    try {
      const ok = okFetch({ success: true, result: validResponse });
      await generateChoices(
        scopedDb,
        makeInput({ image: IMAGE }),
        cloudflareDeps({
          capabilities: ["json", "vision"],
          fetch: ok.fetchMock as unknown as typeof fetch,
          logger: { info, warn }
        })
      );
      const failing = vi.fn(async () => jsonResponse(500, {}));
      await generateChoices(
        scopedDb,
        makeInput({ image: IMAGE }),
        cloudflareDeps({
          capabilities: ["json", "vision"],
          fetch: failing as unknown as typeof fetch,
          logger: { info, warn }
        })
      );
      await generateChoices(
        scopedDb,
        makeInput(),
        cloudflareDeps({
          capabilities: ["json", "vision"],
          fetch: okFetch({ success: true, result: validResponse })
            .fetchMock as unknown as typeof fetch
        })
      );
    } finally {
      installModelActivityRecorder(null);
    }

    expect(entries).toHaveLength(3);
    expect(entries[0]!.factCounts).toEqual({ confidence: 0.8, images: 1 });
    expect(entries[1]!.factCounts).toEqual({ images: 1 });
    expect(entries[2]!.factCounts).toEqual({ confidence: 0.8 });
    const recorded = JSON.stringify([entries, info.mock.calls, warn.mock.calls]);
    expect(recorded).not.toContain("QklOR08");
  });
});
