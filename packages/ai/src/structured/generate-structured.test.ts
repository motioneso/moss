import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";
import type { AiConfiguredModelSafeRow, AiProviderWithSealedCredential } from "../repository.js";
import type {
  GenerateStructuredProviderInput,
  StructuredProviderResult
} from "../adapters/http-api-structured.js";
import { generateStructured, type GenerateStructuredDeps } from "./generate-structured.js";

const fakeModel: AiConfiguredModelSafeRow = {
  id: "model-1",
  provider_config_id: "provider-1",
  owner_user_id: "user-1",
  provider_kind: "anthropic",
  provider_display_name: "Anthropic",
  provider_status: "active",
  provider_execution_mode: "api",
  provider_purpose: "assistant",
  provider_model_id: "claude-sonnet-5",
  display_name: "Sonnet"
} as unknown as AiConfiguredModelSafeRow;

const fakeProvider = {
  id: "provider-1",
  owner_user_id: "user-1",
  provider_kind: "anthropic",
  display_name: "Anthropic",
  base_url: null,
  status: "active",
  auth_method: "cli",
  encrypted_credential: {}
} as unknown as AiProviderWithSealedCredential;

const scopedDb = {} as DataContextDb;

function buildDeps(capture: { input?: GenerateStructuredProviderInput }): GenerateStructuredDeps {
  return {
    repository: {
      resolveModelForService: async () => ({ model: fakeModel, reason: "matched-active-model" }),
      selectProviderWithCredential: async () => fakeProvider
    },
    cipher: {
      decryptJson: () => {
        throw new Error("cli auth_method must never decrypt a credential");
      }
    },
    createCliStructuredAdapter: () => ({
      generateStructured: async (input) => {
        capture.input = input;
        return { rawObject: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    })
  };
}

function buildAbortAfterAdapterDeps(
  result: StructuredProviderResult,
  calls: { count: number },
  abortController: AbortController
): GenerateStructuredDeps {
  return {
    ...buildDeps({}),
    createCliStructuredAdapter: () => ({
      generateStructured: async () => {
        calls.count += 1;
        abortController.abort();
        return result;
      }
    })
  };
}

describe("generateStructured", () => {
  it.each(["economy", "interactive"] as const)(
    "rejects selected %s routing for required reasoning before credential access",
    async (tier) => {
      const deps = buildDeps({});
      const selectProviderWithCredential = vi.fn(deps.repository.selectProviderWithCredential);
      const resolveModelForService = vi.fn(async () => ({
        model: { ...fakeModel, tier },
        reason: "manual-route" as const
      }));
      const result = await generateStructured(
        scopedDb,
        {
          service: "module.workshop.plan",
          schema: { type: "object" },
          prompt: "plan",
          tierHint: "reasoning",
          requiredTier: "reasoning"
        },
        { ...deps, repository: { resolveModelForService, selectProviderWithCredential } }
      );
      expect(result).toEqual({ ok: false, error: "needs_config" });
      expect(resolveModelForService).toHaveBeenCalledOnce();
      expect(selectProviderWithCredential).not.toHaveBeenCalled();
    }
  );

  it("forwards the calling service to the provider adapter", async () => {
    const capture: { input?: GenerateStructuredProviderInput } = {};
    const result = await generateStructured(
      scopedDb,
      {
        service: "module.job-fit",
        schema: { type: "object", properties: {} },
        prompt: "score this"
      },
      buildDeps(capture)
    );

    expect(result.ok).toBe(true);
    expect(capture.input?.service).toBe("module.job-fit");
    expect(capture.input).not.toHaveProperty("sourceGeneration");
  });

  it("forwards source-generation intent only when requested", async () => {
    const capture: { input?: GenerateStructuredProviderInput } = {};
    const result = await generateStructured(
      scopedDb,
      {
        service: "module.job-fit",
        schema: { type: "object", properties: {} },
        prompt: "find the source",
        sourceGeneration: true
      },
      buildDeps(capture)
    );

    expect(result.ok).toBe(true);
    expect(capture.input?.sourceGeneration).toBe(true);
    expect(capture.input?.sourceCredentialScope).toEqual({
      actorUserId: "user-1",
      providerConfigId: "provider-1"
    });
  });

  it.each(["cli", "api_key"])(
    "rejects invalid source routes before %s credential/adapter access",
    async (auth_method) => {
      for (const [modelChange, providerChange] of [
        [{ provider_model_id: "default" }, {}],
        [{ provider_model_id: " default " }, {}],
        [{ provider_model_id: "" }, {}],
        [{ provider_model_id: "  " }, {}],
        [{}, { id: "another-provider" }],
        [{}, { owner_user_id: "another-actor" }],
        [{}, { provider_kind: "google" }]
      ] as const) {
        const capture: { input?: GenerateStructuredProviderInput } = {};
        const deps = buildDeps(capture);
        deps.repository.resolveModelForService = async () => ({
          model: { ...fakeModel, ...modelChange },
          reason: "matched-active-model"
        });
        deps.repository.selectProviderWithCredential = async () =>
          ({ ...fakeProvider, auth_method, ...providerChange }) as AiProviderWithSealedCredential;
        const decryptJson = vi.fn(() => ({ apiKey: "synthetic-key" }));
        const adapter = {
          generateStructured: vi.fn(async () => ({
            rawObject: {},
            usage: { inputTokens: 0, outputTokens: 0 }
          }))
        };
        const createAdapter = vi.fn(() => adapter);
        const result = await generateStructured(
          scopedDb,
          {
            service: "module.workshop",
            schema: { type: "object" },
            prompt: "source data",
            sourceGeneration: true
          },
          {
            ...deps,
            cipher: { decryptJson },
            createAdapter,
            createCliStructuredAdapter: createAdapter
          }
        );
        expect(result).toEqual({ ok: false, error: "needs_config" });
        expect(decryptJson).not.toHaveBeenCalled();
        expect(createAdapter).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["cli", "api_key"])(
    "preserves each matching source route's concrete model through %s dispatch",
    async (auth_method) => {
      for (const actor of ["first", "second"]) {
        const actorDb = {} as DataContextDb;
        const capture: { input?: GenerateStructuredProviderInput } = {};
        const deps = buildDeps(capture);
        const model = {
          ...fakeModel,
          owner_user_id: actor,
          provider_config_id: `provider-${actor}`,
          provider_model_id: `model-${actor}`
        };
        deps.repository.resolveModelForService = async (db, _service, options) => {
          expect(db).toBe(actorDb);
          expect(options.tierHint).toBe("interactive");
          return { model, reason: "manual-route" };
        };
        deps.repository.selectProviderWithCredential = async (db, providerId, options) => {
          expect(options).toEqual({ ownerOnly: true });
          expect(db).toBe(actorDb);
          expect(providerId).toBe(model.provider_config_id);
          return {
            ...fakeProvider,
            id: providerId,
            owner_user_id: actor,
            auth_method
          } as AiProviderWithSealedCredential;
        };
        const result = await generateStructured(
          actorDb,
          {
            service: "module.workshop",
            schema: { type: "object" },
            prompt: "source data",
            sourceGeneration: true,
            tierHint: "interactive"
          },
          {
            ...deps,
            cipher: { decryptJson: () => ({ apiKey: `synthetic-${actor}` }) },
            createAdapter: (_kind, key) => {
              expect(key).toBe(`synthetic-${actor}`);
              return deps.createCliStructuredAdapter!("anthropic");
            }
          }
        );
        expect(result.ok).toBe(true);
        expect(capture.input?.model.provider_model_id).toBe(model.provider_model_id);
        expect(capture.input?.sourceGeneration).toBe(true);
      }
    }
  );

  it("retains the default selector for ordinary structured CLI calls", async () => {
    const capture: { input?: GenerateStructuredProviderInput } = {};
    const deps = buildDeps(capture);
    deps.repository.resolveModelForService = async () => ({
      model: { ...fakeModel, provider_model_id: "default" },
      reason: "matched-active-model"
    });
    expect(
      (
        await generateStructured(
          scopedDb,
          {
            service: "module.job-fit",
            schema: { type: "object" },
            prompt: "ordinary data"
          },
          deps
        )
      ).ok
    ).toBe(true);
    expect(capture.input?.model.provider_model_id).toBe("default");
  });

  it.each([
    ["raw object", { rawObject: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } }],
    ["raw text", { rawText: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 } }],
    ["invalid raw text", { rawText: "not json", usage: { inputTokens: 1, outputTokens: 1 } }]
  ] as const)(
    "returns aborted when the adapter resolves %s after cancellation",
    async (_label, generated) => {
      const calls = { count: 0 };
      const abortController = new AbortController();
      const result = await generateStructured(
        scopedDb,
        {
          service: "module.job-fit",
          schema: {
            type: "object",
            properties: { ok: { const: true } },
            required: ["ok"]
          },
          prompt: "score this",
          signal: abortController.signal
        },
        buildAbortAfterAdapterDeps(generated, calls, abortController)
      );

      expect(result).toEqual({ ok: false, error: "aborted" });
      expect(calls.count).toBe(1);
    }
  );
});
