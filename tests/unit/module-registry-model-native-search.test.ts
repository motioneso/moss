import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";

import { buildModelNativeSearchResolver } from "../../packages/module-registry/src/index.js";

const scopedDb = { [dataContextBrand]: true } as unknown as DataContextDb;

const searchingModel = {
  id: "model-1",
  provider_config_id: "provider-1",
  provider_kind: "anthropic",
  provider_model_id: "claude-sonnet-4-20250514",
  capabilities: ["chat", "web-search"]
};

function buildResolver(overrides: {
  model?: typeof searchingModel | null;
  engine?: "brave" | "model-native" | "none";
  generate?: ReturnType<typeof vi.fn>;
}) {
  const generate =
    overrides.generate ??
    vi.fn(async () => ({
      ok: true,
      object: { results: [] },
      usage: { inputTokens: 0, outputTokens: 0 }
    }));
  const model = overrides.model === undefined ? searchingModel : overrides.model;
  const resolver = buildModelNativeSearchResolver({
    repository: {
      selectChatModelForUser: vi.fn(async () => model),
      resolveModelForService: vi.fn(async () => ({ model: null })),
      selectProviderWithCredential: vi.fn(async () => null)
    } as never,
    cipher: { decryptJson: () => ({}) },
    resolveEngine: vi.fn(async () =>
      overrides.engine === "model-native" || overrides.engine === undefined
        ? { engine: "model-native" as const, model: { id: "model-1", capabilities: [] } }
        : overrides.engine === "brave"
          ? { engine: "brave" as const }
          : { engine: "none" as const, reason: "native-disabled" as const }
    ),
    generate: generate as never
  });
  return { resolver, generate };
}

describe("buildModelNativeSearchResolver (#2228)", () => {
  it("runs the structured search against the actor's own chat model with built-in search on", async () => {
    const { resolver, generate } = buildResolver({});

    const resolution = await resolver(scopedDb);
    expect(resolution?.modelId).toBe("model-1");
    const out = await resolution!.runner({ prompt: "find things", schema: { type: "object" } });

    expect(out).toEqual({ object: { results: [] }, sources: undefined });
    expect(generate).toHaveBeenCalledTimes(1);
    const [db, input] = generate.mock.calls[0]!;
    expect(db).toBe(scopedDb);
    expect(input).toMatchObject({
      prompt: "find things",
      nativeSearch: true,
      explicitModel: {
        id: "model-1",
        provider_config_id: "provider-1",
        provider_kind: "anthropic",
        provider_model_id: "claude-sonnet-4-20250514"
      }
    });
  });

  it("returns null when the engine resolver does not pick model-native search", async () => {
    expect(await buildResolver({ engine: "brave" }).resolver(scopedDb)).toBeNull();
    expect(await buildResolver({ engine: "none" }).resolver(scopedDb)).toBeNull();
    expect(await buildResolver({ model: null }).resolver(scopedDb)).toBeNull();
  });

  it("reports the runner unavailable (null) when the structured request fails", async () => {
    const generate = vi.fn(async () => ({ ok: false, error: "provider_error" }));
    const { resolver } = buildResolver({ generate });

    const out = await (await resolver(scopedDb))!.runner({ prompt: "q", schema: {} });

    expect(out).toBeNull();
  });
});
