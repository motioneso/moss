import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import { StructuredOutputParseError } from "../../packages/ai/src/adapters/http-api-structured.js";
import {
  STRUCTURED_MAX_REPAIR_RETRIES,
  generateStructured,
  type GenerateStructuredDeps,
  type StructuredProviderAdapter
} from "../../packages/ai/src/structured/generate-structured.js";

const scopedDb = {} as DataContextDb;
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["a"],
  properties: { a: { type: "string" } }
};
const model = {
  id: "model-1",
  provider_config_id: "provider-1",
  provider_kind: "anthropic",
  provider_model_id: "claude-x"
} as never;

type DepsOverrides = {
  repository?: Partial<GenerateStructuredDeps["repository"]>;
  cipher?: GenerateStructuredDeps["cipher"];
  logger?: GenerateStructuredDeps["logger"];
  createAdapter?: GenerateStructuredDeps["createAdapter"];
  createCliStructuredAdapter?: GenerateStructuredDeps["createCliStructuredAdapter"];
};

function makeDeps(overrides: DepsOverrides = {}): GenerateStructuredDeps {
  return {
    repository: {
      resolveModelForService: vi.fn(async () => ({
        model,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(
        async () =>
          ({
            id: "provider-1",
            auth_method: "api_key",
            base_url: null,
            encrypted_credential: {}
          }) as never
      ),
      ...overrides.repository
    } as GenerateStructuredDeps["repository"],
    cipher: overrides.cipher ?? { decryptJson: vi.fn(() => ({ apiKey: "sk-test" })) },
    logger: overrides.logger,
    createAdapter: overrides.createAdapter,
    createCliStructuredAdapter: overrides.createCliStructuredAdapter
  };
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return { service: "module.demo-module" as const, schema, prompt: "extract", ...overrides };
}

describe("generateStructured", () => {
  it("happy path: returns the validated object and accumulated usage", async () => {
    const adapter = {
      generateStructured: vi.fn(async () => ({
        rawObject: { a: "b" },
        usage: { inputTokens: 10, outputTokens: 5 }
      }))
    };
    const info = vi.fn();
    const deps = makeDeps({ createAdapter: () => adapter, logger: { info, warn: vi.fn() } });

    const result = await generateStructured(scopedDb, makeInput(), deps);

    expect(result).toEqual({
      ok: true,
      object: { a: "b" },
      usage: { inputTokens: 10, outputTokens: 5 }
    });
    expect(adapter.generateStructured).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      {
        service: "module.demo-module",
        modelId: "model-1",
        inputTokens: 10,
        outputTokens: 5,
        attempts: 1
      },
      "ai.structured usage"
    );
  });

  it("repairs a parse error, accumulates usage, then succeeds", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(
        new StructuredOutputParseError("bad", "not json", { inputTokens: 4, outputTokens: 3 })
      )
      .mockResolvedValueOnce({ rawObject: { a: "b" }, usage: { inputTokens: 6, outputTokens: 2 } });
    const result = await generateStructured(
      scopedDb,
      makeInput(),
      makeDeps({ createAdapter: () => ({ generateStructured: generate }) })
    );

    expect(result).toEqual({
      ok: true,
      object: { a: "b" },
      usage: { inputTokens: 10, outputTokens: 5 }
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0].messages).toHaveLength(3);
  });

  it("routes CLI providers through the injected adapter without decrypting", async () => {
    const decryptJson = vi.fn(() => {
      throw new Error("AES-GCM must not run for CLI");
    });
    const createCliStructuredAdapter = vi.fn(() => ({
      generateStructured: vi.fn(async () => ({
        rawText: '{"a":"cli"}',
        usage: { inputTokens: 0, outputTokens: 0 }
      }))
    }));
    const result = await generateStructured(
      scopedDb,
      makeInput(),
      makeDeps({
        repository: {
          selectProviderWithCredential: vi.fn(
            async () =>
              ({ id: "provider-1", auth_method: "cli", encrypted_credential: {} }) as never
          )
        },
        cipher: { decryptJson },
        createCliStructuredAdapter
      })
    );

    expect(result).toEqual({
      ok: true,
      object: { a: "cli" },
      usage: { inputTokens: 0, outputTokens: 0 }
    });
    expect(createCliStructuredAdapter).toHaveBeenCalledWith("anthropic");
    expect(decryptJson).not.toHaveBeenCalled();
  });

  it("repairs malformed CLI text through the shared Ajv loop", async () => {
    const generateStructured = vi
      .fn()
      .mockResolvedValueOnce({ rawText: "not-json", usage: { inputTokens: 0, outputTokens: 0 } })
      .mockResolvedValueOnce({
        rawText: '{"a":"fixed"}',
        usage: { inputTokens: 0, outputTokens: 0 }
      });
    const result = await generateStructuredResultWithCli(generateStructured);

    expect(result).toMatchObject({ ok: true, object: { a: "fixed" } });
    expect(generateStructured).toHaveBeenCalledTimes(2);
    expect(generateStructured.mock.calls[1]![0].messages).toHaveLength(3);
  });

  // #1888: the Claude CLI wraps its answer in a markdown code fence even when the prompt says
  // "No markdown or commentary", and it does so on every repair retry — so a fenced reply is not
  // a transient miss that the repair loop can recover from, it is the CLI's normal output shape.
  // Live proof: asking Moss for a module failed three identical attempts, each a schema-valid plan
  // inside a ```json fence. Accept the fence here, where CLI text is already parsed.
  it("accepts a schema-valid CLI reply wrapped in a markdown code fence", async () => {
    const generateStructured = vi.fn().mockResolvedValue({
      rawText: '```json\n{"a":"fenced"}\n```',
      usage: { inputTokens: 0, outputTokens: 0 }
    });
    const result = await generateStructuredResultWithCli(generateStructured);

    expect(result).toMatchObject({ ok: true, object: { a: "fenced" } });
    // No repair round-trip: the first reply is accepted as-is.
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it("accepts a fenced CLI reply with no language tag", async () => {
    const generateStructured = vi.fn().mockResolvedValue({
      rawText: '```\n{"a":"plain-fence"}\n```',
      usage: { inputTokens: 0, outputTokens: 0 }
    });
    const result = await generateStructuredResultWithCli(generateStructured);

    expect(result).toMatchObject({ ok: true, object: { a: "plain-fence" } });
  });

  // Guard the narrowness of the fix: unfenced prose around JSON is still a parse failure that goes
  // through the repair loop, so this never becomes "scrape a JSON-looking blob out of any text".
  it("still repairs CLI text that is prose around JSON rather than a fenced block", async () => {
    const generateStructured = vi
      .fn()
      .mockResolvedValueOnce({
        rawText: 'Here you go: {"a":"loose"} - hope that helps',
        usage: { inputTokens: 0, outputTokens: 0 }
      })
      .mockResolvedValueOnce({
        rawText: '{"a":"fixed"}',
        usage: { inputTokens: 0, outputTokens: 0 }
      });
    const result = await generateStructuredResultWithCli(generateStructured);

    expect(result).toMatchObject({ ok: true, object: { a: "fixed" } });
    expect(generateStructured).toHaveBeenCalledTimes(2);
  });

  it("maps corrupt API credentials to needs_config without exposing cipher errors", async () => {
    const warn = vi.fn();
    const result = await generateStructured(
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
    expect(result).toEqual({ ok: false, error: "needs_config" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("AES-GCM");
  });

  it("returns validation_failed after bounded retries", async () => {
    const generate = vi.fn(async () => ({
      rawObject: { a: 123 },
      usage: { inputTokens: 1, outputTokens: 1 }
    }));
    const result = await generateStructured(
      scopedDb,
      makeInput(),
      makeDeps({ createAdapter: () => ({ generateStructured: generate }) })
    );
    expect(result).toEqual({ ok: false, error: "validation_failed" });
    expect(generate).toHaveBeenCalledTimes(1 + STRUCTURED_MAX_REPAIR_RETRIES);
  });

  it("needs_config on missing model, provider, or credential", async () => {
    const noModel = makeDeps({
      repository: {
        resolveModelForService: vi.fn(async () => ({
          model: null,
          reason: "needs-config" as const
        }))
      }
    });
    expect(await generateStructured(scopedDb, makeInput(), noModel)).toEqual({
      ok: false,
      error: "needs_config"
    });
    expect(
      await generateStructured(
        scopedDb,
        makeInput(),
        makeDeps({ repository: { selectProviderWithCredential: vi.fn(async () => undefined) } })
      )
    ).toEqual({ ok: false, error: "needs_config" });
    expect(
      await generateStructured(
        scopedDb,
        makeInput(),
        makeDeps({ cipher: { decryptJson: vi.fn(() => ({})) } })
      )
    ).toEqual({ ok: false, error: "needs_config" });
  });

  it("maps pre-abort and AbortError to aborted", async () => {
    const adapter = { generateStructured: vi.fn() };
    const pre = new AbortController();
    pre.abort();
    expect(
      await generateStructured(
        scopedDb,
        makeInput({ signal: pre.signal }),
        makeDeps({ createAdapter: () => adapter })
      )
    ).toEqual({ ok: false, error: "aborted" });
    expect(adapter.generateStructured).not.toHaveBeenCalled();

    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    expect(
      await generateStructured(
        scopedDb,
        makeInput(),
        makeDeps({
          createAdapter: () => ({ generateStructured: vi.fn().mockRejectedValue(abortError) })
        })
      )
    ).toEqual({ ok: false, error: "aborted" });
  });

  it("maps non-repairable adapter failures to provider_error", async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      createAdapter: () => ({
        generateStructured: vi
          .fn()
          .mockRejectedValue(new Error("AI provider request failed: HTTP 500"))
      }),
      logger: { info: vi.fn(), warn }
    });
    expect(await generateStructured(scopedDb, makeInput(), deps)).toEqual({
      ok: false,
      error: "provider_error"
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "http_500" }),
      "ai.structured provider error"
    );
  });

  // Review S2: `HttpApiAdapter.generateStructured` calls `response.json()`, and a
  // malformed-but-successful response makes Node fold the raw response body into
  // `SyntaxError.message`. Before this fix, that message was logged as-is, so private response
  // content crossed the logging boundary. Now only a fixed diagnostic code is logged.
  it("never logs raw response text from a malformed-JSON provider error", async () => {
    const warn = vi.fn();
    const privateResponseText = "PRIVATE_SENTINEL";
    const deps = makeDeps({
      createAdapter: () => ({
        generateStructured: vi
          .fn()
          .mockRejectedValue(
            new SyntaxError(`Unexpected token 'P', "${privateResponseText}" is not valid JSON`)
          )
      }),
      logger: { info: vi.fn(), warn }
    });

    expect(await generateStructured(scopedDb, makeInput(), deps)).toEqual({
      ok: false,
      error: "provider_error"
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateResponseText);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "invalid_response_body" }),
      "ai.structured provider error"
    );
  });

  it("rejects provider kinds unsupported by the structured HTTP adapter", async () => {
    const unsupportedModel = {
      id: "model-unsupported",
      provider_config_id: "provider-1",
      provider_kind: "ollama",
      provider_model_id: "llama-x"
    } as never;
    const createAdapter = vi.fn(() => ({
      generateStructured: vi.fn(async () => ({
        rawObject: { a: "b" },
        usage: { inputTokens: 1, outputTokens: 1 }
      }))
    }));
    const deps = makeDeps({
      repository: {
        resolveModelForService: vi.fn(async () => ({
          model: unsupportedModel,
          reason: "matched-active-model" as const
        }))
      },
      createAdapter
    });

    expect(await generateStructured(scopedDb, makeInput(), deps)).toEqual({
      ok: false,
      error: "provider_error"
    });
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("fails oversize results without repair", async () => {
    const generate = vi.fn(async () => ({
      rawObject: { a: "x".repeat(140_000) },
      usage: { inputTokens: 1, outputTokens: 1 }
    }));
    expect(
      await generateStructured(
        scopedDb,
        makeInput(),
        makeDeps({ createAdapter: () => ({ generateStructured: generate }) })
      )
    ).toEqual({ ok: false, error: "validation_failed" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("throws on input-bound violations", async () => {
    await expect(
      generateStructured(
        scopedDb,
        makeInput({ schema: { type: "object", properties: { a: { $ref: "#/x" } } } }),
        makeDeps()
      )
    ).rejects.toThrow(/not allowed/);
  });
});

function generateStructuredResultWithCli(
  generate: StructuredProviderAdapter["generateStructured"]
) {
  return generateStructured(
    scopedDb,
    makeInput(),
    makeDeps({
      repository: {
        selectProviderWithCredential: vi.fn(
          async () => ({ id: "provider-1", auth_method: "cli", encrypted_credential: {} }) as never
        )
      },
      createCliStructuredAdapter: () => ({ generateStructured: generate })
    })
  );
}
