import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CHAT_MODELS, ModelDiscoveryService, type CliModelLister } from "@moss/ai";

// #2208: CLI providers no longer ship a typed-in model list. Discovery asks the cli-runner (the
// injected lister) for the vendor's live ids and infers tiers from the id text; anything other
// than an `ok` answer yields no models plus a `reason` the routes surface.
describe("CLI model discovery (#2208)", () => {
  const cliInput = (providerKind: "anthropic" | "openai-compatible" | "google") => ({
    providerKind,
    authMethod: "cli" as const,
    baseUrl: null,
    credential: { cli: true }
  });

  it("maps the runner's ids through the tier heuristics and caches the answer for an hour", async () => {
    const lister = vi.fn<CliModelLister>().mockResolvedValue({
      status: "ok",
      models: [
        { id: "claude-fable-5-1" },
        { id: "claude-opus-4-8" },
        { id: "claude-sonnet-4-6" },
        { id: "claude-haiku-4-5-20251001" }
      ]
    });
    const service = new ModelDiscoveryService({ cliModelLister: lister });

    const first = await service.discoverModels("claude", cliInput("anthropic"));
    expect(first.fromFallback).toBe(false);
    expect(first.fromCache).toBe(false);
    expect(first.reason).toBeUndefined();
    expect(typeof first.cacheExpiresAt).toBe("number");
    expect(
      Object.fromEntries(first.models.map((model) => [model.providerModelId, model.tier]))
    ).toEqual({
      "claude-fable-5-1": "reasoning",
      "claude-opus-4-8": "reasoning",
      "claude-sonnet-4-6": "interactive",
      "claude-haiku-4-5-20251001": "economy"
    });

    const second = await service.discoverModels("claude", cliInput("anthropic"));
    expect(second.fromCache).toBe(true);
    expect(second.models).toEqual(first.models);
    expect(lister).toHaveBeenCalledTimes(1);
    expect(lister).toHaveBeenCalledWith("anthropic");
  });

  it("infers Codex service tiers from the published suffixes", async () => {
    const service = new ModelDiscoveryService({
      cliModelLister: async () => ({
        status: "ok",
        models: [
          { id: "gpt-5.6-sol" },
          { id: "gpt-5.6-terra" },
          { id: "gpt-5.6-luna" },
          { id: "gpt-5.6" }
        ]
      })
    });
    const result = await service.discoverModels("codex", cliInput("openai-compatible"));
    expect(
      Object.fromEntries(result.models.map((model) => [model.providerModelId, model.tier]))
    ).toEqual({
      "gpt-5.6-sol": "reasoning",
      "gpt-5.6-terra": "interactive",
      "gpt-5.6-luna": "economy",
      "gpt-5.6": "interactive"
    });
  });

  it.each([
    ["not_logged_in", "Log in first"],
    ["unsupported", "this provider cannot list its models yet"],
    ["error", "model list request failed with HTTP 500"]
  ] as const)("returns no models with reason %s and never caches it", async (status, message) => {
    const lister = vi.fn<CliModelLister>().mockResolvedValue({ status, message });
    const service = new ModelDiscoveryService({ cliModelLister: lister });

    const result = await service.discoverModels("gemini", cliInput("google"));
    expect(result).toEqual({
      models: [],
      fromCache: false,
      fromFallback: false,
      cacheExpiresAt: null,
      reason: status,
      message
    });
    await service.discoverModels("gemini", cliInput("google"));
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable when no lister is wired (host-dev / in-process path)", async () => {
    const result = await new ModelDiscoveryService().discoverModels(
      "claude",
      cliInput("anthropic")
    );
    expect(result.models).toEqual([]);
    expect(result.reason).toBe("unavailable");
    expect(result.fromFallback).toBe(false);
  });

  it("keeps each model's release date from an API-key provider's list", async () => {
    const service = new ModelDiscoveryService();
    const anthropic = await service.discoverModels("anthropic-api", {
      providerKind: "anthropic",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-test" },
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "claude-sonnet-5", created_at: "2026-05-01T00:00:00Z" },
              { id: "claude-sonnet-4-5-20250929", created_at: "2025-09-29T00:00:00Z" },
              { id: "claude-sonnet-4-6" }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )) as typeof globalThis.fetch
    });
    expect(anthropic.models.map((model) => [model.providerModelId, model.releasedAt])).toEqual([
      ["claude-sonnet-5", "2026-05-01T00:00:00.000Z"],
      ["claude-sonnet-4-5-20250929", "2025-09-29T00:00:00.000Z"],
      ["claude-sonnet-4-6", null]
    ]);

    const openai = await service.discoverModels("openai-api", {
      providerKind: "openai-compatible",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-test" },
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-5.6", created: 1_780_000_000 }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })) as typeof globalThis.fetch
    });
    expect(openai.models[0]?.releasedAt).toBe(new Date(1_780_000_000 * 1000).toISOString());
  });

  it("never invents models for an API-key provider whose discovery fails", async () => {
    const service = new ModelDiscoveryService();
    const result = await service.discoverModels("api", {
      providerKind: "anthropic",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-test" },
      fetch: (async () => {
        throw new Error("network disabled");
      }) as typeof globalThis.fetch
    });
    expect(result.models).toEqual([]);
    expect(result.fromFallback).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("registers a Gemini default model that rides the account's own model", () => {
    expect(DEFAULT_CHAT_MODELS.google).toMatchObject({
      providerModelId: "default",
      tier: "interactive",
      capabilities: ["chat"]
    });
  });
});
