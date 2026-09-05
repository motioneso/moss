import { describe, expect, it, vi } from "vitest";
import type { DataContextDb } from "@moss/db";
import type {
  AiConfiguredModelSafeRow,
  AiProviderWithSealedCredential,
  GenerateStructuredDeps,
  GenerateStructuredProviderInput
} from "@moss/ai";
import {
  createModuleBuildSourceGenerator,
  validateModuleBuildSource
} from "../../apps/worker/src/module-build-source.js";

const source = {
  files: [{ path: "src/worker/index.ts", content: "export const word = 'hello';" }]
};

function fixture(actor = "owner-a") {
  const db = {} as DataContextDb;
  const model = {
    id: `model-${actor}`,
    provider_config_id: `provider-${actor}`,
    owner_user_id: actor,
    provider_kind: "anthropic",
    provider_model_id: `concrete-${actor}`,
    tier: "reasoning"
  } as AiConfiguredModelSafeRow;
  const provider = {
    id: model.provider_config_id,
    owner_user_id: actor,
    provider_kind: model.provider_kind,
    status: "active",
    purpose: "assistant",
    auth_method: "api_key",
    encrypted_credential: {}
  } as AiProviderWithSealedCredential;
  const adapter = {
    generateStructured: vi.fn(async (_input: GenerateStructuredProviderInput) => ({
      rawObject: source,
      usage: { inputTokens: 1, outputTokens: 1 }
    }))
  };
  const deps = {
    repository: {
      resolveModelForService: vi.fn(async () => ({
        model,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(async () => provider)
    },
    cipher: { decryptJson: vi.fn(() => ({ apiKey: `synthetic-${actor}` })) },
    createAdapter: vi.fn(() => adapter),
    createCliStructuredAdapter: vi.fn(() => adapter)
  } satisfies GenerateStructuredDeps;
  return { db, deps, model, provider, adapter };
}

describe("Workshop source dispatch", () => {
  it.each(["owner-a", "owner-b"])(
    "keeps %s routing, prompt and concrete model together",
    async (actor) => {
      const { db, deps, adapter } = fixture(actor);
      const signal = new AbortController().signal;
      const generate = createModuleBuildSourceGenerator(db, actor, deps);
      await expect(
        generate({ step: "writing_code", plan: { description: actor }, signal })
      ).resolves.toEqual(source);
      expect(deps.repository.resolveModelForService).toHaveBeenCalledWith(db, "module.workshop", {
        capability: "json",
        tierHint: "interactive",
        requireExplicitBinding: undefined
      });
      expect(deps.repository.selectProviderWithCredential).toHaveBeenCalledWith(
        db,
        `provider-${actor}`
      );
      expect(deps.createAdapter).toHaveBeenCalledWith("anthropic", `synthetic-${actor}`, null);
      expect(adapter.generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { provider_kind: "anthropic", provider_model_id: `concrete-${actor}` },
          sourceGeneration: true,
          signal: expect.any(AbortSignal)
        })
      );
      const prompt = adapter.generateStructured.mock.calls[0]?.[0].messages[0]?.content;
      expect(prompt).toContain(actor);
      expect(prompt).not.toContain(`synthetic-${actor}`);
      expect(deps.createCliStructuredAdapter).not.toHaveBeenCalled();
    }
  );

  it("requests reasoning for specification through the installed Workshop service", async () => {
    const { db, deps } = fixture();
    await createModuleBuildSourceGenerator(db, "owner-a", deps)({ step: "writing_spec", plan: {} });
    expect(deps.repository.resolveModelForService).toHaveBeenCalledWith(
      db,
      "module.workshop.plan",
      expect.objectContaining({ tierHint: "reasoning" })
    );
  });

  it("cannot use the provider-global CLI credential even when an adapter is supplied", async () => {
    const { db, deps, provider } = fixture();
    deps.repository.selectProviderWithCredential.mockResolvedValue({
      ...provider,
      auth_method: "cli"
    });
    await expect(
      createModuleBuildSourceGenerator(db, "owner-a", deps)({ step: "writing_code", plan: {} })
    ).rejects.toThrow("owner-bound connection");
    expect(deps.cipher.decryptJson).not.toHaveBeenCalled();
    expect(deps.createCliStructuredAdapter).not.toHaveBeenCalled();
    expect(deps.createAdapter).not.toHaveBeenCalled();
  });

  it("does not override a selected non-reasoning model for specification work", async () => {
    const { db, deps, model } = fixture();
    deps.repository.resolveModelForService.mockResolvedValue({
      model: { ...model, tier: "interactive" },
      reason: "matched-active-model"
    });
    await expect(
      createModuleBuildSourceGenerator(db, "owner-a", deps)({ step: "writing_spec", plan: {} })
    ).rejects.toThrow("owner-bound connection");
    expect(deps.repository.resolveModelForService).toHaveBeenCalledOnce();
    expect(deps.repository.selectProviderWithCredential).not.toHaveBeenCalled();
  });

  it("discards a provider result arriving after the source deadline", async () => {
    const { db, deps, adapter } = fixture();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      adapter.generateStructured.mockImplementation(async (input) => {
        deadline.abort(new DOMException("source deadline", "TimeoutError"));
        expect(input.signal?.aborted).toBe(true);
        return { rawObject: source, usage: { inputTokens: 1, outputTokens: 1 } };
      });
      await expect(
        createModuleBuildSourceGenerator(db, "owner-a", deps)({ step: "writing_code", plan: {} })
      ).rejects.toThrow("source deadline");
      expect(timeout).toHaveBeenCalledWith(120_000);
      expect(adapter.generateStructured).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects an invalid returned path before passing source to the host", async () => {
    const { db, deps, adapter } = fixture();
    adapter.generateStructured.mockResolvedValue({
      rawObject: { files: [{ path: "../escape.ts", content: "export {};" }] },
      usage: { inputTokens: 1, outputTokens: 1 }
    });
    await expect(
      createModuleBuildSourceGenerator(db, "owner-a", deps)({ step: "writing_code", plan: {} })
    ).rejects.toThrow("invalid source");
  });

  it("rejects an actor mismatch before credential access", async () => {
    const { db, deps } = fixture("owner-b");
    await expect(
      createModuleBuildSourceGenerator(db, "owner-a", deps)({ step: "writing_code", plan: {} })
    ).rejects.toThrow("owner-bound connection");
    expect(deps.repository.selectProviderWithCredential).not.toHaveBeenCalled();
  });

  it.each([
    { owner_user_id: "owner-b" },
    { id: "wrong-config" },
    { status: "revoked" },
    { purpose: "voice" },
    { provider_kind: "google" }
  ] as const)("rejects an ineligible selected credential: %j", async (change) => {
    const { db, deps, provider } = fixture();
    deps.repository.selectProviderWithCredential.mockResolvedValue({ ...provider, ...change });
    await expect(
      createModuleBuildSourceGenerator(db, "owner-a", deps)({ step: "writing_code", plan: {} })
    ).rejects.toThrow("owner-bound connection");
    expect(deps.cipher.decryptJson).not.toHaveBeenCalled();
    expect(deps.createAdapter).not.toHaveBeenCalled();
  });

  it("rejects a late result and forwards cancellation to the adapter", async () => {
    const { db, deps, adapter } = fixture();
    const abort = new AbortController();
    adapter.generateStructured.mockImplementation(async (input) => {
      expect(input.signal?.aborted).toBe(false);
      abort.abort();
      expect(input.signal?.aborted).toBe(true);
      return { rawObject: source, usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await expect(
      createModuleBuildSourceGenerator(
        db,
        "owner-a",
        deps
      )({ step: "writing_code", plan: {}, signal: abort.signal })
    ).rejects.toThrow();
    expect(adapter.generateStructured).toHaveBeenCalledOnce();
  });
});

describe("Workshop source boundary", () => {
  it("returns a fresh plain source object without interpreting its code", () => {
    expect(validateModuleBuildSource(source)).toEqual(source);
    expect(validateModuleBuildSource(source)).not.toBe(source);
  });

  it.each([
    "../escape.ts",
    "/tmp/escape.ts",
    "src/web/../escape.ts",
    "src/web/./index.ts",
    "src\\web\\index.ts",
    "src/web//index.ts",
    "src/web/%2e%2e/escape.ts",
    ".claude/settings.json",
    "package.json",
    "tsconfig.json",
    "dist/worker.js"
  ])("rejects unsafe or host-owned path %s", (path) => {
    expect(() => validateModuleBuildSource({ files: [{ path, content: "x" }] })).toThrow(
      "invalid source"
    );
  });

  it("rejects duplicate paths, link metadata, excess fields, binary content and byte/count overflow", () => {
    for (const value of [
      { files: new Array(1) },
      { files: [source.files[0], source.files[0]] },
      { files: [source.files[0], { ...source.files[0], path: "src/worker/INDEX.ts" }] },
      { files: [{ ...source.files[0], target: "/secret" }] },
      { ...source, testsPassing: true },
      { files: [{ path: "SPEC.md", content: "\0" }] },
      { files: [{ path: "SPEC.md", content: "é".repeat(17000) }] },
      { files: Array.from({ length: 33 }, (_, i) => ({ path: `tests/t${i}.ts`, content: "x" })) },
      {
        files: Array.from({ length: 3 }, (_, i) => ({
          path: `tests/t${i}.ts`,
          content: "x".repeat(32768)
        }))
      }
    ])
      expect(() => validateModuleBuildSource(value)).toThrow("invalid source");
  });
});
