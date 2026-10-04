import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataContextDb } from "@moss/db";
import {
  prepareTextApiGeneration,
  type AiProviderWithSealedCredential,
  type GenerateTextInput
} from "@moss/ai";

const db = {} as DataContextDb;
const input: GenerateTextInput = {
  model: {
    id: "chosen-model",
    provider_config_id: "chosen-provider",
    provider_kind: "openai-compatible",
    provider_model_id: "exact-model"
  },
  messages: [{ role: "user", content: "Synthetic meeting evidence." }],
  maxOutputTokens: 512
};
const provider = {
  id: "chosen-provider",
  provider_kind: "openai-compatible",
  base_url: "https://fixture.invalid",
  auth_method: "api_key",
  encrypted_credential: { synthetic: true }
} as unknown as AiProviderWithSealedCredential;
const response = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "Answer" } }] }));
function setup() {
  const lookup = vi.fn(async () => provider);
  const decrypt = vi.fn(() => ({ apiKey: "synthetic-not-real-key" }));
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  vi.stubGlobal("fetch", fetch);
  return {
    lookup,
    decrypt,
    fetch,
    deps: { repository: { selectProviderWithCredential: lookup }, cipher: { decryptJson: decrypt } }
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prepared tool-free API text generation", () => {
  it("prepares in a short actor context and makes only one attempt after that context closes", async () => {
    const h = setup();
    let active = true;
    h.lookup.mockImplementation(async () => {
      expect(active).toBe(true);
      return provider;
    });
    h.fetch.mockImplementation(async () => {
      expect(active).toBe(false);
      return response();
    });
    const run = await prepareTextApiGeneration(db, input, h.deps);
    expect(h.lookup).toHaveBeenCalledExactlyOnceWith(db, "chosen-provider");
    expect(h.decrypt).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
    active = false;
    expect(await Promise.all([run(), run()])).toEqual([
      { ok: true, text: "Answer" },
      { ok: false, error: "provider_error" }
    ]);
    expect(await run()).toEqual({ ok: false, error: "provider_error" });
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = h.fetch.mock.calls[0]!;
    expect(url).toBe("https://fixture.invalid/v1/chat/completions");
    expect(JSON.parse(String(options!.body))).toEqual({
      model: "exact-model",
      max_tokens: 512,
      messages: input.messages
    });
  });

  it("cannot use a CLI transport or search even when callers pass extra runtime properties", async () => {
    const h = setup();
    const cli = vi.fn();
    const adapter = vi.fn();
    const expandedDeps = { ...h.deps, createCliStructuredAdapter: cli, createAdapter: adapter };
    const expandedInput = { ...input, nativeSearch: true };
    h.lookup.mockResolvedValue({ ...provider, auth_method: "cli" });
    const run = await prepareTextApiGeneration(db, expandedInput, expandedDeps);
    expect(await run()).toEqual({ ok: false, error: "needs_config" });
    expect(cli).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
    expect(h.decrypt).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    h.lookup.mockResolvedValue(provider);
    const api = await prepareTextApiGeneration(db, expandedInput, expandedDeps);
    expect(await api()).toEqual({ ok: true, text: "Answer" });
    expect(adapter).not.toHaveBeenCalled();
    expect(JSON.parse(String(h.fetch.mock.calls[0]![1]!.body))).not.toHaveProperty("tools");
  });

  it("does not contact the provider if cancelled after preparation", async () => {
    const h = setup();
    const controller = new AbortController();
    const run = await prepareTextApiGeneration(db, { ...input, signal: controller.signal }, h.deps);
    controller.abort();
    expect(await run()).toEqual({ ok: false, error: "aborted" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("settles cancellation without waiting for an HTTP implementation that ignores the signal", async () => {
    const h = setup();
    const controller = new AbortController();
    h.fetch.mockImplementation(async (_url, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      return new Promise(() => undefined);
    });
    const run = await prepareTextApiGeneration(db, { ...input, signal: controller.signal }, h.deps);
    expect(await run()).toEqual({ ok: false, error: "aborted" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry provider failures or expose their response content", async () => {
    const h = setup();
    h.fetch.mockRejectedValue(new Error("private provider response"));
    const run = await prepareTextApiGeneration(db, input, h.deps);
    expect(await run()).toEqual({ ok: false, error: "provider_error" });
    expect(await run()).toEqual({ ok: false, error: "provider_error" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
