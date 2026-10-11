import { afterEach, expect, it, vi } from "vitest";
import type { DataContextDb } from "@moss/db";
import {
  createAiSecretCipher,
  generateStructured,
  prepareStructuredApiGeneration,
  prepareStructuredGeneration,
  type AiProviderWithSealedCredential
} from "@moss/ai";
import { HttpApiAdapter } from "../../packages/ai/src/adapters/http-api.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const cipher = createAiSecretCipher();
const provider = {
  auth_method: "api_key",
  base_url: "https://synthetic.invalid",
  encrypted_credential: cipher.encryptJson({ apiKey: "synthetic-key-only" })
} as AiProviderWithSealedCredential;
const request = {
  service: "module.meetings.summary" as const,
  explicitModel: {
    id: "model",
    provider_config_id: "provider",
    provider_kind: "openai-compatible",
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("prepares without dispatch, then runs once outside the closed DataContext with no further DB use", async () => {
  let open = true;
  const db = {} as DataContextDb;
  const lookup = vi.fn(async (scoped: DataContextDb, id: string) => {
    expect(open).toBe(true);
    expect(scoped).toBe(db);
    expect(id).toBe("provider");
    return provider;
  });
  const fetch = vi.fn(async () => {
    expect(open).toBe(false);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"overview":"Done"}' } }] })
    );
  });
  vi.stubGlobal("fetch", fetch);
  const run = await prepareStructuredGeneration(db, request, {
    cipher,
    repository: { selectProviderWithCredential: lookup }
  });
  expect(typeof run).toBe("function");
  expect(fetch).not.toHaveBeenCalled();
  open = false;
  expect(await run()).toMatchObject({ ok: true, object: { overview: "Done" }, servedBy: "main" });
  expect(await run()).toEqual({ ok: false, error: "provider_error", reason: "provider_failure" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledTimes(1);
});

it("rejects CLI credentials without a provider call", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const run = await prepareStructuredApiGeneration({} as DataContextDb, request, {
    cipher,
    repository: {
      selectProviderWithCredential: async () => ({ ...provider, auth_method: "cli" })
    }
  });
  expect(await run()).toEqual({ ok: false, error: "needs_config" });
  expect(fetch).not.toHaveBeenCalled();
});

it("captures the prepared API activity owner from the actor context without reusing it after preparation", async () => {
  const owner = "12345678-1234-4234-9234-123456789abc";
  const { scoped, queries } = makeRecordingDb({ rows: [{ actor: owner }] });
  const generate = vi.spyOn(HttpApiAdapter.prototype, "generateStructured");
  const fetch = vi.fn(async () => {
    expect(queries).toHaveLength(1);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"overview":"Done"}' } }] })
    );
  });
  vi.stubGlobal("fetch", fetch);
  const untrustedExtraOptions = { ...request, actorUserId: "another-owner" };
  const run = await prepareStructuredGeneration(scoped, untrustedExtraOptions, {
    cipher,
    repository: { selectProviderWithCredential: async () => provider }
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]?.sql).toContain("current_setting('app.actor_user_id'");
  expect(generate).not.toHaveBeenCalled();
  expect(await run()).toMatchObject({ ok: true });
  expect(await run()).toEqual({ ok: false, error: "provider_error", reason: "provider_failure" });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0]?.[0]).toMatchObject({ actorUserId: owner });
  expect(queries).toHaveLength(1);
  expect(
    String((fetch.mock.calls as unknown as [string, RequestInit][])[0]?.[1].body)
  ).not.toContain(owner);
});

it("does not carry extra search, sorting, CLI or retry options into the prepared run", async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }))
  );
  vi.stubGlobal("fetch", fetch);
  const untrustedExtraOptions = {
    ...request,
    nativeSearch: true,
    sorting: true,
    singleAttempt: false,
    replySchema: {}
  };
  const run = await prepareStructuredGeneration({} as DataContextDb, untrustedExtraOptions, {
    cipher,
    repository: {
      selectProviderWithCredential: async () => provider
    }
  });
  expect(await run()).toEqual({
    ok: false,
    error: "validation_failed",
    reason: "schema_validation"
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(url).toBe("https://synthetic.invalid/v1/chat/completions");
  expect(JSON.parse(String(options.body))).not.toHaveProperty("tools");
});

it("preserves the general structured reply-schema override while sending the original provider schema", async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }))
  );
  vi.stubGlobal("fetch", fetch);
  const result = await generateStructured(
    {} as DataContextDb,
    { ...request, replySchema: { type: "object" }, singleAttempt: true },
    {
      cipher,
      repository: {
        selectProviderWithCredential: async () => provider,
        resolveModelForService: async () => {
          throw new Error("The explicit model must not be rerouted");
        }
      }
    }
  );
  expect(result).toMatchObject({ ok: true, object: {} });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [, options] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(JSON.parse(String(options.body)).response_format.json_schema.schema).toEqual(
    request.schema
  );
});

it.each(["schema", "provider", "timeout"] as const)(
  "preserves API-only compatibility failure shapes for %s failures and repeated calls",
  async (failure) => {
    vi.spyOn(HttpApiAdapter.prototype, "generateStructured").mockImplementation(async () => {
      if (failure === "provider") throw new Error("Synthetic provider diagnostic");
      if (failure === "timeout") throw new DOMException("Synthetic deadline", "TimeoutError");
      return { rawObject: {}, usage: { inputTokens: 0, outputTokens: 0 } };
    });
    const run = await prepareStructuredApiGeneration({} as DataContextDb, request, {
      cipher,
      repository: { selectProviderWithCredential: async () => provider }
    });
    expect(await run()).toEqual({
      ok: false,
      error: failure === "schema" ? "validation_failed" : "provider_error"
    });
    expect(await run()).toEqual({ ok: false, error: "provider_error" });
  }
);
