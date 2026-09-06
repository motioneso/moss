import { describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";
import type { AiConfiguredModelSafeRow, AiProviderWithSealedCredential } from "../repository.js";
import type { GenerateStructuredProviderInput } from "../adapters/http-api-structured.js";
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

describe("generateStructured", () => {
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
  });

  it("keeps the sources a CLI adapter reports alongside raw text (#2228)", async () => {
    const deps: GenerateStructuredDeps = {
      ...buildDeps({}),
      createCliStructuredAdapter: () => ({
        generateStructured: async () => ({
          rawText: '{"ok":true}',
          usage: { inputTokens: 1, outputTokens: 1 },
          sources: [{ title: "A", url: "https://example.com/a" }]
        })
      })
    };
    const result = await generateStructured(
      scopedDb,
      {
        service: "module.web-research",
        schema: { type: "object", properties: {} },
        prompt: "search this",
        nativeSearch: true
      },
      deps
    );

    expect(result).toMatchObject({
      ok: true,
      object: { ok: true },
      sources: [{ title: "A", url: "https://example.com/a" }]
    });
  });

  it("returns no sources key when a CLI adapter reports raw text without any (#2228)", async () => {
    const deps: GenerateStructuredDeps = {
      ...buildDeps({}),
      createCliStructuredAdapter: () => ({
        generateStructured: async () => ({
          rawText: '{"ok":true}',
          usage: { inputTokens: 1, outputTokens: 1 }
        })
      })
    };
    const result = await generateStructured(
      scopedDb,
      { service: "module.web-research", schema: { type: "object", properties: {} }, prompt: "x" },
      deps
    );

    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("sources");
  });
});
