import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import {
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
const mainModel = {
  id: "main-model",
  provider_config_id: "main-provider",
  provider_kind: "anthropic",
  provider_model_id: "main-x"
} as never;
const sortingModel = {
  id: "sorting-model",
  provider_config_id: "sorting-provider",
  provider_kind: "openai-compatible",
  provider_model_id: "small-x"
} as never;

const ok = (a: string) => ({ rawObject: { a }, usage: { inputTokens: 1, outputTokens: 1 } });

function adapters(sorting: StructuredProviderAdapter, main: StructuredProviderAdapter) {
  return (_kind: string, _key: string, baseUrl: string | null) =>
    baseUrl === "sorting" ? sorting : main;
}

function makeDeps(options: {
  sorting: StructuredProviderAdapter;
  main: StructuredProviderAdapter;
  resolveSortingModel?: ReturnType<typeof vi.fn> | null;
  mainResolves?: unknown;
  logger?: GenerateStructuredDeps["logger"];
}): GenerateStructuredDeps {
  const resolveSortingModel =
    options.resolveSortingModel === null
      ? undefined
      : (options.resolveSortingModel ?? vi.fn(async () => sortingModel));
  return {
    repository: {
      resolveModelForService: vi.fn(async () => ({
        model: (options.mainResolves ?? mainModel) as never,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(async (_db, providerId: string) => ({
        id: providerId,
        auth_method: "api_key",
        base_url: providerId === "sorting-provider" ? "sorting" : "main",
        encrypted_credential: {}
      })) as never,
      ...(resolveSortingModel ? { resolveSortingModel } : {})
    } as GenerateStructuredDeps["repository"],
    cipher: { decryptJson: vi.fn(() => ({ apiKey: "sk-test" })) },
    logger: options.logger,
    createAdapter: adapters(options.sorting, options.main)
  };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  service: "module.news" as const,
  schema,
  prompt: "sort",
  sorting: true as const,
  ...overrides
});

describe("generateStructured sorting path", () => {
  it("serves from the sorting model when it answers", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(scopedDb, input(), makeDeps({ sorting, main }));
    expect(result).toMatchObject({ ok: true, object: { a: "small" }, servedBy: "sorting" });
    expect(main.generateStructured).not.toHaveBeenCalled();
  });

  it("returns aborted and calls nothing when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const deps = makeDeps({ sorting, main });
    const result = await generateStructured(scopedDb, input({ signal: controller.signal }), deps);
    expect(result).toEqual({ ok: false, error: "aborted" });
    expect(deps.repository.resolveSortingModel).not.toHaveBeenCalled();
    expect(sorting.generateStructured).not.toHaveBeenCalled();
  });

  it("an explicit caller model sends no request to the sorting provider", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const deps = makeDeps({ sorting, main });
    const result = await generateStructured(
      scopedDb,
      input({ explicitModel: mainModel }),
      deps
    );
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
    expect(deps.repository.resolveSortingModel).not.toHaveBeenCalled();
    expect(sorting.generateStructured).not.toHaveBeenCalled();
  });

  it("resolveSortingModel returning null sends no request to the sorting provider", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(
      scopedDb,
      input(),
      makeDeps({ sorting, main, resolveSortingModel: vi.fn(async () => null) })
    );
    expect(result).toMatchObject({ ok: true, object: { a: "main" }, servedBy: "main" });
    expect(sorting.generateStructured).not.toHaveBeenCalled();
  });

  it("without sorting set, never asks for the sorting model", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const deps = makeDeps({ sorting, main });
    const result = await generateStructured(scopedDb, input({ sorting: undefined }), deps);
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
    expect(deps.repository.resolveSortingModel).not.toHaveBeenCalled();
  });

  it("a repository without resolveSortingModel runs today's path", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(
      scopedDb,
      input(),
      makeDeps({ sorting, main, resolveSortingModel: null })
    );
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
  });

  it("falls back once on a provider error", async () => {
    const sorting = {
      generateStructured: vi.fn(async () => {
        throw new Error("AI provider request failed: HTTP 500");
      })
    };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const info = vi.fn();
    const result = await generateStructured(
      scopedDb,
      input(),
      makeDeps({ sorting, main, logger: { info, warn: vi.fn() } })
    );
    expect(result).toMatchObject({ ok: true, object: { a: "main" }, servedBy: "main" });
    expect(sorting.generateStructured).toHaveBeenCalledTimes(1);
    expect(main.generateStructured).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { service: "module.news", servedBy: "main", sortingFailure: "provider_error" },
      "ai.structured sorting fallback"
    );
  });

  it("validation failure on the one sorting try falls back without a repair turn", async () => {
    const sorting = {
      generateStructured: vi.fn(async () => ({
        rawObject: { wrong: 1 },
        usage: { inputTokens: 1, outputTokens: 1 }
      }))
    };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(scopedDb, input(), makeDeps({ sorting, main }));
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
    expect(sorting.generateStructured).toHaveBeenCalledTimes(1);
  });

  it("falls back when the sorting provider has no usable credential", async () => {
    const sorting = { generateStructured: vi.fn(async () => ok("small")) };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const deps = makeDeps({ sorting, main });
    let calls = 0;
    const decryptJson = vi.fn(() => {
      calls += 1;
      return calls === 1 ? {} : { apiKey: "sk-test" };
    });
    const result = await generateStructured(scopedDb, input(), { ...deps, cipher: { decryptJson } });
    expect(result).toMatchObject({ ok: true, servedBy: "main" });
    expect(sorting.generateStructured).not.toHaveBeenCalled();
  });

  it("returns the original failure when today's path resolves to the same model", async () => {
    const sorting = {
      generateStructured: vi.fn(async () => {
        throw new Error("AI provider request failed: HTTP 503");
      })
    };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(
      scopedDb,
      input(),
      makeDeps({ sorting, main, mainResolves: sortingModel })
    );
    expect(result).toEqual({ ok: false, error: "provider_error" });
    expect(sorting.generateStructured).toHaveBeenCalledTimes(1);
    expect(main.generateStructured).not.toHaveBeenCalled();
  });

  it("does not fall back when the caller aborts during the sorting attempt", async () => {
    const controller = new AbortController();
    const sorting = {
      generateStructured: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              controller.abort();
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, 5);
          })
      )
    };
    const main = { generateStructured: vi.fn(async () => ok("main")) };
    const result = await generateStructured(
      scopedDb,
      input({ signal: controller.signal }),
      makeDeps({ sorting, main })
    );
    expect(result).toEqual({ ok: false, error: "aborted" });
    expect(main.generateStructured).not.toHaveBeenCalled();
  });

  it("a caller abort stops a hanging fallback", async () => {
    const controller = new AbortController();
    const sorting = {
      generateStructured: vi.fn(async () => {
        throw new Error("AI provider request failed: HTTP 500");
      })
    };
    const main = {
      generateStructured: vi.fn(() => {
        setTimeout(() => controller.abort(), 20);
        return new Promise<never>(() => undefined);
      })
    };
    const result = await generateStructured(
      scopedDb,
      input({ signal: controller.signal }),
      makeDeps({ sorting, main })
    );
    expect(result).toEqual({ ok: false, error: "aborted" });
  });
});
