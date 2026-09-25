import { describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";
import {
  generateText,
  type AiProviderWithSealedCredential,
  type GenerateChatInput,
  type GenerateStructuredProviderInput,
  type GenerateTextDeps,
  type GenerateTextModel
} from "@moss/ai";

const model: GenerateTextModel = {
  id: "model-1",
  provider_config_id: "provider-1",
  provider_kind: "anthropic",
  provider_model_id: "claude-sonnet-5"
};

const scopedDb = {} as DataContextDb;
const messages = [{ role: "user" as const, content: "Summarise my day." }];

function provider(overrides: Partial<AiProviderWithSealedCredential>) {
  return {
    id: "provider-1",
    provider_kind: "anthropic",
    base_url: null,
    status: "active",
    auth_method: "api_key",
    encrypted_credential: { sealed: true },
    ...overrides
  } as unknown as AiProviderWithSealedCredential;
}

type Capture = {
  structured?: GenerateStructuredProviderInput;
  chat?: GenerateChatInput;
  adapterArgs?: unknown[];
};

function deps(
  sealed: AiProviderWithSealedCredential | undefined,
  capture: Capture,
  overrides: Partial<GenerateTextDeps> = {}
): GenerateTextDeps {
  return {
    repository: { selectProviderWithCredential: async () => sealed },
    cipher: {
      decryptJson: () => {
        if (sealed?.auth_method === "cli") throw new Error("cli login must never be decrypted");
        return { apiKey: "test-key" };
      }
    },
    createAdapter: (...args) => {
      capture.adapterArgs = args;
      return {
        generateChat: async (input) => {
          capture.chat = input;
          return { text: "api reply" };
        }
      };
    },
    createCliStructuredAdapter: () => ({
      generateStructured: async (input) => {
        capture.structured = input;
        return {
          rawText: '```json\n{"text":"cli reply"}\n```',
          usage: { inputTokens: 0, outputTokens: 0 }
        };
      }
    }),
    ...overrides
  };
}

describe("generateText", () => {
  it("runs a subscription-login provider through the CLI transport without decrypting", async () => {
    const capture: Capture = {};
    const result = await generateText(
      scopedDb,
      {
        service: "module.briefings",
        model,
        messages,
        maxOutputTokens: 512,
        priority: "background"
      },
      deps(provider({ auth_method: "cli" }), capture)
    );

    expect(result).toEqual({ ok: true, text: "cli reply" });
    expect(capture.chat).toBeUndefined();
    expect(capture.structured).toMatchObject({
      service: "module.briefings",
      model: { provider_kind: "anthropic", provider_model_id: "claude-sonnet-5" },
      messages,
      maxOutputTokens: 512,
      priority: "background"
    });
  });

  it("accepts an already-parsed object from the CLI transport", async () => {
    const result = await generateText(
      scopedDb,
      { model, messages, maxOutputTokens: 512 },
      deps(
        provider({ auth_method: "cli" }),
        {},
        {
          createCliStructuredAdapter: () => ({
            generateStructured: async () => ({
              rawObject: { text: "parsed reply" },
              usage: { inputTokens: 0, outputTokens: 0 }
            })
          })
        }
      )
    );
    expect(result).toEqual({ ok: true, text: "parsed reply" });
  });

  it("runs an API-key provider through the HTTP adapter", async () => {
    const capture: Capture = {};
    const result = await generateText(
      scopedDb,
      { model, messages, maxOutputTokens: 512 },
      deps(provider({ base_url: "https://example.test" }), capture)
    );

    expect(result).toEqual({ ok: true, text: "api reply" });
    expect(capture.adapterArgs).toEqual(["anthropic", "test-key", "https://example.test"]);
    expect(capture.chat).toMatchObject({ messages, maxOutputTokens: 512 });
    expect(capture.structured).toBeUndefined();
  });

  it("reports needs_config when the login provider has no CLI transport", async () => {
    const result = await generateText(
      scopedDb,
      { model, messages, maxOutputTokens: 512 },
      deps(provider({ auth_method: "cli" }), {}, { createCliStructuredAdapter: undefined })
    );
    expect(result).toEqual({ ok: false, error: "needs_config" });
  });

  it("reports needs_config for a missing provider or unreadable API key", async () => {
    expect(
      await generateText(scopedDb, { model, messages, maxOutputTokens: 512 }, deps(undefined, {}))
    ).toEqual({ ok: false, error: "needs_config" });

    const unreadable = deps(
      provider({}),
      {},
      {
        cipher: { decryptJson: () => ({ token: "not-an-api-key" }) }
      }
    );
    expect(
      await generateText(scopedDb, { model, messages, maxOutputTokens: 512 }, unreadable)
    ).toEqual({ ok: false, error: "needs_config" });
  });

  it("reports provider_error when the CLI reply carries no text", async () => {
    const result = await generateText(
      scopedDb,
      { model, messages, maxOutputTokens: 512 },
      deps(
        provider({ auth_method: "cli" }),
        {},
        {
          createCliStructuredAdapter: () => ({
            generateStructured: async () => ({
              rawText: "not json",
              usage: { inputTokens: 0, outputTokens: 0 }
            })
          })
        }
      )
    );
    expect(result).toEqual({ ok: false, error: "provider_error" });
  });

  it("reports provider_error for an unsupported provider kind", async () => {
    const result = await generateText(
      scopedDb,
      { model: { ...model, provider_kind: "mystery" }, messages, maxOutputTokens: 512 },
      deps(provider({}), {})
    );
    expect(result).toEqual({ ok: false, error: "provider_error" });
  });

  it("stops a run the caller aborts", async () => {
    const controller = new AbortController();
    const result = await generateText(
      scopedDb,
      { model, messages, maxOutputTokens: 512, signal: controller.signal },
      deps(
        provider({ auth_method: "cli" }),
        {},
        {
          createCliStructuredAdapter: () => ({
            generateStructured: () => {
              controller.abort();
              return new Promise(() => undefined);
            }
          })
        }
      )
    );
    expect(result).toEqual({ ok: false, error: "aborted" });
  });
});
