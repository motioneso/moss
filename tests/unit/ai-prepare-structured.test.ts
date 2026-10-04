import { afterEach, expect, it, vi } from "vitest";
import type { DataContextDb } from "@moss/db";
import {
  createAiSecretCipher,
  prepareStructuredApiGeneration,
  type AiProviderWithSealedCredential
} from "@moss/ai";

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
  const run = await prepareStructuredApiGeneration(db, request, {
    cipher,
    repository: { selectProviderWithCredential: lookup }
  });
  expect(typeof run).toBe("function");
  expect(fetch).not.toHaveBeenCalled();
  open = false;
  expect(await run()).toMatchObject({ ok: true, object: { overview: "Done" }, servedBy: "main" });
  expect(await run()).toEqual({ ok: false, error: "provider_error" });
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

it("does not carry extra search, sorting, CLI or retry options into the prepared run", async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }))
  );
  vi.stubGlobal("fetch", fetch);
  const untrustedExtraOptions = {
    ...request,
    nativeSearch: true,
    sorting: true,
    singleAttempt: false
  };
  const run = await prepareStructuredApiGeneration({} as DataContextDb, untrustedExtraOptions, {
    cipher,
    repository: {
      selectProviderWithCredential: async () => provider
    }
  });
  expect(await run()).toEqual({ ok: false, error: "validation_failed" });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(url).toBe("https://synthetic.invalid/v1/chat/completions");
  expect(JSON.parse(String(options.body))).not.toHaveProperty("tools");
});
