import { afterEach, expect, it, vi } from "vitest";
import {
  CLI_STRUCTURED_TIMEOUT_MESSAGE,
  prepareStructuredGeneration,
  createAiSecretCipher,
  STRUCTURED_PROMPT_MAX_BYTES,
  STRUCTURED_RESULT_MAX_BYTES,
  type AiProviderWithSealedCredential,
  type GenerateStructuredInput,
  type StructuredProviderAdapter
} from "@moss/ai";
import { createConstrainedCliStructuredAdapterFactory } from "../../packages/chat/src/live/constrained-structured-adapter.js";
import { ConstrainedProcessError } from "../../packages/chat/src/live/constrained-structured-process.js";
import type { ChatEngineFactory } from "../../packages/chat/src/live/runtime.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const owner = "12345678-1234-4234-9234-123456789abc";
const usage = { inputTokens: 10, outputTokens: 5 };
const request = {
  service: "module.meetings.summary" as const,
  explicitModel: {
    id: "model",
    provider_config_id: "provider",
    provider_kind: "anthropic",
    provider_model_id: "selected-model"
  },
  schema: {
    type: "object",
    properties: { overview: { type: "string" } },
    required: ["overview"],
    additionalProperties: false
  },
  prompt: "Synthetic fixture"
};

function fixture(rawText = '{"overview":"Done"}', actor: string | null = owner) {
  let open = true;
  const { scoped, queries } = makeRecordingDb({
    rows: [{ actor }],
    beforeQuery: async () => {
      expect(open).toBe(true);
    }
  });
  const generate = vi.fn<StructuredProviderAdapter["generateStructured"]>(async () => {
    expect(open).toBe(false);
    return { rawText, usage };
  });
  const decryptJson = vi.fn(() => {
    throw new Error("CLI must not decrypt");
  });
  const lookup = vi.fn(async () => {
    expect(open).toBe(true);
    return {
      auth_method: "cli",
      acp_agent_id: "selected-agent",
      encrypted_credential: createAiSecretCipher().encryptJson({ cli: true })
    } as AiProviderWithSealedCredential;
  });
  const createCliStructuredAdapter = vi.fn(() => ({ generateStructured: generate }));
  return {
    scoped,
    queries,
    generate,
    decryptJson,
    lookup,
    createCliStructuredAdapter,
    close() {
      open = false;
    },
    deps: {
      cipher: { decryptJson },
      repository: { selectProviderWithCredential: lookup },
      createCliStructuredAdapter
    }
  };
}

afterEach(() => vi.restoreAllMocks());

it.each(["anthropic", "openai-compatible"])(
  "prepares %s CLI once with captured actor and no post-transaction DB or decrypt",
  async (kind) => {
    const f = fixture();
    const input = {
      ...request,
      explicitModel: { ...request.explicitModel, provider_kind: kind },
      nativeSearch: true,
      sorting: true,
      replySchema: { type: "object" },
      singleAttempt: false,
      actorUserId: "untrusted-owner",
      scope: { threadId: "untrusted" },
      telemetry: { emit: vi.fn() }
    };
    const run = await prepareStructuredGeneration(f.scoped, input, f.deps);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.queries).toHaveLength(1);
    f.close();
    expect(await run()).toEqual({
      ok: true,
      object: { overview: "Done" },
      usage,
      servedBy: "main"
    });
    expect(await run()).toEqual({ ok: false, error: "provider_error", reason: "provider_failure" });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(f.createCliStructuredAdapter).toHaveBeenCalledExactlyOnceWith(kind);
    expect(f.decryptJson).not.toHaveBeenCalled();
    expect(f.queries).toHaveLength(1);
    expect(f.generate.mock.calls[0]![0]).toMatchObject({
      actorUserId: owner,
      acpAgentId: "selected-agent",
      model: { provider_kind: kind, provider_model_id: "selected-model" },
      schema: request.schema,
      messages: [{ role: "user", content: request.prompt }],
      nativeSearch: undefined,
      scope: undefined,
      telemetry: undefined
    });
  }
);

it("captures an absent actor only once", async () => {
  const f = fixture(undefined, null);
  const run = await prepareStructuredGeneration(f.scoped, request, f.deps);
  f.close();
  expect(await run()).toMatchObject({ ok: true });
  expect(f.queries).toHaveLength(1);
  expect(f.generate.mock.calls[0]![0]).not.toHaveProperty("actorUserId");
});

it.each([
  '{"overview":"Done"}',
  '```json\n{"overview":"Done"}\n```',
  ' \n```\n{"overview":"Done"}\n```\n '
])("accepts whole JSON or a whole fence: %s", async (rawText) => {
  const f = fixture(rawText);
  const run = await prepareStructuredGeneration(f.scoped, request, f.deps);
  f.close();
  expect(await run()).toMatchObject({ ok: true, object: { overview: "Done" } });
});

it.each([
  'Here is the summary: {"overview":"Done"}',
  '```json\n{"overview":"Done"}\n``` trailing prose',
  '```json\n{"overview":"Done"}\n```\n```json\n{}\n```',
  '```json\n{"overview":"Done"}',
  '{"overview":',
  '{"overview":"Done"} {"overview":"Other"}',
  '```json\n{"overview":"Done"} {"overview":"Other"}\n```',
  "{}",
  '{"overview":4}',
  '{"overview":"Done","extra":true}'
])("rejects malformed/schema-invalid output in one attempt: %s", async (rawText) => {
  const f = fixture(rawText);
  const run = await prepareStructuredGeneration(
    f.scoped,
    { ...request, replySchema: {} } as GenerateStructuredInput & typeof request,
    f.deps
  );
  f.close();
  expect(await run()).toEqual({
    ok: false,
    error: "validation_failed",
    reason:
      rawText.startsWith("{") &&
      ["{}", '{"overview":4}', '{"overview":"Done","extra":true}'].includes(rawText)
        ? "schema_validation"
        : "json_parse"
  });
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it.each([
  " ".repeat(STRUCTURED_RESULT_MAX_BYTES) + '{"overview":"Done"}',
  JSON.stringify({ overview: "é".repeat(STRUCTURED_RESULT_MAX_BYTES / 2) })
])("bounds raw UTF-8 bytes before parsing or unfencing", async (rawText) => {
  const f = fixture(rawText);
  const run = await prepareStructuredGeneration(f.scoped, request, f.deps);
  f.close();
  const parse = vi.spyOn(JSON, "parse");
  expect(await run()).toEqual({
    ok: false,
    error: "validation_failed",
    reason: "oversized_output"
  });
  expect(parse.mock.calls.some(([value]) => value === rawText || value === rawText.trim())).toBe(
    false
  );
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it("fails closed when no CLI adapter is configured", async () => {
  const f = fixture();
  const run = await prepareStructuredGeneration(f.scoped, request, {
    ...f.deps,
    createCliStructuredAdapter: undefined
  });
  f.close();
  expect(await run()).toEqual({ ok: false, error: "needs_config" });
  expect(f.decryptJson).not.toHaveBeenCalled();
  expect(f.generate).not.toHaveBeenCalled();
});

it("does not dispatch an already-aborted call", async () => {
  const f = fixture();
  const run = await prepareStructuredGeneration(
    f.scoped,
    { ...request, signal: AbortSignal.abort() },
    f.deps
  );
  f.close();
  expect(await run()).toEqual({ ok: false, error: "aborted" });
  expect(f.generate).not.toHaveBeenCalled();
});

it("aborts an adapter that ignores the signal and consumes the closure immediately", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.generate.mockImplementation(() => new Promise(() => {}));
  const run = await prepareStructuredGeneration(
    f.scoped,
    { ...request, signal: controller.signal },
    f.deps
  );
  f.close();
  const pending = run();
  expect(await run()).toEqual({ ok: false, error: "provider_error", reason: "provider_failure" });
  controller.abort();
  expect(await pending).toEqual({ ok: false, error: "aborted" });
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it("reports provider errors without retry or reroute", async () => {
  const f = fixture();
  f.generate.mockRejectedValue(new Error("Synthetic provider failure"));
  const run = await prepareStructuredGeneration(f.scoped, request, f.deps);
  f.close();
  expect(await run()).toEqual({ ok: false, error: "provider_error", reason: "provider_failure" });
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.lookup).toHaveBeenCalledTimes(1);
});

it("checks input bounds before provider lookup and retains the prepared schema/model", async () => {
  const f = fixture();
  await expect(
    prepareStructuredGeneration(
      f.scoped,
      { ...request, prompt: "x".repeat(STRUCTURED_PROMPT_MAX_BYTES + 1) },
      f.deps
    )
  ).rejects.toThrow("structured prompt exceeds");
  await expect(
    prepareStructuredGeneration(
      f.scoped,
      { ...request, schema: { type: "object", $ref: "invalid" } },
      f.deps
    )
  ).rejects.toThrow("not allowed");
  expect(f.lookup).not.toHaveBeenCalled();
  const input = structuredClone(request);
  const run = await prepareStructuredGeneration(f.scoped, input, f.deps);
  input.explicitModel.provider_model_id = "changed";
  input.schema.properties.overview.type = "number";
  f.close();
  expect(await run()).toMatchObject({ ok: true });
  expect(f.generate.mock.calls[0]![0].model.provider_model_id).toBe("selected-model");
  expect(f.generate.mock.calls[0]![0].schema).toEqual(request.schema);
});

it.each([
  [new ConstrainedProcessError("timeout"), "timeout"],
  [new ConstrainedProcessError("output_limit"), "oversized_output"],
  [new DOMException("Private diagnostic", "TimeoutError"), "timeout"],
  [
    Object.assign(new Error(CLI_STRUCTURED_TIMEOUT_MESSAGE), {
      name: "CliChatUnavailableError"
    }),
    "timeout"
  ],
  [new Error("Private prompt or provider output"), "provider_failure"],
  [new SyntaxError("Private malformed response"), "json_parse"]
])("returns only a fixed reason for transport failure %s", async (error, reason) => {
  const f = fixture();
  f.generate.mockRejectedValue(error);
  const run = await prepareStructuredGeneration(f.scoped, request, f.deps);
  f.close();
  expect(await run()).toEqual({ ok: false, error: "provider_error", reason });
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it("distinguishes a caller deadline from ordinary cancellation even if the adapter ignores it", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.generate.mockImplementation(() => new Promise(() => {}));
  const run = await prepareStructuredGeneration(
    f.scoped,
    { ...request, signal: controller.signal },
    f.deps
  );
  f.close();
  const pending = run();
  controller.abort(new DOMException("Private deadline detail", "TimeoutError"));
  expect(await pending).toEqual({ ok: false, error: "aborted", reason: "timeout" });
});

it("bounds parsed provider objects with a fixed reason", async () => {
  const f = fixture();
  f.generate.mockResolvedValue({
    rawObject: { overview: "x".repeat(STRUCTURED_RESULT_MAX_BYTES) },
    usage
  });
  const run = await prepareStructuredGeneration(f.scoped, request, f.deps);
  f.close();
  expect(await run()).toEqual({
    ok: false,
    error: "validation_failed",
    reason: "oversized_output"
  });
});

it.each([
  ['```json\n{"overview":"Done"}\n```', true],
  ['```json\n{"overview":"Done"} {"overview":"Other"}\n```', false],
  ['```json\n{"overview":"Done"}\n```\n```json\n{}\n```', false],
  ['```json\n{"overview":\n```', false]
])(
  "validates the entire reply through the actual constrained CLI wrapper: %s",
  async (rawText, ok) => {
    const f = fixture();
    const kill = vi.fn(async () => undefined);
    const factory = vi.fn(async () => ({
      launchStructured: async () => ({ offset: 0 }),
      submitStructured: async () => undefined,
      readStructured: async () => ({ text: rawText, offset: 1, complete: true }),
      kill
    })) as unknown as ChatEngineFactory;
    const run = await prepareStructuredGeneration(f.scoped, request, {
      ...f.deps,
      repository: {
        selectProviderWithCredential: async () =>
          ({ auth_method: "cli", acp_agent_id: "claude-acp" }) as AiProviderWithSealedCredential
      },
      createCliStructuredAdapter: createConstrainedCliStructuredAdapterFactory(factory)
    });
    f.close();
    expect(await run()).toMatchObject(
      ok
        ? { ok: true, object: { overview: "Done" } }
        : { ok: false, error: "validation_failed", reason: "json_parse" }
    );
    expect(kill).toHaveBeenCalledTimes(1);
  }
);
